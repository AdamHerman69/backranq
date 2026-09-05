import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type SyncJobsModule = typeof import('@/lib/services/syncJobs');

const publishBackranqQueueMessageMock = vi.fn();
const syncUserProviderMock = vi.fn();
const recordSyncCompletedMock = vi.fn();
const recordSyncFailedMock = vi.fn();

async function importSyncJobs(): Promise<SyncJobsModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishBackranqQueueMessageMock,
    }));
    vi.doMock('@/lib/services/autoSync', () => ({
        StaleSyncJobLeaseError: class StaleSyncJobLeaseError extends Error {},
        syncUserProvider: syncUserProviderMock,
    }));
    vi.doMock('@/lib/notifications/service', () => ({
        recordSyncCompleted: recordSyncCompletedMock,
        recordSyncFailed: recordSyncFailedMock,
    }));
    return import('@/lib/services/syncJobs');
}

function automationPreferences(args: {
    lichess: 'IGNORE' | 'IMPORT_ONLY';
    chesscom: 'IGNORE' | 'IMPORT_ONLY';
}) {
    const providerRules = (mode: 'IGNORE' | 'IMPORT_ONLY') => ({
        bullet: mode,
        blitz: mode,
        rapid: mode,
        classical: mode,
        unknown: mode,
    });
    return {
        gameAutomation: {
            rules: {
                lichess: providerRules(args.lichess),
                chesscom: providerRules(args.chesscom),
            },
        },
    };
}

function linkedConnections(
    lichess: string | null,
    chesscom: string | null
) {
    return [
        ...(lichess
            ? [
                  {
                      provider: 'LICHESS' as const,
                      username: lichess,
                      usernameNormalized: lichess.toLowerCase(),
                  },
              ]
            : []),
        ...(chesscom
            ? [
                  {
                      provider: 'CHESSCOM' as const,
                      username: chesscom,
                      usernameNormalized: chesscom.toLowerCase(),
                  },
              ]
            : []),
    ];
}

