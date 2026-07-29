import { beforeEach, describe, expect, it, vi } from 'vitest';

const claimNextAnalysisJobsMock = vi.fn();
const releaseAnalysisDispatchLocksMock = vi.fn();
const analyzeGameJobMock = vi.fn();

type WorkerModule = typeof import('@/lib/services/analysisWorker');

async function importWorker(): Promise<WorkerModule> {
    vi.resetModules();
    vi.doMock('@/lib/services/analysisScheduler', () => ({
        claimNextAnalysisJobs: claimNextAnalysisJobsMock,
        releaseAnalysisDispatchLocks: releaseAnalysisDispatchLocksMock,
    }));
    vi.doMock('@/lib/services/serverAnalysis', () => ({
        analyzeGameJob: analyzeGameJobMock,
    }));
    return import('@/lib/services/analysisWorker');
}

describe('analysis worker batch runner', () => {
    const lockedAt = new Date('2026-07-05T12:00:00Z');

    beforeEach(() => {
        vi.resetAllMocks();
        claimNextAnalysisJobsMock.mockResolvedValue({
            claimedJobs: [
                { id: 'job-1', lockedAt, dispatchedCount: 1 },
                { id: 'job-2', lockedAt, dispatchedCount: 2 },
            ],
            claimedJobIds: ['job-1', 'job-2'],
            claimMisses: [],
        });
        analyzeGameJobMock
            .mockResolvedValueOnce({
                jobId: 'job-1',
                gameId: 'game-1',
                trainingMoments: 2,
            })
            .mockResolvedValueOnce({
                jobId: 'job-2',
                gameId: 'game-2',
                trainingMoments: 0,
            });
    });

    it('claims jobs and processes them through server analysis', async () => {
        const worker = await importWorker();

        const result = await worker.runAnalysisWorkerBatch({
            globalLimit: 2,
            perUserLimit: 1,
        });

        expect(claimNextAnalysisJobsMock).toHaveBeenCalledWith({
            globalLimit: 2,
            perUserLimit: 1,
        });
        expect(analyzeGameJobMock).toHaveBeenCalledTimes(2);
        expect(analyzeGameJobMock).toHaveBeenNthCalledWith(
            1,
            'job-1',
            `analysis-delivery-v1:job-1:1:${lockedAt.getTime()}`
        );
        expect(result).toEqual({
            claimedJobIds: ['job-1', 'job-2'],
            claimMisses: [],
            processed: [
                {
                    jobId: 'job-1',
                    ok: true,
                    gameId: 'game-1',
                    trainingMoments: 2,
                },
                {
                    jobId: 'job-2',
                    ok: true,
                    gameId: 'game-2',
                    trainingMoments: 0,
                },
            ],
        });
    });

    it('records failures and continues when configured', async () => {
        claimNextAnalysisJobsMock.mockReset();
        analyzeGameJobMock.mockReset();
        claimNextAnalysisJobsMock.mockResolvedValue({
            claimedJobs: [
                { id: 'job-1', lockedAt, dispatchedCount: 1 },
                { id: 'job-2', lockedAt, dispatchedCount: 2 },
            ],
            claimedJobIds: ['job-1', 'job-2'],
            claimMisses: ['job-3'],
        });
        analyzeGameJobMock
            .mockRejectedValueOnce(new Error('engine failed'))
            .mockResolvedValueOnce({
                jobId: 'job-2',
                gameId: 'game-2',
                trainingMoments: 1,
            });
        const worker = await importWorker();

        const result = await worker.runAnalysisWorkerBatch({
            continueOnError: true,
        });

        expect(result.processed).toEqual([
            { jobId: 'job-1', ok: false, error: 'engine failed' },
            {
                jobId: 'job-2',
                ok: true,
                gameId: 'game-2',
                trainingMoments: 1,
            },
        ]);
        expect(result.claimMisses).toEqual(['job-3']);
    });

    it('releases unprocessed claimed jobs when fail-fast is requested', async () => {
        claimNextAnalysisJobsMock.mockReset();
        analyzeGameJobMock.mockReset();
        releaseAnalysisDispatchLocksMock.mockResolvedValue({ count: 1 });
        claimNextAnalysisJobsMock.mockResolvedValue({
            claimedJobs: [
                { id: 'job-1', lockedAt, dispatchedCount: 1 },
                { id: 'job-2', lockedAt, dispatchedCount: 2 },
            ],
            claimedJobIds: ['job-1', 'job-2'],
            claimMisses: [],
        });
        analyzeGameJobMock.mockRejectedValueOnce(new Error('engine failed'));
        const worker = await importWorker();

        await expect(
            worker.runAnalysisWorkerBatch({ continueOnError: false })
        ).rejects.toThrow('engine failed');

        expect(releaseAnalysisDispatchLocksMock).toHaveBeenCalledWith(['job-2']);
        expect(analyzeGameJobMock).toHaveBeenCalledTimes(1);
    });
});
