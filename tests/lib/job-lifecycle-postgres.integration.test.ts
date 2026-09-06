import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const integration = describe.runIf(process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true');
const applicationName = `job-lifecycle-${randomUUID()}`;
let db: PrismaClient;
let service: typeof import('@/lib/services/analysisJobs');
let fixture: Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
    const user = await db.user.create({ data: {} });
    const game = await db.analyzedGame.create({
        data: {
            userId: user.id,
            provider: 'LICHESS',
            externalId: randomUUID(),
            pgn: '1. e4 e5 *',
            plyCount: 2,
            sourcePgnHash: 'job-lifecycle-source',
            sourceUsername: 'fixture',
            userSide: 'WHITE',
            playedAt: new Date(),
            timeClass: 'RAPID',
            whiteName: 'fixture',
            blackName: 'opponent',
            analysis: {},
        },
    });
    const run = await db.analysisRun.create({
        data: {
            userId: user.id,
            gameId: game.id,
            executionMode: 'SERVER_QUEUE',
            analysisQuality: 'THOROUGH',
            creditCost: 10,
            inputPgnHash: game.sourcePgnHash,
            configHash: 'job-lifecycle-config',
        },
    });
    const lockedAt = new Date();
    const job = await db.analysisJob.create({
        data: {
            userId: user.id,
            gameId: game.id,
            analysisRunId: run.id,
            status: 'RUNNING',
            attempts: 5,
            lockedAt,
            lockedUntil: new Date(Date.now() + 60_000),
            dispatchedCount: 1,
        },
    });
    return { user, game, run, job, fence: { lockedAt, dispatchedCount: 1 } };
}

