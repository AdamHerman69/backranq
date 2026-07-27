import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type AnalysisOpsModule = typeof import('@/lib/services/analysisOps');

async function importOps(): Promise<AnalysisOpsModule> {
    vi.resetModules();
    mockPrismaModule();
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
            .mockResolvedValueOnce(1);
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

        const snapshot = await ops.getAnalysisOpsSnapshot({
            now: new Date('2026-07-05T12:00:00Z'),
        });

        expect(snapshot).toEqual({
            analysisJobs: {
                queued: 10,
                running: 2,
                failed: 1,
                lockedQueued: 3,
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
});