describe('sync job planning', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
        );
        recordSyncCompletedMock.mockResolvedValue(null);
        recordSyncFailedMock.mockResolvedValue(null);
    });

    it('plans one queued job per enabled linked provider', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: automationPreferences({
                    lichess: 'IMPORT_ONLY',
                    chesscom: 'IGNORE',
                }),
                chessAccountConnections: linkedConnections('Ada', 'ada-chess'),
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
                preferences: automationPreferences({
                    lichess: 'IMPORT_ONLY',
                    chesscom: 'IMPORT_ONLY',
                }),
                chessAccountConnections: linkedConnections('Ada', null),
                providerSyncStates: [],
            },
        ]);
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
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
                preferences: automationPreferences({
                    lichess: 'IMPORT_ONLY',
                    chesscom: 'IGNORE',
                }),
                chessAccountConnections: linkedConnections('Ada', null),
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

    it('reuses an active job before applying the stale threshold', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            preferences: automationPreferences({
                lichess: 'IMPORT_ONLY',
                chesscom: 'IMPORT_ONLY',
            }),
            chessAccountConnections: linkedConnections('Ada', null),
            providerSyncStates: [
                {
                    provider: 'LICHESS',
                    enabled: true,
                    lastSuccessAt: new Date('2026-07-05T11:59:00.000Z'),
                },
            ],
        });
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'active-job',
                status: 'RUNNING',
                lockedUntil: new Date('2026-07-05T12:10:00.000Z'),
                createdAt: new Date('2026-07-05T11:58:00.000Z'),
            });
        const { planUserSyncJobs } = await importSyncJobs();

        const result = await planUserSyncJobs({
            userId: 'user-1',
            providers: ['LICHESS'],
            onlyIfStaleMinutes: 60,
            now: new Date('2026-07-05T12:00:00.000Z'),
        });

        expect(result).toEqual([
            {
                userId: 'user-1',
                provider: 'LICHESS',
                queued: false,
                jobId: 'active-job',
                skippedReason: 'already-queued',
            },
        ]);
        expect(prismaMock.syncJob.create).not.toHaveBeenCalled();
    });

    it('does not recover an expired lease after its heartbeat renewed ownership', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            preferences: {},
            chessAccountConnections: linkedConnections('Ada', null),
            providerSyncStates: [],
        });
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce({
                id: 'active-job',
                status: 'RUNNING',
                attempts: 1,
                leaseToken: 'worker-lease',
                lockedUntil: new Date('2026-07-05T11:59:00.000Z'),
                createdAt: new Date('2026-07-05T11:50:00.000Z'),
            })
            .mockResolvedValueOnce({
                id: 'active-job',
                status: 'RUNNING',
                lockedUntil: new Date('2026-07-05T12:10:00.000Z'),
                createdAt: new Date('2026-07-05T11:50:00.000Z'),
            });
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 0 });
        const { planUserSyncJobs } = await importSyncJobs();

        const result = await planUserSyncJobs({
            userId: 'user-1',
            providers: ['LICHESS'],
            now,
        });

        expect(result).toEqual([
            {
                userId: 'user-1',
                provider: 'LICHESS',
                queued: false,
                jobId: 'active-job',
                skippedReason: 'already-queued',
            },
        ]);
        expect(prismaMock.syncJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'active-job',
                status: 'RUNNING',
                leaseToken: 'worker-lease',
                OR: [
                    { lockedUntil: null },
                    { lockedUntil: { lte: now } },
                ],
            },
            data: expect.objectContaining({
                status: 'QUEUED',
                leaseToken: null,
            }),
        });
        expect(prismaMock.syncJob.create).not.toHaveBeenCalled();
    });

    it('skips a fresh provider for an app-open stale request', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            preferences: automationPreferences({
                lichess: 'IMPORT_ONLY',
                chesscom: 'IMPORT_ONLY',
            }),
            chessAccountConnections: linkedConnections('Ada', null),
            providerSyncStates: [
                {
                    provider: 'LICHESS',
                    enabled: true,
                    lastSuccessAt: new Date('2026-07-05T11:30:00.000Z'),
                },
            ],
        });
        prismaMock.syncJob.findFirst.mockResolvedValue(null);
        const { planUserSyncJobs } = await importSyncJobs();

        const result = await planUserSyncJobs({
            userId: 'user-1',
            providers: ['LICHESS'],
            onlyIfStaleMinutes: 60,
            now: new Date('2026-07-05T12:00:00.000Z'),
        });

        expect(result[0]).toMatchObject({
            queued: false,
            skippedReason: 'fresh',
        });
        expect(prismaMock.syncJob.create).not.toHaveBeenCalled();
    });

    it('honors automation preferences for stale requests but lets an explicit manual sync override them', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            preferences: automationPreferences({
                lichess: 'IGNORE',
                chesscom: 'IGNORE',
            }),
            chessAccountConnections: linkedConnections('Ada', null),
            providerSyncStates: [],
        });
        prismaMock.syncJob.findFirst.mockResolvedValue(null);
        prismaMock.syncJob.create.mockResolvedValue({
            id: 'manual-job',
            userId: 'user-1',
            provider: 'LICHESS',
        });
        const { planUserSyncJobs } = await importSyncJobs();

        const stale = await planUserSyncJobs({
            userId: 'user-1',
            providers: ['LICHESS'],
            onlyIfStaleMinutes: 60,
        });
        const manual = await planUserSyncJobs({
            userId: 'user-1',
            providers: ['LICHESS'],
        });

        expect(stale[0]).toMatchObject({ skippedReason: 'disabled' });
        expect(manual[0]).toMatchObject({
            queued: true,
            jobId: 'manual-job',
            skippedReason: null,
        });
    });

    it('republishes an existing queued job with an idempotent attempt wakeup', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        const updatedAt = new Date('2026-07-05T11:59:30.000Z');
        prismaMock.user.findUnique.mockResolvedValue({
            id: 'user-1',
            preferences: {},
            chessAccountConnections: linkedConnections('Ada', null),
            providerSyncStates: [],
        });
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                id: 'queued-job',
                status: 'QUEUED',
                scheduledFor: now,
                attempts: 1,
                updatedAt,
                createdAt: updatedAt,
            });
        prismaMock.syncJob.findUnique.mockResolvedValue({
            id: 'queued-job',
            status: 'QUEUED',
            attempts: 1,
            scheduledFor: now,
            updatedAt,
        });
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'message-2',
        });
        const { dispatchUserSyncJobs } = await importSyncJobs();

        const result = await dispatchUserSyncJobs({
            userId: 'user-1',
            providers: ['LICHESS'],
            now,
        });

        expect(result.providers[0]).toMatchObject({
            queued: false,
            jobId: 'queued-job',
            skippedReason: 'already-queued',
        });
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            { type: 'sync-job', jobId: 'queued-job' },
            {
                idempotencyKey:
                    'sync-job:queued-job:state:2026-07-05T11:59:30.000Z:attempt:2',
                delaySeconds: 0,
            }
        );
    });

    it('durably schedules a retry without counting the failed attempt twice', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        const retryAt = new Date('2026-07-05T12:01:00.000Z');
        const updatedAt = new Date('2026-07-05T12:00:00.100Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.syncJob.findUnique
            .mockResolvedValueOnce({
                id: 'sync-job-1',
                userId: 'user-1',
                provider: 'LICHESS',
                attempts: 1,
                user: {
                    id: 'user-1',
                    preferences: {},
                    chessAccountConnections: linkedConnections('Ada', null),
                    accounts: [],
                },
            })
            .mockResolvedValueOnce({
                id: 'sync-job-1',
                status: 'QUEUED',
                attempts: 1,
                scheduledFor: retryAt,
                updatedAt,
            });
        prismaMock.syncJob.update.mockResolvedValue({
            id: 'sync-job-1',
            status: 'QUEUED',
        });
        syncUserProviderMock.mockResolvedValue({
            provider: 'LICHESS',
            username: 'Ada',
            fetched: 4,
            saved: 3,
            created: 3,
            updated: 0,
            importedGameIds: ['game-1', 'game-2', 'game-3'],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: false,
            skipped: false,
            error: 'Saved 3/4 games; 1 failed',
        });
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'retry-message',
        });
        const { processSyncJob } = await importSyncJobs();

        await processSyncJob('sync-job-1', { now, clock: () => now });

        expect(prismaMock.syncJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'sync-job-1',
                status: 'RUNNING',
                leaseToken: expect.any(String),
            },
            data: expect.objectContaining({
                status: 'QUEUED',
                scheduledFor: retryAt,
                leaseToken: null,
            }),
        });
        const retryData = prismaMock.syncJob.updateMany.mock.calls
            .map((call) => (call[0] as { data?: Record<string, unknown> }).data)
            .find((data) => data?.status === 'QUEUED');
        expect(retryData).not.toHaveProperty('fetchedCount');
        expect(retryData).not.toHaveProperty('savedCount');
        expect(retryData).not.toHaveProperty('createdCount');
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            { type: 'sync-job', jobId: 'sync-job-1' },
            expect.objectContaining({ delaySeconds: 60 })
        );
    });

    it('acknowledges a duplicate delivery after the job is already terminal', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.syncJob.findUnique.mockResolvedValue({
            provider: 'LICHESS',
            status: 'SUCCEEDED',
            scheduledFor: now,
            lockedUntil: null,
        });
        const { processSyncJob } = await importSyncJobs();

        const result = await processSyncJob('sync-job-1', { now });

        expect(result).toEqual({
            jobId: 'sync-job-1',
            provider: 'LICHESS',
            disposition: 'IGNORED',
            terminalStatus: 'SUCCEEDED',
            result: null,
        });
        expect(syncUserProviderMock).not.toHaveBeenCalled();
    });

    it('acknowledges a delivery whose durable job was deleted', async () => {
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.syncJob.findUnique.mockResolvedValue(null);
        const { processSyncJob } = await importSyncJobs();

        await expect(processSyncJob('missing-job')).resolves.toMatchObject({
            disposition: 'IGNORED',
            terminalStatus: 'MISSING',
        });
        expect(syncUserProviderMock).not.toHaveBeenCalled();
    });

    it('defers an early redelivery until the active lease can expire', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.syncJob.findUnique.mockResolvedValue({
            provider: 'LICHESS',
            status: 'RUNNING',
            scheduledFor: now,
            lockedUntil: new Date('2026-07-05T12:10:00.000Z'),
        });
        const { processSyncJob } = await importSyncJobs();

        await expect(
            processSyncJob('sync-job-1', { now })
        ).rejects.toMatchObject({
            name: 'SyncJobDeliveryDeferredError',
            retryAfterSeconds: 600,
        });
        expect(syncUserProviderMock).not.toHaveBeenCalled();
    });

    it('does not fail the fifth attempt while its worker lease remains active', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.syncJob.findUnique.mockResolvedValue({
            provider: 'LICHESS',
            userId: 'user-1',
            status: 'RUNNING',
            attempts: 5,
            leaseToken: 'active-lease',
            scheduledFor: now,
            lockedUntil: new Date('2026-07-05T12:10:00.000Z'),
        });
        const { processSyncJob } = await importSyncJobs();

        await expect(processSyncJob('sync-job-1', { now })).rejects.toMatchObject({
            name: 'SyncJobDeliveryDeferredError',
            retryAfterSeconds: 600,
        });

        expect(syncUserProviderMock).not.toHaveBeenCalled();
        expect(recordSyncFailedMock).not.toHaveBeenCalled();
        expect(prismaMock.syncJob.updateMany).toHaveBeenCalledOnce();
    });

    it('defers an exhausted delivery if recovery replaced its lease before failure committed', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.syncJob.findUnique.mockResolvedValue({
            provider: 'LICHESS',
            userId: 'user-1',
            status: 'RUNNING',
            attempts: 5,
            leaseToken: 'superseded-lease',
            scheduledFor: now,
            lockedUntil: new Date(0),
        });
        const { processSyncJob } = await importSyncJobs();

        await expect(processSyncJob('sync-job-1', { now })).rejects.toMatchObject({
            name: 'SyncJobDeliveryDeferredError',
            retryAfterSeconds: 1,
        });

        expect(syncUserProviderMock).not.toHaveBeenCalled();
        expect(recordSyncFailedMock).not.toHaveBeenCalled();
        expect(prismaMock.syncJob.updateMany).toHaveBeenCalledTimes(2);
    });

    it('continues an incomplete batch on its fifth attempt with a fresh retry budget', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        const updatedAt = new Date('2026-07-05T12:00:00.100Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.syncJob.findUnique
            .mockResolvedValueOnce({
                id: 'sync-job-1',
                userId: 'user-1',
                provider: 'LICHESS',
                attempts: 5,
                user: {
                    id: 'user-1',
                    preferences: {},
                    chessAccountConnections: linkedConnections('Ada', null),
                    accounts: [],
                },
            })
            .mockResolvedValueOnce({
                id: 'sync-job-1',
                status: 'QUEUED',
                attempts: 0,
                scheduledFor: now,
                updatedAt,
            });
        prismaMock.syncJob.update.mockResolvedValue({
            id: 'sync-job-1',
            status: 'QUEUED',
        });
        syncUserProviderMock.mockResolvedValue({
            provider: 'LICHESS',
            username: 'Ada',
            fetched: 200,
            saved: 200,
            created: 180,
            updated: 20,
            importedGameIds: [],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: false,
            skipped: false,
        });
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'continuation-message',
        });
        const { processSyncJob } = await importSyncJobs();

        await processSyncJob('sync-job-1', { now, clock: () => now });

        expect(prismaMock.syncJob.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'sync-job-1',
                status: 'RUNNING',
                leaseToken: expect.any(String),
            },
            data: expect.objectContaining({
                status: 'QUEUED',
                scheduledFor: now,
                attempts: 0,
                leaseToken: null,
            }),
        });
        const continuationData = prismaMock.syncJob.updateMany.mock.calls
            .map((call) => (call[0] as { data?: Record<string, unknown> }).data)
            .find((data) => data?.status === 'QUEUED');
        expect(continuationData).not.toHaveProperty('fetchedCount');
        expect(continuationData).not.toHaveProperty('savedCount');
        expect(continuationData).not.toHaveProperty('createdCount');
        expect(continuationData).not.toHaveProperty('updatedCount');
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            { type: 'sync-job', jobId: 'sync-job-1' },
            expect.objectContaining({ delaySeconds: 0 })
        );
    });

    it('records real completion time instead of reusing the claim timestamp', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        const finishedAt = new Date('2026-07-05T12:00:42.000Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.syncJob.findUnique.mockResolvedValueOnce({
            id: 'sync-job-1',
            userId: 'user-1',
            provider: 'LICHESS',
            attempts: 1,
            createdCount: 0,
            user: {
                id: 'user-1',
                preferences: {},
                chessAccountConnections: linkedConnections('Ada', null),
                accounts: [],
            },
        });
        syncUserProviderMock.mockResolvedValue({
            provider: 'LICHESS',
            username: 'Ada',
            fetched: 1,
            saved: 1,
            created: 1,
            updated: 0,
            importedGameIds: ['game-1'],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: true,
            skipped: false,
        });
        const { processSyncJob } = await importSyncJobs();

        const result = await processSyncJob('sync-job-1', {
            now,
            clock: () => finishedAt,
        });

        expect(result.disposition).toBe('SUCCEEDED');
        expect(prismaMock.syncJob.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    status: 'SUCCEEDED',
                    completedAt: finishedAt,
                }),
            })
        );
    });

    it('fails a rejected provider snapshot once without retry writes', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.syncJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.syncJob.findUnique.mockResolvedValueOnce({
            id: 'sync-job-1',
            userId: 'user-1',
            provider: 'LICHESS',
            attempts: 1,
            createdCount: 0,
            user: {
                id: 'user-1',
                preferences: {},
                chessAccountConnections: linkedConnections('Ada', null),
                accounts: [],
            },
        });
        syncUserProviderMock.mockResolvedValue({
            provider: 'LICHESS',
            username: 'Ada',
            fetched: 1,
            saved: 0,
            created: 0,
            updated: 0,
            importedGameIds: [],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: false,
            skipped: false,
            retryable: false,
            error: 'Rejected immutable provider snapshot',
        });
        const { processSyncJob } = await importSyncJobs();

        const result = await processSyncJob('sync-job-1', {
            now,
            clock: () => now,
        });

        expect(result.disposition).toBe('FAILED');
        expect(publishBackranqQueueMessageMock).not.toHaveBeenCalled();
        expect(recordSyncFailedMock).toHaveBeenCalledOnce();
        const terminalData = prismaMock.syncJob.updateMany.mock.calls
            .map((call) => (call[0] as { data?: Record<string, unknown> }).data)
            .find((data) => data?.status === 'FAILED');
        expect(terminalData).not.toHaveProperty('fetchedCount');
        expect(terminalData).not.toHaveProperty('savedCount');
    });

    it('does not let a stale worker complete a job after its lease is replaced', async () => {
        const now = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.syncJob.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        prismaMock.syncJob.findUnique.mockResolvedValueOnce({
            id: 'sync-job-1',
            userId: 'user-1',
            provider: 'LICHESS',
            attempts: 1,
            user: {
                id: 'user-1',
                preferences: {},
                chessAccountConnections: linkedConnections('Ada', null),
                accounts: [],
            },
        });
        syncUserProviderMock.mockResolvedValue({
            provider: 'LICHESS',
            username: 'Ada',
            fetched: 1,
            saved: 1,
            created: 1,
            updated: 0,
            importedGameIds: ['game-1'],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: true,
            skipped: false,
        });
        const { processSyncJob } = await importSyncJobs();

        const result = await processSyncJob('sync-job-1', { now, clock: () => now });

        expect(result.result).toMatchObject({
            skipped: true,
            error: 'Sync delivery was superseded by a newer worker lease',
        });
        expect(syncUserProviderMock).toHaveBeenCalledWith(
            expect.objectContaining({
                jobLease: {
                    jobId: 'sync-job-1',
                    leaseToken: expect.any(String),
                },
            })
        );
        expect(publishBackranqQueueMessageMock).not.toHaveBeenCalled();
    });

    it('reads active and latest activity per provider without a shared history window', async () => {
        const date = new Date('2026-07-05T12:00:00.000Z');
        const job = (overrides: Record<string, unknown>) => ({
            id: 'job',
            provider: 'LICHESS',
            status: 'SUCCEEDED',
            scheduledFor: date,
            startedAt: date,
            completedAt: date,
            fetchedCount: 1,
            savedCount: 1,
            createdCount: 1,
            updatedCount: 0,
            queuedAnalysisCount: 0,
            lastError: null,
            ...overrides,
        });
        prismaMock.chessAccountConnection.findMany.mockResolvedValue(
            linkedConnections('Ada', 'AdaChess')
        );
        prismaMock.providerSyncState.findMany.mockResolvedValue([]);
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce(
                job({
                    id: 'old-but-active-lichess',
                    status: 'RUNNING',
                    completedAt: null,
                })
            )
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(
                job({ id: 'latest-lichess', status: 'SUCCEEDED' })
            )
            .mockResolvedValueOnce(
                job({
                    id: 'latest-chesscom',
                    provider: 'CHESSCOM',
                    status: 'FAILED',
                })
            );
        const { getUserSyncActivity } = await importSyncJobs();

        const activity = await getUserSyncActivity('user-1');

        expect(activity.providers[0]?.activeJob?.id).toBe(
            'old-but-active-lichess'
        );
        expect(activity.providers[0]?.latestJob?.id).toBe('latest-lichess');
        expect(activity.providers[1]?.activeJob).toBeNull();
        expect(activity.providers[1]?.latestJob?.id).toBe('latest-chesscom');
    });

    it('returns only explicitly requested completion jobs owned by the user', async () => {
        const date = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.chessAccountConnection.findMany.mockResolvedValue(
            linkedConnections('Ada', null)
        );
        prismaMock.providerSyncState.findMany.mockResolvedValue([]);
        prismaMock.syncJob.findFirst.mockResolvedValue(null);
        prismaMock.syncJob.findMany.mockResolvedValue([
            {
                id: 'old-owned-job',
                provider: 'LICHESS',
                status: 'SUCCEEDED',
                scheduledFor: date,
                startedAt: date,
                completedAt: date,
                fetchedCount: 2,
                savedCount: 2,
                createdCount: 2,
                updatedCount: 0,
                queuedAnalysisCount: 0,
                lastError: null,
            },
        ]);
        const { getUserSyncActivity } = await importSyncJobs();

        const activity = await getUserSyncActivity('user-1', {
            requestedJobIds: ['old-owned-job', 'not-owned-job'],
        });

        expect(prismaMock.syncJob.findMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                id: { in: ['old-owned-job', 'not-owned-job'] },
            },
            take: 4,
            select: expect.any(Object),
        });
        expect(activity.requestedJobs?.map((job) => job.id)).toEqual([
            'old-owned-job',
        ]);
    });
});
