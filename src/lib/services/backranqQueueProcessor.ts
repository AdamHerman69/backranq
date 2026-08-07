import {
    publishBackranqQueueMessage,
    type BackranqQueueMessage,
} from '@/lib/queues/backranq';
import { analyzeGameJob } from '@/lib/services/serverAnalysis';
import { dispatchQueuedAnalysisJobs } from '@/lib/services/analysisScheduler';
import {
    getAnalysisJobWakeupAt,
    getNextQueuedAnalysisRetry,
    StaleAnalysisDeliveryError,
} from '@/lib/services/analysisJobs';
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
import { processWeeklyMasterRun } from '@/lib/master/pipelineRunner';

export async function processBackranqQueueMessage(message: BackranqQueueMessage) {
    if (message.type === 'weekly-master-run') {
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
        return runNotificationMaintenance({
            referenceAt: new Date(message.referenceAt),
            since: new Date(message.since),
            analysisCursor: message.analysisCursor,
            syncCursor: message.syncCursor,
            userCursor: message.userCursor,
            weeklyCursor: message.weeklyCursor,
            practiceDueCursor: message.practiceDueCursor,
        });
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
        const notificationDispatch = await safeNotificationDispatch();
        return { sync, dispatch, notificationDispatch };
    }
    if (message.type === 'reconcile-auto-analysis') {
        return reconcileAndDispatchAutoAnalysisBacklog(message.userId, {
            cursor: message.cursor,
        });
    }
    if (message.type === 'reconcile-auto-analysis-sweep') {
        return dispatchAutoAnalysisPolicySweep({
            requestedAt: message.requestedAt,
            cursor: message.cursor,
        });
    }
    if (message.type === 'dispatch-analysis') {
        const dispatch = await dispatchQueuedAnalysisJobs();
        const nextRetry = await getNextQueuedAnalysisRetry();
        const retryWakeup = nextRetry
            ? await scheduleRetryWakeup(nextRetry)
            : null;
        return { dispatch, retryWakeup };
    }
    if (message.type === 'analysis-job') {
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
        const autoAnalysisContinuation =
            await requestAutoAnalysisContinuationAfterTerminalJob(
                message.jobId
            );
        const retryWakeup =
            (analysis.status === 'RETRY_SCHEDULED' ||
                analysis.status === 'STALE') &&
            analysis.retryAt
                ? await scheduleRetryWakeup({
                      jobId: analysis.jobId,
                      retryAt: analysis.retryAt,
                  })
                : null;
        const notificationDispatch = await safeNotificationDispatch();
        return {
            analysis,
            dispatch,
            autoAnalysisContinuation,
            retryWakeup,
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

async function scheduleRetryWakeup(args: { jobId: string; retryAt: Date }) {
    const now = Date.now();
    const delaySeconds = Math.max(
        0,
        Math.ceil((args.retryAt.getTime() - now) / 1_000)
    );
    return publishBackranqQueueMessage(
        { type: 'dispatch-analysis', requestedAt: new Date(now).toISOString() },
        {
            idempotencyKey: `analysis-dispatch:retry:${args.jobId}:${args.retryAt.toISOString()}`,
            delaySeconds,
        }
    );
}
