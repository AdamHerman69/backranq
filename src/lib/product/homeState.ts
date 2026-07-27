import type { AnalysisCompletionSummary } from '@/lib/analysis/analysisCompletion';

export type HomeProductState =
    | 'loading'
    | 'error'
    | 'no-linked-account'
    | 'no-games'
    | 'unanalyzed'
    | 'analysis-in-progress'
    | 'analyzed-with-puzzles'
    | 'analyzed-no-candidates'
    | 'failed';

export type HomeStateInput = {
    loading: boolean;
    error: string | null;
    hasLinkedAccount: boolean;
    gameCount: number;
    unanalyzedGameCount: number;
    puzzleCount: number;
    browserAnalysisRunning: boolean;
    serverQueued: number;
    serverRunning: number;
    lastCompletion: AnalysisCompletionSummary | null;
};

export function deriveHomeProductState(
    input: HomeStateInput
): HomeProductState {
    if (input.loading) return 'loading';
    if (input.error) return 'error';
    if (
        !input.hasLinkedAccount &&
        input.gameCount === 0 &&
        input.puzzleCount === 0
    ) {
        return 'no-linked-account';
    }
    if (input.gameCount === 0 && input.puzzleCount === 0) return 'no-games';
    if (
        input.browserAnalysisRunning ||
        input.serverQueued > 0 ||
        input.serverRunning > 0
    ) {
        return 'analysis-in-progress';
    }
    if (
        input.lastCompletion &&
        (input.lastCompletion.status === 'failed' ||
            input.lastCompletion.status === 'partial') &&
        input.lastCompletion.pendingAtCompletion ===
            input.unanalyzedGameCount &&
        input.unanalyzedGameCount > 0
    ) {
        return 'failed';
    }
    if (input.unanalyzedGameCount > 0) return 'unanalyzed';
    if (input.puzzleCount > 0) return 'analyzed-with-puzzles';
    return 'analyzed-no-candidates';
}
