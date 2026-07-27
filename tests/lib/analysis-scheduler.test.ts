import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

const publishMock = vi.fn();

type SchedulerModule = typeof import('@/lib/services/analysisScheduler');
type AnalysisDispatchCandidate =
    import('@/lib/services/analysisScheduler').AnalysisDispatchCandidate;

async function importScheduler(): Promise<SchedulerModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
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
            { type: 'analysis-job', jobId: 'u1-a' },
            { idempotencyKey: 'analysis:game-u1-a' }
        );
        expect(publishMock).toHaveBeenCalledWith(
            { type: 'analysis-job', jobId: 'u2-a' },
            { idempotencyKey: 'analysis:game-u2-a' }
        );
        expect(result.published).toEqual([
            { jobId: 'u1-a', queued: true, messageId: 'msg-1' },
            { jobId: 'u2-a', queued: true, messageId: 'msg-2' },
        ]);
    });
});
