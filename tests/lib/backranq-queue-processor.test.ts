import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeGameJobMock = vi.fn();
const dispatchQueuedAnalysisJobsMock = vi.fn();
const publishMock = vi.fn();
const getAnalysisJobWakeupAtMock = vi.fn();
const getNextQueuedAnalysisRetryMock = vi.fn();

class StaleAnalysisDeliveryError extends Error {}

async function importProcessor() {
    vi.resetModules();
    vi.doMock('@/lib/services/serverAnalysis', () => ({
        analyzeGameJob: analyzeGameJobMock,
    }));
    vi.doMock('@/lib/services/analysisScheduler', () => ({
        dispatchQueuedAnalysisJobs: dispatchQueuedAnalysisJobsMock,
    }));
    vi.doMock('@/lib/services/analysisJobs', () => ({
        getAnalysisJobWakeupAt: getAnalysisJobWakeupAtMock,
        getNextQueuedAnalysisRetry: getNextQueuedAnalysisRetryMock,
        StaleAnalysisDeliveryError,
    }));
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishMock,
    }));
    return import('@/lib/services/backranqQueueProcessor');
}

describe('Backranq analysis queue processor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        publishMock.mockResolvedValue({ queued: true, messageId: 'wake-1' });
        getNextQueuedAnalysisRetryMock.mockResolvedValue(null);
    });

    it('self-drains a 25-job single-user batch one completion at a time', async () => {
        const processor = await importProcessor();
        const pending = [
            {
                type: 'analysis-job' as const,
                jobId: 'job-0',
                dispatchToken: 'token-0',
            },
        ];
        const seenDeliveryTokens = new Set<string>();
        let nextJob = 1;

        analyzeGameJobMock.mockImplementation(
            async (jobId: string, dispatchToken: string) => {
                expect(seenDeliveryTokens.has(dispatchToken)).toBe(false);
                seenDeliveryTokens.add(dispatchToken);
                return {
                    jobId,
                    gameId: `game-${jobId}`,
                    status: 'SUCCEEDED',
                    trainingMoments: 1,
                };
            }
        );
        dispatchQueuedAnalysisJobsMock.mockImplementation(async () => {
            if (nextJob < 25) {
                pending.push({
                    type: 'analysis-job',
                    jobId: `job-${nextJob}`,
                    dispatchToken: `token-${nextJob}`,
                });
                nextJob += 1;
            }
            return { claimedJobIds: [], published: [] };
        });

        while (pending.length > 0) {
            const message = pending.shift();
            if (!message) break;
            await processor.processBackranqQueueMessage(message);
        }

        expect(analyzeGameJobMock).toHaveBeenCalledTimes(25);
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledTimes(25);
        expect(seenDeliveryTokens.size).toBe(25);
    });

    it('schedules a delayed durable wakeup for a retry', async () => {
        const processor = await importProcessor();
        const retryAt = new Date(Date.now() + 120_000);
        analyzeGameJobMock.mockResolvedValue({
            jobId: 'job-1',
            gameId: 'game-1',
            status: 'RETRY_SCHEDULED',
            trainingMoments: 0,
            retryAt,
        });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: [],
            published: [],
        });

        await processor.processBackranqQueueMessage({
            type: 'analysis-job',
            jobId: 'job-1',
            dispatchToken: 'delivery-1',
        });

        expect(publishMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'dispatch-analysis' }),
            expect.objectContaining({
                idempotencyKey: `analysis-dispatch:retry:job-1:${retryAt.toISOString()}`,
                delaySeconds: expect.any(Number),
            })
        );
    });

    it('schedules a durable wakeup at lease expiry after a hard-crash redelivery', async () => {
        const processor = await importProcessor();
        const lockedUntil = new Date(Date.now() + 300_000);
        analyzeGameJobMock.mockRejectedValue(
            new StaleAnalysisDeliveryError('worker still owns the lease')
        );
        getAnalysisJobWakeupAtMock.mockResolvedValue(lockedUntil);
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: [],
            published: [],
        });

        const result = await processor.processBackranqQueueMessage({
            type: 'analysis-job',
            jobId: 'job-1',
            dispatchToken: 'redelivery-after-hard-crash',
        });

        expect(result).toMatchObject({
            analysis: {
                status: 'STALE',
                jobId: 'job-1',
                retryAt: lockedUntil,
            },
        });
        expect(publishMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'dispatch-analysis' }),
            expect.objectContaining({
                idempotencyKey: `analysis-dispatch:retry:job-1:${lockedUntil.toISOString()}`,
                delaySeconds: expect.any(Number),
            })
        );
    });

    it('chains a recovered lease wakeup through its scheduled retry backoff', async () => {
        const processor = await importProcessor();
        const retryAt = new Date(Date.now() + 60_000);
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: [],
            published: [],
        });
        getNextQueuedAnalysisRetryMock.mockResolvedValue({
            jobId: 'job-1',
            retryAt,
        });

        await processor.processBackranqQueueMessage({
            type: 'dispatch-analysis',
            requestedAt: new Date().toISOString(),
        });

        expect(publishMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'dispatch-analysis' }),
            expect.objectContaining({
                idempotencyKey: `analysis-dispatch:retry:job-1:${retryAt.toISOString()}`,
                delaySeconds: expect.any(Number),
            })
        );
    });
});
