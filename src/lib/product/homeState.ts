import type { AnalysisCompletionSummary } from '@/lib/analysis/analysisCompletion';

export type HomeProductState =
    | 'loading'
    | 'error'
    | 'sync-status-unavailable'
    | 'no-linked-account'
    | 'no-games'
    | 'unanalyzed'
    | 'analysis-blocked'
    | 'analysis-in-progress'
    | 'analyzed-with-training-moments'
    | 'analyzed-no-candidates'
    | 'failed';

export type HomeStateInput = {
    loading: boolean;
    error: string | null;
    linkedAccountKnown: boolean;
    hasLinkedAccount: boolean;
    gameCount: number;
    unanalyzedGameCount: number;
    trainingMomentCount: number;
    browserAnalysisRunning: boolean;
    serverQueued: number;
    serverRunning: number;
    serverFailed: number;
    analysisBlockedReason: string | null;
    lastCompletion: AnalysisCompletionSummary | null;
};

export function deriveHomeProductState(
    input: HomeStateInput
): HomeProductState {
    if (input.loading) return 'loading';
    // Practice remains available even if a secondary overview refresh fails.
    if (input.trainingMomentCount > 0) {
        return 'analyzed-with-training-moments';
    }
    if (input.error) return 'error';
    if (
        !input.linkedAccountKnown &&
        input.gameCount === 0 &&
        input.trainingMomentCount === 0
    ) {
        return 'sync-status-unavailable';
    }
    if (
        !input.hasLinkedAccount &&
        input.gameCount === 0 &&
        input.trainingMomentCount === 0
    ) {
        return 'no-linked-account';
    }
    if (input.gameCount === 0 && input.trainingMomentCount === 0) {
        return 'no-games';
    }
    // Existing positions always remain the user's clearest next action.
    // New imports, queued analysis or exhausted credits are useful secondary
    // status, but must not displace Practice.
    if (
        input.browserAnalysisRunning ||
        input.serverQueued > 0 ||
        input.serverRunning > 0
    ) {
        return 'analysis-in-progress';
    }
    if (
        input.unanalyzedGameCount > 0 &&
        (input.serverFailed > 0 ||
            (input.lastCompletion &&
                (input.lastCompletion.status === 'failed' ||
                    input.lastCompletion.status === 'partial') &&
                input.lastCompletion.pendingAtCompletion ===
                    input.unanalyzedGameCount))
    ) {
        return 'failed';
    }
    if (input.unanalyzedGameCount > 0 && input.analysisBlockedReason) {
        return 'analysis-blocked';
    }
    if (input.unanalyzedGameCount > 0) return 'unanalyzed';
    return 'analyzed-no-candidates';
}
