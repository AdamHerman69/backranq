import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

type AnalysisJobsModule = typeof import('@/lib/services/analysisJobs');

async function importJobs(): Promise<AnalysisJobsModule> {
    vi.resetModules();
    mockPrismaModule();
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/analysisJobs');
}

function billingAccount(overrides: Record<string, unknown> = {}) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE',
        serverCreditsBalance: 99,
        monthlyServerCreditsUsed: 0,
        serverCreditsRenewAt: new Date('2026-08-05T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyCap: 50,
        autoAnalysisDailyCap: 10,
        stopWhenCreditsBelow: 0,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        updatedAt: new Date('2026-07-05T00:00:00Z'),
        ...overrides,
    };
}

function primeCreditReservationMocks() {
    prismaMock.analyzedGame.findFirst.mockResolvedValue({
        pgn: '[Event "Source"]\n\n1. e4 *',
    });
    prismaMock.analysisRun.create.mockResolvedValue({
        id: 'run-1',
        userId: 'user-1',
        gameId: 'game-1',
        status: 'QUEUED',
        executionMode: 'SERVER_QUEUE',
        queuedReason: 'manual',
        configHash: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        consumedCredits: 0,
        lastError: null,
    });
    prismaMock.billingAccount.upsert.mockResolvedValue(billingAccount());
    prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
    prismaMock.creditLedgerEntry.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ type: 'RESERVED', credits: 1 }]);
    prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.billingAccount.findUniqueOrThrow.mockResolvedValue(
        billingAccount({ serverCreditsBalance: 98 })
    );
    prismaMock.creditLedgerEntry.create.mockResolvedValue({
        id: 'entry-1',
        userId: 'user-1',
        type: 'RESERVED',
        credits: 1,
        idempotencyKey: 'analysis-run:run-1:reserve',
    });
}

describe('analysis job enqueue service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        primeCreditReservationMocks();
    });

    it('does not requeue a succeeded job unless forced', async () => {
        const service = await importJobs();
        const existing = {
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'SUCCEEDED',
            priority: 0,
            attempts: 1,
            lockedAt: null,
            startedAt: new Date(),
            completedAt: new Date(),
            lastError: null,
            queuedReason: 'auto-sync',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        prismaMock.analysisJob.findUnique.mockResolvedValue(existing);

        const result = await service.enqueueAnalysisJob({
            userId: 'user-1',
            gameId: 'game-1',
        });

        expect(result).toEqual({ job: existing, created: false, queued: false });
        expect(prismaMock.analysisJob.update).not.toHaveBeenCalled();
        expect(prismaMock.analysisJob.create).not.toHaveBeenCalled();
    });

    it('requeues a failed job with clean running state', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'FAILED',
            priority: 0,
            queuedReason: 'auto-sync',
        });
        prismaMock.analysisJob.update.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
            priority: 0,
            estimatedCredits: 1,
            weight: 0,
            queuedReason: 'manual',
            createdAt: new Date(),
            startedAt: null,
        });

        const result = await service.enqueueAnalysisJob({
            userId: 'user-1',
            gameId: 'game-1',
            queuedReason: 'manual',
        });

        expect(result.queued).toBe(true);
        expect(prismaMock.analysisJob.update).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            data: expect.objectContaining({
                status: 'QUEUED',
                lockedAt: null,
                attempts: 0,
                startedAt: null,
                completedAt: null,
                lastError: null,
                queuedReason: 'manual',
            }),
        });
    });
});

describe('analysis job state transitions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('starts only a queued job with an active dispatch lease', async () => {
        const service = await importJobs();
        const lockedAt = new Date('2026-07-05T12:00:00Z');
        const dispatchToken = `analysis-delivery-v1:job-1:1:${lockedAt.getTime()}`;
        const running = {
            id: 'job-1',
            status: 'RUNNING',
            lockedAt,
            lockedUntil: null,
            dispatchedCount: 1,
        };
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisJob.findUnique.mockResolvedValue(running);

        const result = await service.markAnalysisJobRunning(
            'job-1',
            dispatchToken
        );

        expect(result).toBe(running);
        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'job-1',
                status: 'QUEUED',
                analysisRun: { is: {} },
                lockedAt,
                dispatchedCount: 1,
                lockedUntil: { gt: expect.any(Date) },
                OR: [
                    { scheduledFor: null },
                    { scheduledFor: { lte: expect.any(Date) } },
                ],
            },
            data: expect.objectContaining({
                status: 'RUNNING',
                attempts: { increment: 1 },
                lastError: null,
            }),
        });
    });

    it('refuses stale or unclaimed analysis jobs', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 0 });
        const lockedAt = new Date('2026-07-05T12:00:00Z');

        const result = await service.markAnalysisJobRunning(
            'job-1',
            `analysis-delivery-v1:job-1:1:${lockedAt.getTime()}`
        );

        expect(result).toBeNull();
        expect(prismaMock.analysisJob.findUnique).not.toHaveBeenCalled();
    });

    it('fails closed when a claimable legacy delivery has no analysis run', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
        const lockedAt = new Date('2026-07-05T12:00:00Z');

        await expect(
            service.markAnalysisJobRunning(
                'job-1',
                `analysis-delivery-v1:job-1:1:${lockedAt.getTime()}`
            )
        ).rejects.toThrow(/missing immutable enqueue-time run provenance/i);

        expect(prismaMock.analysisJob.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a malformed delivery token before touching the job', async () => {
        const service = await importJobs();

        await expect(
            service.markAnalysisJobRunning('job-1', 'not-a-token')
        ).rejects.toThrow(/stale or no longer claimable/i);

        expect(prismaMock.analysisJob.updateMany).not.toHaveBeenCalled();
    });

    it('uses an active running lease as the durable stale-delivery wakeup', async () => {
        const service = await importJobs();
        const lockedUntil = new Date('2026-07-05T12:10:00Z');
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            status: 'RUNNING',
            scheduledFor: null,
            lockedUntil,
        });

        await expect(
            service.getAnalysisJobWakeupAt('job-1')
        ).resolves.toEqual(lockedUntil);
        expect(prismaMock.analysisJob.findUnique).toHaveBeenCalledWith({
            where: { id: 'job-1' },
            select: {
                status: true,
                scheduledFor: true,
                lockedUntil: true,
            },
        });
    });

    it('requires the same delivery generation when completing a job', async () => {
        const service = await importJobs();
        const lockedAt = new Date('2026-07-05T12:00:00Z');
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 0 });

        const result = await service.markAnalysisJobSucceeded('job-1', {
            lockedAt,
            dispatchedCount: 1,
        });

        expect(result).toBeNull();
        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'job-1',
                status: 'RUNNING',
                lockedAt,
                dispatchedCount: 1,
            },
            data: expect.objectContaining({
                status: 'SUCCEEDED',
                lockedAt: null,
                lockedUntil: null,
            }),
        });
    });
});

describe('analysis run snapshot integrity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a snapshot whose stored hash does not match its contents', async () => {
        const service = await importJobs();
        const snapshot = {
            analysisDefaults: {
                ...service.serverAnalysisConfigFromPreferences({}).config
                    .snapshot,
            },
        };

        expect(
            service.serverAnalysisConfigFromSnapshot({
                snapshot,
                hash: 'tampered-hash',
            })
        ).toBeNull();
    });
});
