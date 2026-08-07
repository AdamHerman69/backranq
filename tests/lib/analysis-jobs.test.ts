import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';
import { hashAnalysisConfig } from '@/lib/services/analysisRuns';

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
        serverCreditsPeriodStart: new Date('2026-07-05T00:00:00Z'),
        serverCreditsRenewAt: new Date('2027-08-05T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
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
        analysisQuality: 'THOROUGH',
        creditCost: 10,
        queuedReason: 'manual',
        configHash: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        consumedCredits: null,
        lastError: null,
    });
    prismaMock.billingAccount.upsert.mockResolvedValue(billingAccount());
    prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
    prismaMock.creditLedgerEntry.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ type: 'RESERVED', credits: 10 }]);
    prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.billingAccount.findUniqueOrThrow.mockResolvedValue(
        billingAccount({ serverCreditsBalance: 89 })
    );
    prismaMock.creditLedgerEntry.create.mockResolvedValue({
        id: 'entry-1',
        userId: 'user-1',
        type: 'RESERVED',
        credits: 10,
        idempotencyKey: 'analysis-run:run-1:reserve',
    });
}

describe('analysis job enqueue service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        primeCreditReservationMocks();
        prismaMock.analysisRun.findMany.mockResolvedValue([]);
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

    it('retries the whole serializable enqueue after a write conflict', async () => {
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
            queuedReason: 'manual',
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        prismaMock.$transaction
            .mockRejectedValueOnce({ code: 'P2034' })
            .mockImplementationOnce(async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
            );
        prismaMock.analysisJob.findUnique.mockResolvedValue(existing);

        await expect(
            service.enqueueAnalysisJob({
                userId: 'user-1',
                gameId: 'game-1',
            })
        ).resolves.toEqual({
            job: existing,
            created: false,
            queued: false,
        });
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
    });

    it('derives and reserves the exact Standard price from the server profile', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.findUnique.mockResolvedValue(null);
        prismaMock.analysisRun.create.mockResolvedValue({
            id: 'run-standard',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
            executionMode: 'SERVER_QUEUE',
            analysisQuality: 'STANDARD',
            creditCost: 7,
            queuedReason: 'manual',
            configHash: 'hash',
            startedAt: null,
            completedAt: null,
            durationMs: null,
            consumedCredits: null,
            lastError: null,
        });
        prismaMock.analysisJob.create.mockResolvedValue({
            id: 'job-standard',
            userId: 'user-1',
            gameId: 'game-1',
            analysisRunId: 'run-standard',
            status: 'QUEUED',
            queuedReason: 'manual',
        });
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);

        await service.enqueueAnalysisJob({
            userId: 'user-1',
            gameId: 'game-1',
            config: service.serverAnalysisConfigFromPreferences({
                analysisQuality: 'STANDARD',
            }).config,
        });

        expect(prismaMock.analysisRun.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                analysisQuality: 'STANDARD',
                creditCost: 7,
            }),
        });
        expect(prismaMock.billingAccount.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    serverCreditsBalance: { decrement: 7 },
                },
            })
        );
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

    it('loads and enforces the current canonical personal budget inside the reservation transaction', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.findUnique.mockResolvedValue(null);
        prismaMock.analysisJob.create.mockResolvedValue({
            id: 'job-1',
            userId: 'user-1',
            gameId: 'game-1',
            analysisRunId: 'run-1',
            status: 'QUEUED',
            queuedReason: 'auto-sync',
        });
        prismaMock.user.findUnique.mockResolvedValue({
            preferences: {
                gameAutomation: {
                    rules: {
                        lichess: { rapid: 'AUTO_ANALYZE' },
                    },
                    analysis: {
                        creditReserve: 7,
                    },
                },
            },
        });
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);

        await service.enqueueAnalysisJob({
            userId: 'user-1',
            gameId: 'game-1',
            queuedReason: 'auto-sync',
            // A stale reconciliation snapshot must not relax the live reserve.
            autoAnalysisBudget: {
                dailyGameLimit: null,
                monthlyGameLimit: null,
                creditReserve: 0,
            },
        } as Parameters<typeof service.enqueueAnalysisJob>[0]);

        expect(prismaMock.billingAccount.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                serverCreditsBalance: { gte: 17 },
            },
            data: {
                serverCreditsBalance: { decrement: 10 },
            },
        });
    });

    it('fails closed when an existing game job belongs to another user', async () => {
        const service = await importJobs();
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            id: 'job-1',
            userId: 'user-2',
            gameId: 'game-1',
            status: 'QUEUED',
        });

        await expect(
            service.enqueueAnalysisJob({
                userId: 'user-1',
                gameId: 'game-1',
            })
        ).rejects.toThrow(service.AnalysisJobOwnershipError);
        expect(prismaMock.analysisJob.update).not.toHaveBeenCalled();
    });

    it('cancels dispatched queued auto jobs and releases each run generation once', async () => {
        const service = await importJobs();
        const leasedAt = new Date('2026-07-20T10:00:00Z');
        prismaMock.analysisJob.findMany
            .mockResolvedValueOnce([
                {
                    id: 'job-1',
                    userId: 'user-1',
                    gameId: 'game-1',
                    analysisRunId: 'run-1',
                    analysisRun: { creditCost: 10 },
                    lockedAt: leasedAt,
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'job-1',
                    userId: 'user-1',
                    gameId: 'game-1',
                    analysisRunId: 'run-2',
                    analysisRun: { creditCost: 10 },
                    lockedAt: leasedAt,
                },
            ]);
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.creditLedgerEntry.findMany.mockReset();
        prismaMock.creditLedgerEntry.findMany
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 10 }])
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 10 }])
            .mockResolvedValueOnce([
                { type: 'RESERVED', credits: 10 },
                { type: 'RELEASED', credits: 10 },
            ])
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 10 }])
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 10 }])
            .mockResolvedValueOnce([
                { type: 'RESERVED', credits: 10 },
                { type: 'RELEASED', credits: 10 },
            ]);
        prismaMock.billingAccount.upsert.mockResolvedValue(billingAccount());
        prismaMock.billingAccount.update.mockResolvedValue(billingAccount());
        prismaMock.creditLedgerEntry.create.mockReset();
        prismaMock.creditLedgerEntry.create
            .mockResolvedValueOnce({
                id: 'release-1',
                userId: 'user-1',
                type: 'RELEASED',
                credits: 10,
                idempotencyKey:
                    'analysis-run:run-1:disabled-release',
            })
            .mockResolvedValueOnce({
                id: 'release-2',
                userId: 'user-1',
                type: 'RELEASED',
                credits: 10,
                idempotencyKey:
                    'analysis-run:run-2:disabled-release',
            });

        await service.cancelQueuedAutoAnalysisJobsInTransaction({
            tx: prismaMock as never,
            userId: 'user-1',
        });
        await service.cancelQueuedAutoAnalysisJobsInTransaction({
            tx: prismaMock as never,
            userId: 'user-1',
        });

        expect(prismaMock.analysisJob.updateMany).toHaveBeenCalledWith({
            where: { id: 'job-1', status: 'QUEUED' },
            data: expect.objectContaining({
                status: 'CANCELLED',
                lockedAt: null,
                lockedUntil: null,
            }),
        });
        expect(prismaMock.analysisRun.updateMany).toHaveBeenCalledWith({
            where: { id: 'run-1', status: 'QUEUED' },
            data: expect.objectContaining({
                status: 'CANCELLED',
                consumedCredits: 0,
            }),
        });
        expect(
            prismaMock.creditLedgerEntry.create.mock.calls.map(
                (call) =>
                    (
                        call[0] as {
                            data: { idempotencyKey: string };
                        }
                    ).data.idempotencyKey
            )
        ).toEqual([
            'analysis-run:run-1:disabled-release',
            'analysis-run:run-2:disabled-release',
        ]);
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

    it('keeps enqueue-time reason immutable across run transitions', async () => {
        const service = await importJobs();
        const run = {
            id: 'run-1',
            userId: 'user-1',
            gameId: 'game-1',
            status: 'QUEUED',
            executionMode: 'SERVER_QUEUE',
            queuedReason: 'auto-sync',
            configHash: 'hash-1',
            startedAt: null,
            completedAt: null,
            durationMs: null,
            consumedCredits: 0,
            analysisQuality: 'THOROUGH',
            creditCost: 10,
            lastError: null,
        };
        prismaMock.analysisJob.findUnique.mockResolvedValue({
            analysisRun: run,
        });
        prismaMock.analysisRun.update.mockResolvedValue({
            ...run,
            status: 'RUNNING',
            startedAt: new Date('2026-07-29T12:00:00.000Z'),
        });

        const config = service.serverAnalysisConfigFromPreferences({}).config;
        await service.transitionAnalysisRunForJob({
            jobId: 'job-1',
            status: 'RUNNING',
            config,
            // Guard against a stale JavaScript caller trying to rewrite provenance.
            queuedReason: 'manual-reanalysis',
        } as Parameters<typeof service.transitionAnalysisRunForJob>[0]);

        expect(prismaMock.analysisRun.update).toHaveBeenCalledWith({
            where: { id: 'run-1' },
            data: expect.not.objectContaining({
                queuedReason: expect.anything(),
                configSnapshot: expect.anything(),
                configHash: expect.anything(),
            }),
        });
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

    it('rejects a correctly hashed snapshot with non-canonical node budgets', async () => {
        const service = await importJobs();
        const source = service.serverAnalysisConfigFromPreferences({
            analysisQuality: 'STANDARD',
        }).config.snapshot;
        const snapshot = structuredClone(source) as Record<string, unknown>;
        const extractOptions = snapshot.extractOptions as Record<
            string,
            unknown
        >;
        extractOptions.maxConfirmationNodes = 1_600_000;

        expect(
            service.serverAnalysisConfigFromSnapshot({
                snapshot,
                hash: hashAnalysisConfig(snapshot),
            })
        ).toBeNull();
    });

    it('rejects correctly hashed engine mutations and extra root fields', async () => {
        const service = await importJobs();
        const canonical = service.serverAnalysisConfigFromPreferences({}).config;
        const engineMutation = structuredClone(canonical.snapshot);
        (engineMutation.engine as Record<string, unknown>).build =
            'different-stockfish-build';
        const extraRoot = {
            ...canonical.snapshot,
            legacyNodes: 100_000,
        };

        expect(
            service.serverAnalysisConfigFromSnapshot({
                snapshot: engineMutation,
                hash: hashAnalysisConfig(engineMutation),
            })
        ).toBeNull();
        expect(
            service.serverAnalysisConfigFromSnapshot({
                snapshot: extraRoot,
                hash: hashAnalysisConfig(extraRoot),
            })
        ).toBeNull();
    });

    it('refuses to enqueue a non-canonical server configuration', async () => {
        const service = await importJobs();
        const canonical = service.serverAnalysisConfigFromPreferences({
            analysisQuality: 'STANDARD',
        }).config;
        const snapshot = structuredClone(canonical.snapshot);
        const extractOptions = snapshot.extractOptions as Record<
            string,
            unknown
        >;
        extractOptions.maxConfirmationNodes = 1_600_000;

        await expect(
            service.enqueueAnalysisJob({
                userId: 'user-1',
                gameId: 'game-1',
                config: {
                    ...canonical,
                    snapshot,
                    hash: hashAnalysisConfig(snapshot),
                },
            })
        ).rejects.toThrow('Invalid server analysis configuration');
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
});
