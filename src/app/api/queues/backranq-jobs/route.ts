import {
    handleBackranqQueueCallback,
    type BackranqQueueMessage,
} from '@/lib/queues/backranq';
import { processBackranqQueueMessage } from '@/lib/services/backranqQueueProcessor';
import { normalizeError } from '@/lib/services/analysisOutbox';

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
            await processBackranqQueueMessage(message);
            console.log(
                JSON.stringify({
                    level: 'info',
                    event: 'queue.processing.completed',
                    ...context,
                    durationMs: Date.now() - startedAt,
                })
            );
        } catch (error) {
            console.error(
                JSON.stringify({
                    level: 'error',
                    event: 'queue.processing.failed',
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
    _error: unknown,
    metadata: { deliveryCount: number }
) {
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
    return {};
}
