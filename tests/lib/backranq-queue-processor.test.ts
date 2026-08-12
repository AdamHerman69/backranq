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
const dispatchPendingNotificationDeliveriesMock = vi.fn();
const processNotificationDeliveryMock = vi.fn();
const runNotificationMaintenanceMock = vi.fn();
const processPracticeDueNotificationPageMock = vi.fn();
const processPracticeDueSweepPageMock = vi.fn();
const flushAnalysisOutboxMock = vi.fn();
const processAnalysisBatchPageMock = vi.fn();
const runAnalysisMaintenanceHeartbeatMock = vi.fn();

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
    vi.doMock('@/lib/services/analysisOutbox', () => ({
        flushAnalysisOutbox: flushAnalysisOutboxMock,
    }));
    vi.doMock('@/lib/services/analysisBatches', () => ({
        processAnalysisBatchPage: processAnalysisBatchPageMock,
    }));
    vi.doMock('@/lib/services/analysisMaintenance', () => ({
        runAnalysisMaintenanceHeartbeat:
            runAnalysisMaintenanceHeartbeatMock,
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
    vi.doMock('@/lib/notifications/delivery', () => ({
        dispatchPendingNotificationDeliveries:
            dispatchPendingNotificationDeliveriesMock,
        processNotificationDelivery: processNotificationDeliveryMock,
    }));
    vi.doMock('@/lib/notifications/campaigns', () => ({
        runNotificationMaintenance: runNotificationMaintenanceMock,
    }));
    vi.doMock('@/lib/training/practiceDueSweep', () => ({
        processPracticeDueNotificationPage:
            processPracticeDueNotificationPageMock,
        processPracticeDueSweepPage: processPracticeDueSweepPageMock,
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
        dispatchPendingNotificationDeliveriesMock.mockResolvedValue([]);
        flushAnalysisOutboxMock.mockResolvedValue({
            claimed: 0,
            published: 0,
            pending: 0,
            failed: 0,
            ambiguous: 0,
            items: [],
        });
        runAnalysisMaintenanceHeartbeatMock.mockResolvedValue({
            skipped: null,
            nextHeartbeat: { queued: true, messageId: 'heartbeat-2' },
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

    it('plans a durable batch page before staging job dispatch', async () => {
        const processor = await importProcessor();
        processAnalysisBatchPageMock.mockResolvedValue({
            batchId: 'batch-1',
            claimed: 2,
            queued: 2,
            attached: 0,
            skipped: 0,
            failed: 0,
            remaining: 0,
            continuationOutboxId: null,
        });
        dispatchQueuedAnalysisJobsMock.mockResolvedValue({
            claimedJobIds: ['job-1'],
        });

        const result = await processor.processBackranqQueueMessage({
            type: 'analysis-batch',
            batchId: 'batch-1',
        });

        expect(processAnalysisBatchPageMock).toHaveBeenCalledWith('batch-1');
        expect(dispatchQueuedAnalysisJobsMock).toHaveBeenCalledOnce();
        expect(flushAnalysisOutboxMock).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            batch: { batchId: 'batch-1', queued: 2 },
            dispatch: { claimedJobIds: ['job-1'] },
        });
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

    it('wakes bounded delivery immediately after maintenance records notifications', async () => {
        const processor = await importProcessor();
        runNotificationMaintenanceMock.mockResolvedValue({
            reconciled: { welcomeUsers: 1 },
        });
        dispatchPendingNotificationDeliveriesMock.mockResolvedValue([
            { deliveryId: 'delivery-1', queued: true },
        ]);

        const result = await processor.processBackranqQueueMessage({
            type: 'notification-maintenance',
            referenceAt: '2026-08-07T00:00:00.000Z',
            since: '2026-08-01T00:00:00.000Z',
        });

        expect(runNotificationMaintenanceMock).toHaveBeenCalledOnce();
        expect(dispatchPendingNotificationDeliveriesMock).toHaveBeenCalledOnce();
        expect(
            dispatchPendingNotificationDeliveriesMock.mock
                .invocationCallOrder[0]
        ).toBeGreaterThan(
            runNotificationMaintenanceMock.mock.invocationCallOrder[0]!
        );
        expect(result).toEqual({
            maintenance: { reconciled: { welcomeUsers: 1 } },
            notificationDispatch: [
                { deliveryId: 'delivery-1', queued: true },
            ],
        });
    });

    it('leaves a retry in durable DB state for maintenance and flushes ready work', async () => {
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

        expect(flushAnalysisOutboxMock).toHaveBeenCalledOnce();
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

    it('leaves a stale hard-crash delivery for autonomous lease recovery', async () => {
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
        expect(flushAnalysisOutboxMock).toHaveBeenCalledOnce();
    });

    it('stages and flushes recovered work on a legacy dispatch wakeup', async () => {
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

        expect(flushAnalysisOutboxMock).toHaveBeenCalledOnce();
    });

    it('runs and reschedules the durable maintenance heartbeat', async () => {
        const processor = await importProcessor();

        const result = await processor.processBackranqQueueMessage({
            type: 'analysis-maintenance',
            requestedAt: '2026-08-12T12:00:00.000Z',
        });

        expect(runAnalysisMaintenanceHeartbeatMock).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            nextHeartbeat: { queued: true, messageId: 'heartbeat-2' },
        });
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
