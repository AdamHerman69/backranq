import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type AnalysisOpsModule = typeof import('@/lib/services/analysisOps');
const consumeCreditsMock = vi.fn();
const releaseCreditsMock = vi.fn();

async function importOps(): Promise<AnalysisOpsModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/billingAccounts', () => ({
        consumeServerAnalysisCredits: consumeCreditsMock,
        releaseServerAnalysisCreditsAndMarkRunReleased: releaseCreditsMock,
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/analysisOps');
}

describe('analysis ops snapshot', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('summarizes queue, sync, and credit ledger health', async () => {
        const ops = await importOps();
        prismaMock.analysisJob.count
            .mockResolvedValueOnce(10)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(7)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(4)
            .mockResolvedValueOnce(1);
        prismaMock.analysisJob.aggregate.mockResolvedValue({
            _sum: { dispatchedCount: 42 },
        });
        prismaMock.syncJob.count
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(2)
            .mockResolvedValueOnce(1);
        prismaMock.analysisJob.findFirst
            .mockResolvedValueOnce({
                createdAt: new Date('2026-07-05T11:59:00Z'),
            })
            .mockResolvedValueOnce({
                startedAt: new Date('2026-07-05T11:58:00Z'),
                lockedAt: new Date('2026-07-05T11:58:10Z'),
            });
        prismaMock.analysisJob.findMany.mockResolvedValue([
            { id: 'job-1', gameId: 'game-1', lastError: 'engine failed' },
        ]);
        prismaMock.syncJob.findFirst
            .mockResolvedValueOnce({
                createdAt: new Date('2026-07-05T11:57:00Z'),
            })
            .mockResolvedValueOnce({
                startedAt: new Date('2026-07-05T11:56:00Z'),
                lockedUntil: new Date('2026-07-05T12:01:00Z'),
            });
        prismaMock.syncJob.findMany.mockResolvedValue([
            { id: 'sync-1', provider: 'LICHESS', lastError: 'rate limited' },
        ]);
        prismaMock.stripeWebhookEvent.count
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(20)
            .mockResolvedValueOnce(2);
        prismaMock.stripeWebhookEvent.findMany.mockResolvedValue([
            {
                id: 'evt_1',
                type: 'customer.subscription.updated',
                lastError: 'Could not map Stripe subscription',
            },
        ]);
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([
            { type: 'RESERVED', _sum: { credits: 12 } },
            { type: 'CONSUMED', _sum: { credits: 8 } },
            { type: 'REFUNDED', _sum: { credits: 1 } },
            { type: 'RELEASED', _sum: { credits: 2 } },
        ]);
        prismaMock.analysisOpsCounter.findUnique.mockResolvedValue({
            value: BigInt(7),
        });
        prismaMock.$queryRaw.mockResolvedValue([
            {
                activeWithoutReservation: BigInt(2),
                terminalWithOutstandingReservation: BigInt(3),
                oversettled: BigInt(1),
            },
        ]);

        const snapshot = await ops.getAnalysisOpsSnapshot({
            now: new Date('2026-07-05T12:00:00Z'),
        });

        expect(snapshot).toEqual({
            analysisJobs: {
                queued: 10,
                running: 2,
                failed: 1,
                lockedQueued: 3,
                readyQueued: 7,
                retryScheduled: 2,
                settlementPending: 1,
                publishPending: 4,
                totalDispatches: 42,
                staleDeliveries: 7,
                stuckRunning: 1,
                oldestQueuedAgeSeconds: 60,
                oldestRunningAgeSeconds: 120,
                recentErrors: [
                    { id: 'job-1', gameId: 'game-1', error: 'engine failed' },
                ],
            },
            syncJobs: {
                queued: 5,
                running: 1,
                failed: 2,
                stuckRunning: 1,
                oldestQueuedAgeSeconds: 180,
                oldestRunningAgeSeconds: 240,
                recentErrors: [
                    { id: 'sync-1', provider: 'LICHESS', error: 'rate limited' },
                ],
            },
            credits: {
                reserved: 12,
                consumed: 8,
                refunded: 1,
                released: 2,
                expired: 0,
                outstandingReserved: 2,
                invariantViolations: {
                    activeWithoutReservation: 2,
                    terminalWithOutstandingReservation: 3,
                    oversettled: 1,
                },
            },
            stripeWebhooks: {
                processing: 1,
                succeeded: 20,
                failed: 2,
                recentErrors: [
                    {
                        id: 'evt_1',
                        type: 'customer.subscription.updated',
                        error: 'Could not map Stripe subscription',
                    },
                ],
            },
        });
    });

    it('records stale deliveries outside the fenced job row', async () => {
        const ops = await importOps();
        prismaMock.analysisOpsCounter.upsert.mockResolvedValue({
            key: 'analysis_stale_deliveries_total',
            value: BigInt(4),
        });

        await ops.recordStaleAnalysisDelivery();

        expect(prismaMock.analysisOpsCounter.upsert).toHaveBeenCalledWith({
            where: { key: 'analysis_stale_deliveries_total' },
            create: {
                key: 'analysis_stale_deliveries_total',
                value: BigInt(1),
            },
            update: { value: { increment: BigInt(1) } },
        });
        expect(prismaMock.analysisJob.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.analysisJob.update).not.toHaveBeenCalled();
    });

    it('reconciles terminal jobs with outstanding reservations', async () => {
        const ops = await importOps();
        prismaMock.analysisJob.findMany.mockResolvedValue([
            {
                id: 'job-success',
                userId: 'user-1',
                gameId: 'game-1',
                analysisRunId: 'run-1',
                status: 'SUCCEEDED',
                analysisRun: { creditCost: 10 },
            },
            {
                id: 'job-failed',
                userId: 'user-1',
                gameId: 'game-2',
                analysisRunId: 'run-2',
                status: 'FAILED',
                analysisRun: { creditCost: 10 },
            },
        ]);
        consumeCreditsMock.mockResolvedValue({ created: true });
        releaseCreditsMock.mockResolvedValue({ created: true });
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });

        const result = await ops.reconcileAnalysisCreditSettlements();

        expect(result).toEqual({
            scanned: 2,
            consumed: 1,
            released: 1,
            errors: [],
        });
        expect(consumeCreditsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                analysisJobId: 'job-success',
                idempotencyKey: 'analysis-run:run-1:consume',
            })
        );
        expect(releaseCreditsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                analysisJobId: 'job-failed',
                idempotencyKey: 'analysis-run:run-2:release',
            })
        );
    });

    it('scopes a failed reanalysis reservation to its current run instead of prior job consumption', async () => {
        const ops = await importOps();
        prismaMock.analysisJob.findMany.mockResolvedValue([
            {
                id: 'recycled-job',
                userId: 'user-1',
                gameId: 'game-1',
                analysisRunId: 'run-2',
                status: 'FAILED',
                analysisRun: { creditCost: 10 },
                lastError: null,
            },
        ]);
        releaseCreditsMock.mockResolvedValue({ created: true });
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 0 });

        const result = await ops.reconcileAnalysisCreditSettlements();

        expect(result).toEqual({
            scanned: 1,
            consumed: 0,
            released: 1,
            errors: [],
        });
        expect(prismaMock.analysisJob.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        {
                            analysisRun: {
                                is: {
                                    creditLedgerEntries: {
                                        some: { type: 'RESERVED' },
                                        none: {
                                            type: {
                                                in: [
                                                    'CONSUMED',
                                                    'RELEASED',
                                                    'EXPIRED',
                                                ],
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    ]),
                }),
            })
        );
        expect(releaseCreditsMock).toHaveBeenCalledWith(
            expect.objectContaining({
                analysisJobId: 'recycled-job',
                analysisRunId: 'run-2',
                idempotencyKey: 'analysis-run:run-2:release',
            })
        );
    });
});
