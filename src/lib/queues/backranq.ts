import { QueueClient } from '@vercel/queue';

export const BACKRANQ_QUEUE_TOPIC = 'backranq-jobs';

export type BackranqQueueMessage =
    | { type: 'sync-all'; requestedAt: string }
    | { type: 'analysis-job'; jobId: string };

const queue = new QueueClient({ region: process.env.VERCEL_REGION ?? 'iad1' });

export const handleBackranqQueueCallback = queue.handleCallback;

function queueDisabled() {
    return (
        process.env.BACKRANQ_DISABLE_VERCEL_QUEUE === 'true' ||
        process.env.NODE_ENV === 'test'
    );
}

export async function publishBackranqQueueMessage(
    message: BackranqQueueMessage,
    opts?: { idempotencyKey?: string }
) {
    if (queueDisabled()) return { queued: false, messageId: null };

    try {
        const result = await queue.send(BACKRANQ_QUEUE_TOPIC, message, {
            idempotencyKey: opts?.idempotencyKey,
            retentionSeconds: 24 * 60 * 60,
        });
        return { queued: true, messageId: result.messageId };
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                '[backranq queue] falling back to DB-only execution:',
                error
            );
            return { queued: false, messageId: null };
        }
        throw error;
    }
}
