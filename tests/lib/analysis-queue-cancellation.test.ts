import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

async function importCancellation() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/billingAccounts', () => ({
        releaseServerAnalysisCreditsInTransaction: vi.fn(),
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/analysisQueueCancellation');
}

describe('analysis queue cancellation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('never cancels a shared job that this batch only attached to', async () => {
        const cancellation = await importCancellation();
        prismaMock.analysisBatch.findUnique.mockResolvedValue({
            id: 'batch-2',
            userId: 'user-1',
        });
        prismaMock.analysisBatchItem.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.analysisBatchItem.findMany.mockResolvedValue([]);

        await cancellation.cancelUnavailableAnalysisBatch({
            batchId: 'batch-2',
            reason: 'Server analysis queue is disabled',
        });

        expect(prismaMock.analysisBatchItem.findMany).toHaveBeenCalledWith({
            where: {
                batchId: 'batch-2',
                analysisJobId: { not: null },
                status: 'QUEUED',
            },
            distinct: ['analysisJobId'],
            select: { analysisJobId: true },
        });
        expect(prismaMock.analysisJob.findFirst).not.toHaveBeenCalled();
    });
});
