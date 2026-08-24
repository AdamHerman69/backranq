import {
    handleBackranqQueueCallback,
    type BackranqQueueMessage,
} from '@/lib/queues/backranq';
import { processBackranqQueueMessage } from '@/lib/services/backranqQueueProcessor';
import { normalizeError } from '@/lib/services/analysisOutbox';
import { isWeeklyMasterTerminalError } from '@/lib/master/pipelineErrors';
import { SyncJobDeliveryDeferredError } from '@/lib/services/syncJobErrors';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const POST = handleBackranqQueueCallback<BackranqQueueMessage>(
    async (message, metadata) => {
        const startedAt = Date.now();
        const context = {
            route: '/api/queues/backranq-jobs',
            messageType: message.type,
            messageId: metadata.messageId,
            deliveryCount: metadata.deliveryCount,
            ...messageContext(message),
        };
        console.log(
            JSON.stringify({
                level: 'info',
                event: 'queue.processing.started',
                ...context,
            })
        );
        try {
            const outcome = await processBackranqQueueMessage(message);
            console.log(
                JSON.stringify({
                    level: 'info',
                    event: 'queue.processing.completed',
                    ...context,
                    durationMs: Date.now() - startedAt,
                    ...outcomeContext(message, outcome),
                })
            );
        } catch (error) {
            const terminal = isWeeklyMasterTerminalError(error);
            const log = terminal ? console.warn : console.error;
            log(
                JSON.stringify({
                    level: terminal ? 'warn' : 'error',
                    event: terminal
                        ? 'queue.processing.terminal'
                        : 'queue.processing.failed',
                    ...context,
                    durationMs: Date.now() - startedAt,
                    error: normalizeError(error),
                })
            );
            throw error;
        }
    },
    {
        visibilityTimeoutSeconds: 300,
        retry: backranqQueueRetry,
    }
);

export function backranqQueueRetry(
    error: unknown,
    metadata: { deliveryCount: number }
) {
    if (isWeeklyMasterTerminalError(error)) {
        return { acknowledge: true as const };
    }
    if (error instanceof SyncJobDeliveryDeferredError) {
        return {
            afterSeconds: Math.min(300, error.retryAfterSeconds),
        };
    }
    return {
        afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 10),
    };
}

function messageContext(message: BackranqQueueMessage) {
    if (message.type === 'analysis-job') {
        return { analysisJobId: message.jobId };
    }
    if (message.type === 'analysis-batch') {
        return { analysisBatchId: message.batchId };
    }
    if (message.type === 'weekly-master-run') {
        return { weeklyMasterRunId: message.runId };
    }
    if (message.type === 'sync-job') {
        return { syncJobId: message.jobId };
    }
    return {};
}

function outcomeContext(
    message: BackranqQueueMessage,
    outcome: unknown
) {
    if (message.type !== 'sync-job' || !outcome || typeof outcome !== 'object') {
        return {};
    }
    const sync = (outcome as { sync?: unknown }).sync;
    if (!sync || typeof sync !== 'object') return {};
    const value = sync as {
        disposition?: unknown;
        terminalStatus?: unknown;
        result?: {
            fetched?: unknown;
            saved?: unknown;
            created?: unknown;
            updated?: unknown;
            complete?: unknown;
            error?: unknown;
        };
    };
    return {
        syncDisposition: value.disposition,
        syncTerminalStatus: value.terminalStatus,
        syncFetched: value.result?.fetched,
        syncSaved: value.result?.saved,
        syncCreated: value.result?.created,
        syncUpdated: value.result?.updated,
        syncComplete: value.result?.complete,
        ...(typeof value.result?.error === 'string'
            ? { syncError: value.result.error.slice(0, 500) }
            : {}),
    };
}
