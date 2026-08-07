import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeGameJobMock = vi.fn();
const dispatchQueuedAnalysisJobsMock = vi.fn();
const publishMock = vi.fn();
const getAnalysisJobWakeupAtMock = vi.fn();
const getNextQueuedAnalysisRetryMock = vi.fn();
const reconcileAutoAnalysisMock = vi.fn();
const requestAutoAnalysisContinuationAfterTerminalJobMock = vi.fn();
const dispatchAutoAnalysisPolicySweepMock = vi.fn();
const dispatchPlannedSyncJobsMock = vi.fn();
const processSyncJobMock = vi.fn();
const processWeeklyMasterRunMock = vi.fn();

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
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        dispatchAutoAnalysisPolicySweep:
            dispatchAutoAnalysisPolicySweepMock,
        reconcileAndDispatchAutoAnalysisBacklog:
            reconcileAutoAnalysisMock,
        requestAutoAnalysisContinuationAfterTerminalJob:
            requestAutoAnalysisContinuationAfterTerminalJobMock,
    }));
    vi.doMock('@/lib/services/syncJobs', () => ({
        dispatchPlannedSyncJobs: dispatchPlannedSyncJobsMock,
        processSyncJob: processSyncJobMock,
    }));
    vi.doMock('@/lib/master/pipelineRunner', () => ({
        processWeeklyMasterRun: processWeeklyMasterRunMock,
    }));
    return import('@/lib/services/backranqQueueProcessor');
}

describe('Backranq analysis queue processor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        publishMock.mockResolvedValue({ queued: true, messageId: 'wake-1' });
        requestAutoAnalysisContinuationAfterTerminalJobMock.mockResolvedValue(
            null
        );
        getNextQueuedAnalysisRetryMock.mockResolvedValue(null);
        dispatchAutoAnalysisPolicySweepMock.mockResolvedValue({
            scanned: 0,
            enabled: 0,
            published: [],
            nextCursor: null,
            continuation: null,
        });
        dispatchPlannedSyncJobsMock.mockResolvedValue({
            usersScanned: 0,
            jobsCreated: 0,
            jobsExisting: 0,
            providers: [],
            published: [],
        });
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

    it('routes Weekly Master work through the durable pipeline worker', async () => {
        const processor = await importProcessor();
        processWeeklyMasterRunMock.mockResolvedValue({
            id: 'master-run-1',
            status: 'SUCCEEDED',
        });

        await processor.processBackranqQueueMessage({
            type: 'weekly-master-run',
            runId: 'master-run-1',
        });

        expect(processWeeklyMasterRunMock).toHaveBeenCalledWith('master-run-1');
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

    it('checks for an idempotent auto-analysis continuation after each delivery', async () => {
        const processor = await importProcessor();
        analyzeGameJobMock.mockResolvedValue({
            jobId: 'job-1',
            gameId: 'game-1',
            status: 'SUCCEEDED',
            trainingMoments: 1,
        });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: [],
            published: [],
        });
        requestAutoAnalysisContinuationAfterTerminalJobMock.mockResolvedValue({
            queued: true,
            messageId: 'continuation-1',
        });

        const result = await processor.processBackranqQueueMessage({
            type: 'analysis-job',
            jobId: 'job-1',
            dispatchToken: 'delivery-1',
        });

        expect(
            requestAutoAnalysisContinuationAfterTerminalJobMock
        ).toHaveBeenCalledWith('job-1');
        expect(result).toMatchObject({
            autoAnalysisContinuation: {
                queued: true,
                messageId: 'continuation-1',
            },
        });
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

    it('processes a durable per-user auto-analysis reconciliation wakeup', async () => {
        const processor = await importProcessor();
        reconcileAutoAnalysisMock.mockResolvedValue({
            reconciliation: { queued: 2 },
            dispatch: { published: [{ jobId: 'job-1' }] },
        });

        const result = await processor.processBackranqQueueMessage({
            type: 'reconcile-auto-analysis',
            userId: 'user-1',
            requestedAt: new Date().toISOString(),
            reason: 'billing',
        });

        expect(reconcileAutoAnalysisMock).toHaveBeenCalledWith('user-1', {
            cursor: undefined,
        });
        expect(result).toMatchObject({
            reconciliation: { queued: 2 },
        });
    });

    it('continues a bounded daily auto-analysis policy sweep', async () => {
        const processor = await importProcessor();
        dispatchAutoAnalysisPolicySweepMock.mockResolvedValue({
            scanned: 100,
            enabled: 40,
            nextCursor: 'user-100',
        });
        const requestedAt = '2026-07-21T03:00:00.000Z';

        await processor.processBackranqQueueMessage({
            type: 'reconcile-auto-analysis-sweep',
            requestedAt,
            cursor: 'user-050',
        });

        expect(dispatchAutoAnalysisPolicySweepMock).toHaveBeenCalledWith({
            requestedAt,
            cursor: 'user-050',
        });
    });

    it('starts the daily policy sweep even when provider sync has no work', async () => {
        const processor = await importProcessor();
        const requestedAt = '2026-07-21T03:00:00.000Z';

        await processor.processBackranqQueueMessage({
            type: 'sync-all',
            requestedAt,
        });

        expect(dispatchPlannedSyncJobsMock).toHaveBeenCalledTimes(1);
        expect(dispatchAutoAnalysisPolicySweepMock).toHaveBeenCalledWith({
            requestedAt,
        });
    });
});
