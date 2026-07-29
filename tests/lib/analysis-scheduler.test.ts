import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

const publishMock = vi.fn();
const releaseCreditsMock = vi.fn();
const releaseCreditsInTransactionMock = vi.fn();

type SchedulerModule = typeof import('@/lib/services/analysisScheduler');
type AnalysisDispatchCandidate =
    import('@/lib/services/analysisScheduler').AnalysisDispatchCandidate;

async function importScheduler(): Promise<SchedulerModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    vi.doMock('@/lib/services/billingAccounts', () => ({
        releaseServerAnalysisCredits: releaseCreditsMock,
        releaseServerAnalysisCreditsInTransaction:
            releaseCreditsInTransactionMock,
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/analysisScheduler');
}

function job(
    id: string,
    overrides: Partial<AnalysisDispatchCandidate> = {}
): AnalysisDispatchCandidate {
    const match = id.match(/^u(\d+)/);
    const userId = overrides.userId ?? (match ? `user-${match[1]}` : 'user-1');
    const createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');

    return {
        id,
        userId,
        gameId: `game-${id}`,
        status: 'QUEUED',
        priority: 0,
        attempts: 0,
        dispatchedCount: 0,
        lockedAt: null,
        lockedUntil: null,
        queuedReason: 'auto-sync',
        createdAt,
        updatedAt: createdAt,
        ...overrides,
    };
}

describe('analysis scheduler planner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('orders each user queue by manual work, age, then priority', async () => {
        const { planAnalysisDispatch } = await importScheduler();

        const plan = planAnalysisDispatch({
            jobs: [
                job('auto-high', {
                    userId: 'user-1',
                    priority: 100,
                    queuedReason: 'auto-sync',
                    createdAt: new Date('2026-01-01T00:00:00Z'),
                    updatedAt: new Date('2026-01-01T00:00:00Z'),
                }),
                job('manual-low', {
                    userId: 'user-1',
                    priority: 1,
                    queuedReason: 'manual',
                    createdAt: new Date('2026-01-02T00:00:00Z'),
                    updatedAt: new Date('2026-01-02T00:00:00Z'),
                }),
                job('manual-high-newer', {
                    userId: 'user-1',
                    priority: 5,
                    queuedReason: 'manual',
                    createdAt: new Date('2026-01-03T00:00:00Z'),
                    updatedAt: new Date('2026-01-03T00:00:00Z'),
                }),
            ],
            options: { globalLimit: 3, perUserLimit: 3 },
        });

        expect(plan.selectedJobIds).toEqual([
            'manual-low',
            'manual-high-newer',
            'auto-high',
        ]);
    });

    it('respects running and already-dispatched per-user capacity', async () => {
        const { planAnalysisDispatch } = await importScheduler();

        const plan = planAnalysisDispatch({
            jobs: [
                job('u1-a', { userId: 'user-1' }),
                job('u2-a', { userId: 'user-2' }),
                job('u3-a', { userId: 'user-3' }),
            ],
            options: {
                globalLimit: 10,
                perUserLimit: 1,
                runningByUser: { 'user-1': 1 },
                dispatchedByUser: { 'user-2': 1 },
            },
        });

        expect(plan.selectedJobIds).toEqual(['u3-a']);
        expect(plan.skipped.perUserLimit).toBe(2);
    });

    it('skips future scheduled jobs and retry jobs still in backoff', async () => {
        const { planAnalysisDispatch } = await importScheduler();
        const now = new Date('2026-01-01T00:10:00Z');

        const plan = planAnalysisDispatch({
            jobs: [
                job('future', {
                    userId: 'user-1',
                    scheduledFor: new Date('2026-01-01T00:11:00Z'),
                }),
                job('backoff', {
                    userId: 'user-2',
                    attempts: 2,
                    updatedAt: new Date('2026-01-01T00:09:30Z'),
                }),
                job('ready', {
                    userId: 'user-3',
                    attempts: 2,
                    updatedAt: new Date('2026-01-01T00:08:00Z'),
                }),
            ],
            options: {
                now,
                globalLimit: 10,
                perUserLimit: 1,
                retryBackoffBaseMs: 60_000,
                retryBackoffMaxMs: 60_000,
            },
        });

        expect(plan.selectedJobIds).toEqual(['ready']);
        expect(plan.skipped.scheduledForLater).toBe(1);
        expect(plan.skipped.retryBackoff).toBe(1);
    });

    it('keeps one user with many jobs from starving 1000 other users', async () => {
        const { planAnalysisDispatch } = await importScheduler();
        const jobs: AnalysisDispatchCandidate[] = [];

        for (let index = 0; index < 2_000; index += 1) {
            jobs.push(
                job(`whale-${index}`, {
                    userId: 'whale',
                    priority: 100,
                    queuedReason: 'manual',
                    createdAt: new Date(1_700_000_000_000 + index),
                    updatedAt: new Date(1_700_000_000_000 + index),
                })
            );
        }

        for (let index = 0; index < 1_000; index += 1) {
            jobs.push(
                job(`small-${index}`, {
                    userId: `small-${index}`,
                    priority: 0,
                    queuedReason: 'auto-sync',
                    createdAt: new Date(1_700_100_000_000 + index),
                    updatedAt: new Date(1_700_100_000_000 + index),
                })
            );
        }

        const plan = planAnalysisDispatch({
            jobs,
            options: { globalLimit: 1_000, perUserLimit: 1 },
        });

        expect(plan.selectedJobs).toHaveLength(1_000);
        expect(plan.selectedByUser.whale).toBe(1);
        expect(
            new Set(plan.selectedJobs.map((selected) => selected.userId)).size
        ).toBe(1_000);
        expect(
            plan.selectedJobs.filter((selected) =>
                selected.userId.startsWith('small-')
            )
        ).toHaveLength(999);
    });
});

