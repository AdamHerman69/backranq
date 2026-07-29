import {
    clearLastAnalysisCompletion,
    createServerAnalysisBatch,
    mergeServerAnalysisBatches,
    publishLibraryChanged,
    readServerAnalysisBatch,
    writeServerAnalysisBatch,
    type ServerAnalysisBatch,
} from '@/lib/analysis/analysisCompletion';
import type { EnqueueServerAnalysisJobsResult } from '@/lib/services/gameSync';

export function acceptedServerAnalysisJobIds(
    result: EnqueueServerAnalysisJobsResult
) {
    return Array.from(
        new Set(
            (result.jobs ?? [])
                .filter((job) => job.acceptedInBatch === true)
                .map((job) => job.id)
                .filter(Boolean)
        )
    );
}

export function registerServerAnalysisEnqueue(args: {
    ownerId: string;
    result: EnqueueServerAnalysisJobsResult;
    failedAtStart?: number;
    trainingMomentsAtStart?: number | null;
    pendingAtStart?: number | null;
}): ServerAnalysisBatch | null {
    if (!args.ownerId || args.result.queued <= 0) return null;

    const jobIds = acceptedServerAnalysisJobIds(args.result);
    if (jobIds.length === 0) return null;

    const incoming = createServerAnalysisBatch({
        ownerId: args.ownerId,
        queued: jobIds.length,
        jobIds,
        failedAtStart: args.failedAtStart ?? 0,
        trainingMomentsAtStart: args.trainingMomentsAtStart ?? null,
        pendingAtStart: args.pendingAtStart ?? null,
    });
    const merged = mergeServerAnalysisBatches(
        readServerAnalysisBatch(args.ownerId),
        incoming
    );
    writeServerAnalysisBatch(args.ownerId, merged);
    clearLastAnalysisCompletion(args.ownerId);
    publishLibraryChanged(args.ownerId, { invalidateCompletion: true });
    return merged;
}
