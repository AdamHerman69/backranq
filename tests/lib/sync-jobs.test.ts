import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type SyncJobsModule = typeof import('@/lib/services/syncJobs');

async function importSyncJobs(): Promise<SyncJobsModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: vi.fn(),
    }));
    vi.doMock('@/lib/services/autoSync', () => ({
        syncUserProvider: vi.fn(),
    }));
    return import('@/lib/services/syncJobs');
}

describe('sync job planning', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('plans one queued job per enabled linked provider', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: {
                    autoSyncEnabled: true,
                    autoSyncProviders: { lichess: true, chesscom: false },
                },
                lichessUsername: 'Ada',
                chesscomUsername: 'ada-chess',
                providerSyncStates: [],
            },
        ]);
        prismaMock.syncJob.findFirst.mockResolvedValue(null);
        prismaMock.syncJob.create.mockResolvedValue({
            id: 'sync-job-1',
            userId: 'user-1',
            provider: 'LICHESS',
        });
        const { planSyncJobs } = await importSyncJobs();

        const result = await planSyncJobs({
            scheduledFor: new Date('2026-07-05T12:00:00.000Z'),
        });

        expect(result).toMatchObject({
            usersScanned: 1,
            jobsCreated: 1,
            jobsExisting: 0,
        });
        expect(result.providers).toEqual([
            {
                userId: 'user-1',
                provider: 'LICHESS',
                queued: true,
                jobId: 'sync-job-1',
                skippedReason: null,
            },
            {
                userId: 'user-1',
                provider: 'CHESSCOM',
                queued: false,
                jobId: null,
                skippedReason: 'disabled',
            },
        ]);
        expect(prismaMock.syncJob.create).toHaveBeenCalledWith({
            data: {
                userId: 'user-1',
                provider: 'LICHESS',
                scheduledFor: new Date('2026-07-05T12:00:00.000Z'),
            },
        });
    });

    it('does not duplicate already queued provider jobs', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: {
                    autoSyncEnabled: true,
                    autoSyncProviders: { lichess: true, chesscom: true },
                },
                lichessUsername: 'Ada',
                chesscomUsername: null,
                providerSyncStates: [],
            },
        ]);
        prismaMock.syncJob.findFirst.mockResolvedValue({
            id: 'existing-job',
            createdAt: new Date('2026-07-05T10:00:00.000Z'),
        });
        const { planSyncJobs } = await importSyncJobs();

        const result = await planSyncJobs();

        expect(result.jobsCreated).toBe(0);
        expect(result.jobsExisting).toBe(1);
        expect(result.providers).toContainEqual({
            userId: 'user-1',
            provider: 'LICHESS',
            queued: false,
            jobId: 'existing-job',
            skippedReason: 'already-queued',
        });
        expect(prismaMock.syncJob.create).not.toHaveBeenCalled();
    });

    it('treats a concurrent unique conflict as an existing active job', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: {
                    autoSyncEnabled: true,
                    autoSyncProviders: { lichess: true, chesscom: false },
                },
                lichessUsername: 'Ada',
                chesscomUsername: null,
                providerSyncStates: [],
            },
        ]);
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'existing-race-job',
                userId: 'user-1',
                provider: 'LICHESS',
                status: 'QUEUED',
            });
        prismaMock.syncJob.create.mockRejectedValue(
            new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
                code: 'P2002',
                clientVersion: 'test',
                meta: { target: ['userId', 'provider'] },
            })
        );
        const { planSyncJobs } = await importSyncJobs();

        const result = await planSyncJobs();

        expect(result.jobsCreated).toBe(0);
        expect(result.jobsExisting).toBe(1);
        expect(result.providers).toContainEqual({
            userId: 'user-1',
            provider: 'LICHESS',
            queued: false,
            jobId: 'existing-race-job',
            skippedReason: 'already-queued',
        });
    });
});
