import type { BackranqQueueMessage } from '@/lib/queues/backranq';
import { dispatchQueuedAnalysisJobs } from '@/lib/services/analysisScheduler';
import {
    getAnalysisJobWakeupAt,
    StaleAnalysisDeliveryError,
} from '@/lib/services/analysisJobs';
import { flushAnalysisOutbox } from '@/lib/services/analysisOutbox';
import { processAnalysisBatchPage } from '@/lib/services/analysisBatches';
import {
    dispatchPlannedSyncJobs,
    processSyncJob,
} from '@/lib/services/syncJobs';
import {
    dispatchAutoAnalysisPolicySweep,
    reconcileAndDispatchAutoAnalysisBacklog,
    requestAutoAnalysisContinuationAfterTerminalJob,
} from '@/lib/services/autoAnalysisBacklog';
import {
    dispatchPendingNotificationDeliveries,
    processNotificationDelivery,
} from '@/lib/notifications/delivery';
import { runNotificationMaintenance } from '@/lib/notifications/campaigns';
import {
    processPracticeDueNotificationPage,
    processPracticeDueSweepPage,
} from '@/lib/training/practiceDueSweep';
import { runAnalysisMaintenanceHeartbeat } from '@/lib/services/analysisMaintenance';

export async function processBackranqQueueMessage(message: BackranqQueueMessage) {
    if (message.type === 'runtime-smoke') {
        if (process.env.BACKRANQ_QUEUE_SMOKE_MODE !== 'true') {
            throw new Error('Queue runtime smoke messages are disabled.');
        }
        const parentFetch = globalThis.fetch;
        const { ServerStockfishClient } = await import(
            '@/lib/analysis/serverStockfishClient'
        );
        const engine = new ServerStockfishClient({
            defaultNodes: 1_000,
            defaultTimeoutMs: 15_000,
        });
        try {
            const identity = await engine.getIdentity();
            const result = await engine.evalPosition({
                fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                nodes: 1_000,
                timeoutMs: 15_000,
            });
            if (
                typeof globalThis.fetch !== 'function' ||
                globalThis.fetch !== parentFetch
            ) {
                throw new Error('Stockfish changed the parent fetch binding.');
            }
            return {
                engine: identity.name,
                bestMoveUci: result.bestMoveUci,
            };
        } finally {
            engine.terminate();
        }
    }
    if (message.type === 'weekly-master-run') {
        const { processWeeklyMasterRun } = await import(
            '@/lib/master/pipelineRunner'
        );
        return processWeeklyMasterRun(message.runId);
    }
    if (message.type === 'notification-delivery') {
        return processNotificationDelivery(
            message.deliveryId,
            message.dispatchToken
        );
    }
    if (message.type === 'notification-sweep') {
        return dispatchPendingNotificationDeliveries();
    }
    if (message.type === 'notification-maintenance') {
        const maintenance = await runNotificationMaintenance({
            referenceAt: new Date(message.referenceAt),
            since: new Date(message.since),
            analysisCursor: message.analysisCursor,
            syncCursor: message.syncCursor,
            userCursor: message.userCursor,
            weeklyCursor: message.weeklyCursor,
            practiceDueCursor: message.practiceDueCursor,
        });
        const notificationDispatch =
            await dispatchPendingNotificationDeliveries();
        return { maintenance, notificationDispatch };
    }
    if (message.type === 'practice-due-sweep') {
        return processPracticeDueSweepPage(message.sweepId);
    }
    if (message.type === 'practice-due-notify') {
        return processPracticeDueNotificationPage(
            message.sweepId,
            message.afterUserId
        );
    }
    if (message.type === 'sync-all') {
        const [sync, automation] = await Promise.all([
            dispatchPlannedSyncJobs(),
            dispatchAutoAnalysisPolicySweep({
                requestedAt: message.requestedAt,
            }),
        ]);
        return { sync, automation };
    }
    if (message.type === 'sync-job') {
        const sync = await processSyncJob(message.jobId);
        const dispatch = await dispatchQueuedAnalysisJobs();
        const outbox = await flushAnalysisOutbox();
        const notificationDispatch = await safeNotificationDispatch();
        return { sync, dispatch, outbox, notificationDispatch };
    }
    if (message.type === 'reconcile-auto-analysis') {
        const reconciliation = await reconcileAndDispatchAutoAnalysisBacklog(message.userId, {
            cursor: message.cursor,
        });
        const outbox = await flushAnalysisOutbox();
        return { ...reconciliation, outbox };
    }
    if (message.type === 'reconcile-auto-analysis-sweep') {
        return dispatchAutoAnalysisPolicySweep({
            requestedAt: message.requestedAt,
            cursor: message.cursor,
        });
    }
    if (message.type === 'dispatch-analysis') {
        const dispatch = await dispatchQueuedAnalysisJobs();
        const outbox = await flushAnalysisOutbox();
        return { dispatch, outbox };
    }
    if (message.type === 'analysis-maintenance') {
        return runAnalysisMaintenanceHeartbeat();
    }
    if (message.type === 'analysis-batch') {
        const batch = await processAnalysisBatchPage(message.batchId);
        const dispatch = await dispatchQueuedAnalysisJobs();
        const outbox = await flushAnalysisOutbox();
        return { batch, dispatch, outbox };
    }
    if (message.type === 'analysis-job') {
        const { analyzeGameJob } = await import(
            '@/lib/services/serverAnalysis'
        );
        let analysis:
            | Awaited<ReturnType<typeof analyzeGameJob>>
            | { status: 'STALE'; jobId: string; retryAt: Date | null };
        try {
            analysis = await analyzeGameJob(
                message.jobId,
                message.dispatchToken
            );
        } catch (error) {
            if (!(error instanceof StaleAnalysisDeliveryError)) throw error;
            analysis = {
                status: 'STALE',
                jobId: message.jobId,
                retryAt: await getAnalysisJobWakeupAt(message.jobId),
            };
        }

        // Completing one delivery frees per-user capacity. Always dispatch the
        // next ready job so a batch drains without another HTTP or cron trigger.
        const dispatch = await dispatchQueuedAnalysisJobs();
        const outbox = await flushAnalysisOutbox();
        const autoAnalysisContinuation =
            await requestAutoAnalysisContinuationAfterTerminalJob(
                message.jobId
            );
        const notificationDispatch = await safeNotificationDispatch();
        return {
            analysis,
            dispatch,
            autoAnalysisContinuation,
            outbox,
            notificationDispatch,
        };
    }
    throw new Error('Unknown queue message');
}

async function safeNotificationDispatch() {
    try {
        return await dispatchPendingNotificationDeliveries();
    } catch (error) {
        console.error('[notifications] delivery wakeup failed', error);
        return [];
    }
}
