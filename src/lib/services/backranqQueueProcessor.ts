import type { BackranqQueueMessage } from '@/lib/queues/backranq';
import { analyzeGameJob } from '@/lib/services/serverAnalysis';
import { dispatchQueuedAnalysisJobs } from '@/lib/services/analysisScheduler';
import {
    dispatchPlannedSyncJobs,
    processSyncJob,
} from '@/lib/services/syncJobs';

export async function processBackranqQueueMessage(message: BackranqQueueMessage) {
    if (message.type === 'sync-all') {
        return dispatchPlannedSyncJobs();
    }
    if (message.type === 'sync-job') {
        const sync = await processSyncJob(message.jobId);
        const dispatch = await dispatchQueuedAnalysisJobs();
        return { sync, dispatch };
    }
    if (message.type === 'dispatch-analysis') {
        return dispatchQueuedAnalysisJobs();
    }
    if (message.type === 'analysis-job') {
        return analyzeGameJob(message.jobId);
    }
    throw new Error('Unknown queue message');
}