describe('analysis scheduler dispatch', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fails an exhausted lease, fails its run, and releases the reservation', async () => {
        const { recoverExpiredAnalysisJobs } = await importScheduler();
        const lockedAt = new Date('2026-01-01T00:00:00Z');
        const now = new Date('2026-01-01T00:20:00Z');
        prismaMock.analysisJob.findMany.mockResolvedValue([
            {
                id: 'job-1',
                userId: 'user-1',
                gameId: 'game-1',
                analysisRunId: 'run-1',
                estimatedCredits: 1,
                attempts: 5,
                dispatchedCount: 2,
                lockedAt,
            },
        ]);
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
        releaseCreditsMock.mockResolvedValue({ created: true });

        const result = await recoverExpiredAnalysisJobs({
            now,
            maxAttempts: 5,
        });

        expect(result).toEqual({
            requeued: 0,
            failed: 1,
            releasedReservations: 1,
            settlementErrors: [],
        });
        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                id: 'job-1',
                status: 'RUNNING',
                lockedAt,
                dispatchedCount: 2,
            }),
            data: expect.objectContaining({ status: 'FAILED' }),
        });
        expect(prismaMock.analysisRun.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'run-1',
                status: { in: ['QUEUED', 'RUNNING'] },
            },
            data: expect.objectContaining({ status: 'FAILED' }),
        });
        expect(releaseCreditsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                analysisJobId: 'job-1',
                analysisRunId: 'run-1',
                idempotencyKey: 'analysis-run:run-1:release',
            })
        );
    });

    it('persists a run-scoped settlement marker when exhausted-lease release fails', async () => {
        const { recoverExpiredAnalysisJobs } = await importScheduler();
        const lockedAt = new Date('2026-01-01T00:00:00Z');
        const now = new Date('2026-01-01T00:20:00Z');
        prismaMock.analysisJob.findMany.mockResolvedValue([
            {
                id: 'recycled-job',
                userId: 'user-1',
                gameId: 'game-1',
                analysisRunId: 'run-2',
                estimatedCredits: 1,
                attempts: 5,
                dispatchedCount: 2,
                lockedAt,
            },
        ]);
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
        releaseCreditsMock.mockRejectedValue(
            new Error('temporary ledger failure')
        );

        const result = await recoverExpiredAnalysisJobs({
            now,
            maxAttempts: 5,
        });

        expect(result).toEqual({
            requeued: 0,
            failed: 1,
            releasedReservations: 0,
            settlementErrors: [
                {
                    jobId: 'recycled-job',
                    error: 'temporary ledger failure',
                },
            ],
        });
        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'recycled-job',
                analysisRunId: 'run-2',
                status: 'FAILED',
            },
            data: {
                lastError:
                    'CREDIT_SETTLEMENT_PENDING:release:temporary ledger failure',
            },
        });
        expect(prismaMock.analysisRun.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'run-2',
                status: 'FAILED',
            },
            data: {
                lastError:
                    'CREDIT_SETTLEMENT_PENDING:release:temporary ledger failure',
            },
        });
    });

    it('atomically cancels queue-disabled jobs and releases their run reservation', async () => {
        const { cancelUnexecutableAnalysisJobs } =
            await importScheduler();
        prismaMock.analysisJob.findFirst.mockResolvedValue({
            id: 'job-1',
            gameId: 'game-1',
            analysisRunId: 'run-1',
            estimatedCredits: 1,
        });
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
        releaseCreditsInTransactionMock.mockResolvedValue({
            created: true,
        });

        const result = await cancelUnexecutableAnalysisJobs({
            userId: 'user-1',
            jobIds: ['job-1'],
            reason: 'Server analysis queue is disabled',
        });

        expect(result).toEqual({ cancelled: 1 });
        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'job-1',
                userId: 'user-1',
                status: 'QUEUED',
            },
            data: expect.objectContaining({
                status: 'CANCELLED',
                lastError: 'Server analysis queue is disabled',
            }),
        });
        expect(prismaMock.analysisRun.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'run-1',
                userId: 'user-1',
                status: 'QUEUED',
            },
            data: expect.objectContaining({
                status: 'CANCELLED',
                consumedCredits: 0,
            }),
        });
        expect(
            releaseCreditsInTransactionMock
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                analysisJobId: 'job-1',
                analysisRunId: 'run-1',
                idempotencyKey:
                    'analysis-run:run-1:queue-unavailable-release',
            })
        );
    });

    it('claims selected jobs and publishes compatible Vercel Queue messages', async () => {
        const { dispatchQueuedAnalysisJobs } = await importScheduler();
        const jobs = [
            job('u1-a', { userId: 'user-1', queuedReason: 'manual' }),
            job('u1-b', { userId: 'user-1', queuedReason: 'manual' }),
            job('u2-a', { userId: 'user-2', queuedReason: 'auto-sync' }),
        ];
        prismaMock.analysisJob.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ userId: 'user-1' }, { userId: 'user-2' }])
            .mockResolvedValueOnce(jobs);
        prismaMock.analysisJob.groupBy
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([]);
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        publishMock
            .mockResolvedValueOnce({ queued: true, messageId: 'msg-1' })
            .mockResolvedValueOnce({ queued: true, messageId: 'msg-2' });

        const result = await dispatchQueuedAnalysisJobs({
            globalLimit: 10,
            perUserLimit: 1,
            now: new Date('2026-01-01T00:00:00Z'),
        });

        expect(result.claimedJobIds).toEqual(['u1-a', 'u2-a']);
        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledTimes(2);
        expect(publishMock).toHaveBeenCalledWith(
            {
                type: 'analysis-job',
                jobId: 'u1-a',
                dispatchToken:
                    'analysis-delivery-v1:u1-a:1:1767225600000',
            },
            {
                idempotencyKey:
                    'analysis:game-u1-a:u1-a:delivery:1',
            }
        );
        expect(publishMock).toHaveBeenCalledWith(
            {
                type: 'analysis-job',
                jobId: 'u2-a',
                dispatchToken:
                    'analysis-delivery-v1:u2-a:1:1767225600000',
            },
            {
                idempotencyKey:
                    'analysis:game-u2-a:u2-a:delivery:1',
            }
        );
        expect(result.published).toEqual([
            {
                jobId: 'u1-a',
                queued: true,
                messageId: 'msg-1',
                dispatchToken:
                    'analysis-delivery-v1:u1-a:1:1767225600000',
                unavailableReason: undefined,
                error: undefined,
            },
            {
                jobId: 'u2-a',
                queued: true,
                messageId: 'msg-2',
                dispatchToken:
                    'analysis-delivery-v1:u2-a:1:1767225600000',
                unavailableReason: undefined,
                error: undefined,
            },
        ]);
    });

    it('uses a new deduplication key for every delivery generation', async () => {
        const { analysisDispatchIdempotencyKey } = await importScheduler();

        expect(
            analysisDispatchIdempotencyKey({
                id: 'job-1',
                gameId: 'game-1',
                dispatchedCount: 3,
            })
        ).toBe('analysis:game-1:job-1:delivery:3');
        expect(
            analysisDispatchIdempotencyKey({
                id: 'job-1',
                gameId: 'game-1',
                dispatchedCount: 4,
            })
        ).toBe('analysis:game-1:job-1:delivery:4');
    });
});
