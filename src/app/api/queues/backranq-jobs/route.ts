import {
    handleBackranqQueueCallback,
    type BackranqQueueMessage,
} from '@/lib/queues/backranq';
import { processBackranqQueueMessage } from '@/lib/services/backranqQueueProcessor';

export const runtime = 'nodejs';
export const maxDuration = 300;

export const POST = handleBackranqQueueCallback<BackranqQueueMessage>(
    async (message, metadata) => {
        console.log(
            `[backranq queue] processing ${message.type} message=${metadata.messageId}`
        );
        await processBackranqQueueMessage(message);
    },
    {
        visibilityTimeoutSeconds: 300,
        retry: (_error, metadata) => {
            if (metadata.deliveryCount > 5) return { acknowledge: true };
            return {
                afterSeconds: Math.min(300, 2 ** metadata.deliveryCount * 10),
            };
        },
    }
);
