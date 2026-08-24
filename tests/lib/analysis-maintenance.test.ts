import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const recoverMock = vi.fn();
const dispatchMock = vi.fn();
const flushMock = vi.fn();
const settlementsMock = vi.fn();
const batchPlanRecoveryMock = vi.fn();
const batchCompletionsMock = vi.fn();

async function importMaintenance() {
    vi.resetModules();
    mockPrismaModule();
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

describe('analysis maintenance cycle', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
            const token = JSON.stringify(query).match(
                /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i
            )?.[0];
            return [{ leaseToken: token }];
        });
        recoverMock.mockResolvedValue({ requeued: 0, failed: 0 });
        dispatchMock.mockResolvedValue({ claimedJobIds: [] });
        settlementsMock.mockResolvedValue({ scanned: 0, errors: [] });
        flushMock.mockResolvedValue({ claimed: 0, published: 0 });
        batchPlanRecoveryMock.mockResolvedValue({ scanned: 0, recovered: 0 });
        batchCompletionsMock.mockResolvedValue({ scanned: 0, completed: 0 });
    });

    it('recovers durable work once without publishing another heartbeat', async () => {
        const maintenance = await importMaintenance();
        const result = await maintenance.runAnalysisMaintenanceCycle({
            now: new Date('2026-08-12T12:00:00.000Z'),
        });

        expect(result).toMatchObject({
            skipped: null,
            recovery: { requeued: 0 },
            dispatch: { claimedJobIds: [] },
            outbox: { claimed: 0 },
        });
        expect(recoverMock).toHaveBeenCalledOnce();
        expect(dispatchMock).toHaveBeenCalledOnce();
        expect(flushMock).toHaveBeenCalledOnce();
        expect(prismaMock.analysisMaintenanceLease.updateMany).not.toHaveBeenCalled();
    });

    it('skips all durable work when another cycle owns the lease', async () => {
        prismaMock.$queryRaw.mockResolvedValue([]);
        const maintenance = await importMaintenance();

        await expect(
            maintenance.runAnalysisMaintenanceCycle({
                now: new Date('2026-08-12T12:00:00.000Z'),
            })
        ).resolves.toEqual({ skipped: 'already-running' });
        expect(recoverMock).not.toHaveBeenCalled();
        expect(prismaMock.analysisMaintenanceLease.updateMany).not.toHaveBeenCalled();
    });
});
