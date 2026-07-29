import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

const engineConstructor = vi.fn();
const recordStaleAnalysisDelivery = vi.fn();

async function importServerAnalysis() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/analysis/serverStockfishClient', () => ({
        ServerStockfishClient: class {
            constructor() {
                engineConstructor();
            }
        },
    }));
    vi.doMock('@/lib/services/analysisOps', () => ({
        recordStaleAnalysisDelivery,
    }));
    return import('@/lib/services/serverAnalysis');
}

describe('server analysis provenance boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('rejects a runless delivery before engine startup or product writes', async () => {
        const server = await importServerAnalysis();
        const lockedAt = new Date('2026-07-05T12:00:00.000Z');
        prismaMock.analysisJob.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);

        await expect(
            server.analyzeGameJob(
                'job-1',
                `analysis-delivery-v1:job-1:1:${lockedAt.getTime()}`
            )
        ).rejects.toThrow(/missing immutable enqueue-time run provenance/i);

        expect(engineConstructor).not.toHaveBeenCalled();
        expect(recordStaleAnalysisDelivery).not.toHaveBeenCalled();
        expect(prismaMock.analysisJob.findUnique).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.upsert).not.toHaveBeenCalled();
    });

    it('counts a stale callback without mutating its job', async () => {
        const server = await importServerAnalysis();

        await expect(
            server.analyzeGameJob('job-1', 'invalid-delivery-token')
        ).rejects.toThrow(/stale or no longer claimable/i);

        expect(recordStaleAnalysisDelivery).toHaveBeenCalledTimes(1);
        expect(engineConstructor).not.toHaveBeenCalled();
        expect(prismaMock.analysisJob.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.analysisJob.update).not.toHaveBeenCalled();
    });
});
