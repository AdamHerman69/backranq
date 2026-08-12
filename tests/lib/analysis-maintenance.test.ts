import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const publishMock = vi.fn();
const recoverMock = vi.fn();
const dispatchMock = vi.fn();
const flushMock = vi.fn();
const settlementsMock = vi.fn();
const batchPlanRecoveryMock = vi.fn();
const batchCompletionsMock = vi.fn();

async function importMaintenance() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    vi.doMock('@/lib/services/analysisScheduler', () => ({
        recoverExpiredAnalysisJobs: recoverMock,
        dispatchQueuedAnalysisJobs: dispatchMock,
    }));
    vi.doMock('@/lib/services/analysisOutbox', () => ({
        flushAnalysisOutbox: flushMock,
    }));
    vi.doMock('@/lib/services/analysisOps', () => ({
        reconcileAnalysisCreditSettlements: settlementsMock,
    }));
    vi.doMock('@/lib/services/analysisBatches', () => ({
        recoverAnalysisBatchPlanOutbox: batchPlanRecoveryMock,
        reconcileAnalysisBatchCompletions: batchCompletionsMock,
    }));
    return import('@/lib/services/analysisMaintenance');
}

describe('analysis maintenance heartbeat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
            const token = JSON.stringify(query).match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
            )?.[0];
            return [{ leaseToken: token }];
        });
        prismaMock.analysisMaintenanceLease.updateMany.mockResolvedValue({
            count: 1,
        });
        recoverMock.mockResolvedValue({ requeued: 0, failed: 0 });
        dispatchMock.mockResolvedValue({ claimedJobIds: [] });
        settlementsMock.mockResolvedValue({ scanned: 0, errors: [] });
        flushMock.mockResolvedValue({ claimed: 0, published: 0 });
        batchPlanRecoveryMock.mockResolvedValue({ scanned: 0, recovered: 0 });
        batchCompletionsMock.mockResolvedValue({ scanned: 0, completed: 0 });
        publishMock.mockResolvedValue({ queued: true, messageId: 'heartbeat-2' });
    });

    it('recovers durable work and schedules the next minute with a stable key', async () => {
        const maintenance = await importMaintenance();
        const now = new Date('2026-08-12T12:00:00.000Z');

        const result = await maintenance.runAnalysisMaintenanceHeartbeat({ now });

        expect(result).toMatchObject({
            skipped: null,
            nextHeartbeat: {
                queued: true,
                messageId: 'heartbeat-2',
                scheduledAt: '2026-08-12T12:01:00.000Z',
            },
        });
        expect(publishMock).toHaveBeenCalledWith(
            {
                type: 'analysis-maintenance',
                requestedAt: '2026-08-12T12:01:00.000Z',
            },
            {
                idempotencyKey: `analysis-maintenance:${Math.floor(
                    Date.parse('2026-08-12T12:01:00.000Z') / 60_000
                )}`,
                delaySeconds: 60,
                retentionSeconds: 86_400,
            }
        );
    });

    it('throws so Queue retries when the next heartbeat cannot be published', async () => {
        const maintenance = await importMaintenance();
        publishMock.mockResolvedValue({
            queued: false,
            messageId: null,
            unavailableReason: 'publish-failed',
            error: new Error('queue unavailable'),
        });

        await expect(
            maintenance.runAnalysisMaintenanceHeartbeat({
                now: new Date('2026-08-12T12:00:00.000Z'),
            })
        ).rejects.toThrow('Failed to schedule the next analysis maintenance');
    });
});
