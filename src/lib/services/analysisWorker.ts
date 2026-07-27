import {
    claimNextAnalysisJobs,
    releaseAnalysisDispatchLocks,
    type ClaimNextAnalysisJobsOptions,
} from '@/lib/services/analysisScheduler';
import { analyzeGameJob } from '@/lib/services/serverAnalysis';

export type AnalysisWorkerJobResult = {
    jobId: string;
    ok: boolean;
    gameId?: string;
    puzzles?: number;
    error?: string;
};

export type AnalysisWorkerBatchResult = {
    claimedJobIds: string[];
    processed: AnalysisWorkerJobResult[];
    claimMisses: string[];
};

export async function runAnalysisWorkerBatch(
    options: ClaimNextAnalysisJobsOptions & {
        continueOnError?: boolean;
    } = {}
): Promise<AnalysisWorkerBatchResult> {
    const claim = await claimNextAnalysisJobs(options);
    const processed: AnalysisWorkerJobResult[] = [];
    const continueOnError = options.continueOnError ?? true;

    for (let index = 0; index < claim.claimedJobs.length; index += 1) {
        const job = claim.claimedJobs[index];
        try {
            const result = await analyzeGameJob(job.id);
            processed.push({
                jobId: job.id,
                ok: result.status == null || result.status === 'SUCCEEDED',
                gameId: result.gameId,
                puzzles: result.puzzles,
                ...(result.error ? { error: result.error } : {}),
            });
        } catch (error) {
            processed.push({
                jobId: job.id,
                ok: false,
                error:
                    error instanceof Error
                        ? error.message
                        : 'Analysis worker job failed',
            });
            if (!continueOnError) {
                await releaseAnalysisDispatchLocks(
                    claim.claimedJobs.slice(index + 1).map((item) => item.id)
                );
                throw error;
            }
        }
    }

    return {
        claimedJobIds: claim.claimedJobIds,
        processed,
        claimMisses: claim.claimMisses,
    };
}
