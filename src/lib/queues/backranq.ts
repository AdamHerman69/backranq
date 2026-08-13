import { QueueClient } from '@vercel/queue';

export const BACKRANQ_QUEUE_TOPIC = 'backranq-jobs';

export type BackranqQueueMessage =
    | { type: 'runtime-smoke' }
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
    | { type: 'analysis-maintenance'; requestedAt: string }
    | { type: 'analysis-batch'; batchId: string }
    | { type: 'analysis-job'; jobId: string; dispatchToken: string }
    | { type: 'weekly-master-run'; runId: string }
    | {
          type: 'notification-delivery';
          deliveryId: string;
          dispatchToken: string;
      }
    | { type: 'notification-sweep'; requestedAt: string }
    | { type: 'practice-due-sweep'; sweepId: string }
    | {
          type: 'practice-due-notify';
          sweepId: string;
          afterUserId?: string;
      }
    | {
          type: 'notification-maintenance';
          referenceAt: string;
          since: string;
          analysisCursor?: string | null;
          syncCursor?: string | null;
          userCursor?: string | null;
          weeklyCursor?: string | null;
          practiceDueCursor?: string | null;
          practiceDueCleanupCursor?: string | null;
      };

export type BackranqQueuePublishResult = {
    queued: boolean;
    messageId: string | null;
    unavailableReason?: 'disabled' | 'publish-failed';
    error?: unknown;
};

function queueClient() {
    if (process.env.BACKRANQ_QUEUE_SMOKE_MODE !== 'true') {
        return new QueueClient({ region: process.env.VERCEL_REGION ?? 'iad1' });
    }
    if (process.env.VERCEL || process.env.VERCEL_ENV) {
        throw new Error('Queue smoke mode is forbidden in a Vercel environment.');
    }
    const value = process.env.BACKRANQ_QUEUE_SMOKE_BASE_URL;
    if (!value) throw new Error('Queue smoke mode requires a loopback base URL.');
    const baseUrl = new URL(value);
    if (
        baseUrl.protocol !== 'http:' ||
        !['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
    ) {
        throw new Error('Queue smoke mode only accepts an HTTP loopback base URL.');
    }
    return new QueueClient({
        region: 'iad1',
        token: 'backranq-local-queue-smoke',
        deploymentId: null,
        resolveBaseUrl: () => baseUrl,
    });
}

const queue = queueClient();

export const handleBackranqQueueCallback = queue.handleCallback;

function queueDisabled() {
    return (
        process.env.BACKRANQ_DISABLE_VERCEL_QUEUE === 'true' ||
        process.env.NODE_ENV === 'test'
    );
}

export async function publishBackranqQueueMessage(
    message: BackranqQueueMessage,
    opts?: {
        idempotencyKey?: string;
        delaySeconds?: number;
        retentionSeconds?: number;
    }
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
            retentionSeconds: opts?.retentionSeconds ?? 24 * 60 * 60,
            delaySeconds: opts?.delaySeconds,
        });
        return { queued: true, messageId: result.messageId };
    } catch (error) {
        console.warn(
            '[backranq queue] publish failed; durable work remains pending:',
            error instanceof Error ? error.message : String(error)
        );
        return {
            queued: false,
            messageId: null,
            unavailableReason: 'publish-failed',
            error,
        };
    }
}
