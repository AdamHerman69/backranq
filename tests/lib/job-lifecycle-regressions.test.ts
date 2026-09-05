import { describe, it, expect, vi } from 'vitest';
import { prismaMock, mockPrismaModule } from '../helpers/route-mocks';

function useTransactionMock() {
    prismaMock.$transaction.mockImplementation(async (callback: unknown) =>
        (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
    );
}

const fence = {
    lockedAt: new Date('2026-09-05T00:00:00Z'),
    dispatchedCount: 1,
};

describe('job lifecycle failure boundaries', () => {
    it('does not resurrect a finished run when an old worker resumes its start transition', async () => {
        vi.resetModules();
        mockPrismaModule();
        useTransactionMock();
        const service = await import('@/lib/services/analysisJobs');
        const run = {
            id: 'run-1',
            status: 'SUCCEEDED',
            executionMode: 'SERVER_QUEUE',
            queuedReason: 'manual',
            configHash: 'hash',
            startedAt: new Date(),
            completedAt: new Date(),
            consumedCredits: 10,
            analysisQuality: 'THOROUGH',
            creditCost: 10,
            lastError: null,
        };
        prismaMock.analysisJob.findUnique.mockResolvedValue({ analysisRun: run });
        prismaMock.$queryRaw.mockResolvedValue([]);
        prismaMock.analysisRun.update.mockImplementation(async (input: unknown) => {
            const { data } = input as { data: object };
            return Object.assign(run, data);
        });

        const result = await service.transitionAnalysisRunForJob({
            jobId: 'job-1',
            analysisRunId: 'run-1',
            fence,
            status: 'RUNNING',
        });

        expect(result).toBeNull();
        expect(run.status).toBe('SUCCEEDED');
        expect(run.consumedCredits).toBe(10);
    });

    it('terminates the queued run when configuration fails before its running transition', async () => {
        vi.resetModules();
        mockPrismaModule();
        useTransactionMock();
        const service = await import('@/lib/services/analysisJobs');
        const job = {
            id: 'job-1',
            analysisRunId: 'run-1',
            status: 'RUNNING',
            attempts: 5,
        };
        const run = { status: 'QUEUED' };
        prismaMock.analysisJob.findFirst.mockResolvedValue(job);
        prismaMock.analysisJob.findUnique.mockResolvedValue(job);
        prismaMock.analysisJob.updateMany.mockImplementation(async (input: unknown) => {
            const { data } = input as { data: object };
            Object.assign(job, data);
            return { count: 1 };
        });
        prismaMock.analysisRun.updateMany.mockImplementation(async (input: unknown) => {
            const { where, data } = input as {
                where: { status: string | { in: string[] } };
                data: object;
            };
            const allowed = typeof where.status === 'string'
                ? [where.status]
                : where.status.in;
            if (!allowed.includes(run.status)) return { count: 0 };
            Object.assign(run, data);
            return { count: 1 };
        });

        await service.markAnalysisJobFailed(
            job.id,
            fence,
            new Error('Invalid configuration provenance')
        );

        expect(job.status).toBe('FAILED');
        expect(run.status).toBe('FAILED');
    });

    it('fails an exhausted expired sync delivery without calling the provider again', async () => {
        vi.resetModules();
        mockPrismaModule();
        useTransactionMock();
        const provider = vi.fn().mockResolvedValue({
            provider: 'LICHESS',
            complete: true,
            created: 0,
        });
        const recordFailed = vi.fn().mockResolvedValue(null);
        vi.doMock('@/lib/services/autoSync', () => ({
            syncUserProvider: provider,
            StaleSyncJobLeaseError: class extends Error {},
        }));
        vi.doMock('@/lib/notifications/service', () => ({
            recordSyncCompleted: vi.fn(),
            recordSyncFailed: recordFailed,
        }));
        vi.doMock('@/lib/queues/backranq', () => ({
            publishBackranqQueueMessage: vi.fn(),
        }));
        const job = {
            id: 'sync-1',
            userId: 'user-1',
            provider: 'LICHESS',
            status: 'RUNNING',
            attempts: 5,
            leaseToken: 'old-token',
            lockedUntil: new Date(0),
            scheduledFor: new Date(0),
            createdCount: 0,
            user: {
                id: 'user-1',
                preferences: {},
                chessAccountConnections: [],
                accounts: [],
            },
        };
        prismaMock.syncJob.findUnique.mockResolvedValue(job);
        prismaMock.syncJob.updateMany.mockImplementation(async (input: unknown) => {
            const { where, data } = input as {
                where: { attempts?: number | { lt?: number } };
                data: Record<string, unknown>;
            };
            if (
                typeof where.attempts === 'object' &&
                where.attempts.lt !== undefined &&
                job.attempts >= where.attempts.lt
            ) return { count: 0 };
            const attempts = data.attempts ? job.attempts + 1 : job.attempts;
            Object.assign(job, data, { attempts });
            return { count: 1 };
        });
        const { processSyncJob } = await import('@/lib/services/syncJobs');

        const result = await processSyncJob(job.id);

        expect(provider).not.toHaveBeenCalled();
        expect(job.status).toBe('FAILED');
        expect(result.disposition).toBe('FAILED');
        expect(recordFailed).toHaveBeenCalledOnce();
    });
});
