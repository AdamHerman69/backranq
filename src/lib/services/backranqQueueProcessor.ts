import type { BackranqQueueMessage } from '@/lib/queues/backranq';
import { syncLinkedAccounts } from '@/lib/services/autoSync';
import { analyzeGameJob } from '@/lib/services/serverAnalysis';

export async function processBackranqQueueMessage(message: BackranqQueueMessage) {
    if (message.type === 'sync-all') {
        return syncLinkedAccounts();
    }
    if (message.type === 'analysis-job') {
        return analyzeGameJob(message.jobId);
    }
    throw new Error('Unknown queue message');
}