async function waitForBlockedTransition() {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const blocked = await db.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE application_name = ${applicationName}
              AND wait_event_type = 'Lock'
        `;
        if (blocked.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The concurrent transition did not wait for a PostgreSQL lock');
}

integration('analysis job lifecycle on PostgreSQL', () => {
    beforeAll(async () => {
        const url = new URL(process.env.DATABASE_URL!);
        url.searchParams.set('application_name', applicationName);
        url.searchParams.set('connection_limit', '5');
        db = new PrismaClient({ datasourceUrl: url.toString() });
        vi.doMock('@/lib/prisma', () => ({ prisma: db }));
        service = await import('@/lib/services/analysisJobs');
    });

    beforeEach(async () => {
        fixture = await createFixture();
    });

    afterEach(async () => {
        if (fixture) await db.user.deleteMany({ where: { id: fixture.user.id } });
    });

    afterAll(async () => {
        await db?.$disconnect();
        vi.doUnmock('@/lib/prisma');
    });

    it('waits for concurrent completion and rejects the superseded worker without resurrecting the run', async () => {
        let releaseCompletion!: () => void;
        let completionLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseCompletion = resolve; });
        const locked = new Promise<void>((resolve) => { completionLocked = resolve; });
        const completion = db.$transaction(async (tx) => {
            await tx.analysisJob.update({
                where: { id: fixture.job.id },
                data: { status: 'SUCCEEDED', lockedAt: null, lockedUntil: null },
            });
            await tx.analysisRun.update({
                where: { id: fixture.run.id },
                data: { status: 'SUCCEEDED', consumedCredits: 10, completedAt: new Date() },
            });
            completionLocked();
            await release;
        }, { timeout: 10_000 });
        await locked;
        const transition = service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: fixture.fence,
            status: 'RUNNING',
        });
        try {
            await waitForBlockedTransition();
        } finally {
            releaseCompletion();
        }
        await completion;
        expect(await transition).toBeNull();
        expect(await db.analysisRun.findUnique({ where: { id: fixture.run.id } })).toMatchObject({
            status: 'SUCCEEDED',
            consumedCredits: 10,
        });
    });

    it('rejects the old run identity after the durable job is reused', async () => {
        await db.analysisRun.update({
            where: { id: fixture.run.id },
            data: { status: 'SUCCEEDED' },
        });
        const replacement = await db.analysisRun.create({
            data: {
                userId: fixture.user.id,
                gameId: fixture.game.id,
                executionMode: 'SERVER_QUEUE',
                analysisQuality: 'THOROUGH',
                creditCost: 10,
                inputPgnHash: fixture.game.sourcePgnHash,
                configHash: fixture.run.configHash,
            },
        });
        await db.analysisJob.update({
            where: { id: fixture.job.id },
            data: { analysisRunId: replacement.id, dispatchedCount: 2 },
        });
        expect(await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: fixture.fence,
            status: 'RUNNING',
        })).toBeNull();
        expect(await db.analysisRun.findUnique({ where: { id: replacement.id } })).toMatchObject({
            status: 'QUEUED',
            consumedCredits: null,
        });
    });

    it('starts the current run and preserves immutable provenance', async () => {
        const run = await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: fixture.fence,
            status: 'RUNNING',
        });
        expect(run).toMatchObject({
            id: fixture.run.id,
            status: 'RUNNING',
            creditCost: 10,
            configHash: fixture.run.configHash,
        });
    });

    it('rejects a start after its lease expires even before another worker takes over', async () => {
        await db.analysisJob.update({
            where: { id: fixture.job.id },
            data: { lockedUntil: new Date(0) },
        });
        expect(await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: fixture.fence,
            status: 'RUNNING',
        })).toBeNull();
        expect(await db.analysisRun.findUnique({ where: { id: fixture.run.id } })).toMatchObject({
            status: 'QUEUED',
        });
    });

    it('does not restart a terminal run even while the job fence still matches', async () => {
        await db.analysisRun.update({
            where: { id: fixture.run.id },
            data: { status: 'SUCCEEDED', consumedCredits: 10 },
        });
        expect(await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: fixture.fence,
            status: 'RUNNING',
        })).toBeNull();
        expect(await db.analysisRun.findUnique({ where: { id: fixture.run.id } })).toMatchObject({
            status: 'SUCCEEDED',
            consumedCredits: 10,
        });
    });

    it('starts the same run after a retryable failure is dispatched again', async () => {
        await db.analysisJob.update({
            where: { id: fixture.job.id },
            data: { attempts: 1 },
        });
        await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: fixture.fence,
            status: 'RUNNING',
        });
        expect(await service.markAnalysisJobFailed(
            fixture.job.id,
            fixture.fence,
            new Error('Temporary engine failure')
        )).toMatchObject({ status: 'QUEUED' });
        expect(await db.analysisRun.findUnique({ where: { id: fixture.run.id } })).toMatchObject({
            status: 'QUEUED',
        });
        const nextFence = { lockedAt: new Date(), dispatchedCount: 2 };
        await db.analysisJob.update({
            where: { id: fixture.job.id },
            data: {
                ...nextFence,
                lockedUntil: new Date(Date.now() + 60_000),
                scheduledFor: new Date(0),
            },
        });
        await service.markAnalysisJobRunning(
            fixture.job.id,
            `analysis-delivery-v1:${fixture.job.id}:2:${nextFence.lockedAt.getTime()}`
        );
        expect(await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: nextFence,
            status: 'RUNNING',
        })).toMatchObject({ status: 'RUNNING' });
    });

    it('resumes the same queued run across repeated checkpoint continuations', async () => {
        let currentFence = fixture.fence;
        for (let version = 0; version < 2; version += 1) {
            expect(await service.transitionAnalysisRunForJob({
                jobId: fixture.job.id,
                analysisRunId: fixture.run.id,
                fence: currentFence,
                status: 'RUNNING',
            })).toMatchObject({ status: 'RUNNING' });
            const yielded = await service.yieldAnalysisJobWithCheckpoint({
                jobId: fixture.job.id,
                analysisRunId: fixture.run.id,
                fence: currentFence,
                expectedVersion: version,
                checkpoint: {
                    version: 1,
                    gameId: fixture.game.id,
                    sourceGameId: fixture.game.id,
                    sourcePgnHash: fixture.game.sourcePgnHash,
                    configHash: fixture.run.configHash,
                    nextPly: version + 1,
                    expectedPlies: 2,
                    moments: [],
                    gameAnalysis: [],
                    whiteMoveAccuracies: [],
                    blackMoveAccuracies: [],
                    extractionErrors: [],
                    decisionReceipts: [],
                    scanEvidence: [],
                },
            });
            expect(yielded).toMatchObject({ status: 'QUEUED', attempts: 4 });
            expect(await db.analysisRun.findUnique({ where: { id: fixture.run.id } })).toMatchObject({
                status: 'QUEUED',
            });
            currentFence = {
                lockedAt: new Date(),
                dispatchedCount: currentFence.dispatchedCount + 1,
            };
            await db.analysisJob.update({
                where: { id: fixture.job.id },
                data: {
                    ...currentFence,
                    lockedUntil: new Date(Date.now() + 60_000),
                },
            });
            expect(await service.markAnalysisJobRunning(
                fixture.job.id,
                `analysis-delivery-v1:${fixture.job.id}:${currentFence.dispatchedCount}:${currentFence.lockedAt.getTime()}`
            )).toMatchObject({ status: 'RUNNING', attempts: 5 });
        }
        expect(await service.transitionAnalysisRunForJob({
            jobId: fixture.job.id,
            analysisRunId: fixture.run.id,
            fence: currentFence,
            status: 'RUNNING',
        })).toMatchObject({ status: 'RUNNING' });
    });

    it('finishes both job and queued run after the final pre-start failure', async () => {
        await service.markAnalysisJobFailed(
            fixture.job.id,
            fixture.fence,
            new Error('Invalid configuration provenance')
        );
        expect(await db.analysisJob.findUnique({ where: { id: fixture.job.id } })).toMatchObject({
            status: 'FAILED',
            lockedAt: null,
            lockedUntil: null,
        });
        expect(await db.analysisRun.findUnique({ where: { id: fixture.run.id } })).toMatchObject({
            status: 'FAILED',
            lastError: 'Invalid configuration provenance',
        });
    });
});
