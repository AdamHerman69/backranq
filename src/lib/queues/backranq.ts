import { QueueClient } from '@vercel/queue';

export const BACKRANQ_QUEUE_TOPIC = 'backranq-jobs';

export type BackranqQueueMessage =
    | { type: 'sync-all'; requestedAt: string }
    | { type: 'sync-job'; jobId: string }
    | {
          type: 'reconcile-auto-analysis';
          userId: string;
          requestedAt: string;
          reason:
              | 'preferences'
              | 'billing'
              | 'capacity-release'
              | 'import'
              | 'scheduled';
          cursor?: {
              playedAt: string;
              id: string;
          };
      }
    | {
          type: 'reconcile-auto-analysis-sweep';
          requestedAt: string;
          cursor?: string;
      }
    | { type: 'dispatch-analysis'; requestedAt: string }
    | { type: 'analysis-job'; jobId: string; dispatchToken: string };

export type BackranqQueuePublishResult = {
    queued: boolean;
    messageId: string | null;
    unavailableReason?: 'disabled' | 'publish-failed';
    error?: unknown;
};

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
    opts?: { idempotencyKey?: string; delaySeconds?: number }
): Promise<BackranqQueuePublishResult> {
    if (queueDisabled()) {
        return {
            queued: false,
            messageId: null,
            unavailableReason: 'disabled',
        };
    }

    try {
        const result = await queue.send(BACKRANQ_QUEUE_TOPIC, message, {
            idempotencyKey: opts?.idempotencyKey,
            retentionSeconds: 24 * 60 * 60,
            delaySeconds: opts?.delaySeconds,
        });
        return { queued: true, messageId: result.messageId };
    } catch (error) {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                '[backranq queue] publish failed; work remains queued in the database:',
                error
            );
            return {
                queued: false,
                messageId: null,
                unavailableReason: 'publish-failed',
                error,
            };
        }
        throw error;
    }
}
