import type { StockfishClient } from '@/lib/analysis/stockfishClient';

/** The search owns the engine until the matching practice revision claims it. */
export type PuzzleEngineHandoff = {
    revisionId: string;
    take(revisionId: string): StockfishClient | null;
    dispose(): void;
};
export function createPuzzleEngineHandoff(engine: StockfishClient, revisionId: string): PuzzleEngineHandoff {
    let owned: StockfishClient | null = engine;
    return {
        revisionId,
        take(requestedRevisionId) {
            if (requestedRevisionId !== revisionId) return null;
            const transferred = owned; owned = null; return transferred;
        },
        dispose() { owned?.terminate(); owned = null; },
    };
}
