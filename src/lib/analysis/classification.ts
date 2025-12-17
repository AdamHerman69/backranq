import type { Score } from './stockfishClient';

/**
 * Move classification similar to chess.com game review.
 * Based on centipawn loss from the player's perspective.
 */
export type MoveClassification =
    | 'brilliant' // Sacrifice + deep tactic (!! symbol)
    | 'great' // Strong non-obvious move (! symbol)
    | 'best' // Engine's top choice
    | 'excellent' // Very close to best (<25cp loss)
    | 'good' // Solid move (25-50cp loss)
    | 'book' // Opening theory move
    | 'inaccuracy' // Small mistake (50-100cp loss, ?! symbol)
    | 'mistake' // Medium mistake (100-200cp loss, ? symbol)
    | 'blunder'; // Big mistake (200+cp loss, ?? symbol)

/**
 * Analysis data for a single move in a game.
 */
export type AnalyzedMove = {
    ply: number; // 0-based ply index
    san: string;
    uci: string;
    classification: MoveClassification;
    evalBefore: Score | null; // Eval before move (from side-to-move perspective)
    evalAfter: Score | null; // Eval after move (from side-to-move perspective)
    cpLoss: number; // Centipawn loss (positive = player lost eval)
    /**
     * Lichess-style move accuracy (0-100), derived from Win% drop.
     * Present only when we have evalBefore + evalAfter and the move wasn't excluded
     * from accuracy computation (e.g., forced move).
     */
    accuracy?: number;
    bestMoveUci?: string;
    bestMoveSan?: string;
    // Puzzle linkage
    hasPuzzle?: boolean;
    puzzleId?: string;
    puzzleType?: 'avoidBlunder' | 'punishBlunder';
};

/**
 * Full analysis of a game with move-by-move classifications.
 */
export type GameAnalysis = {
    gameId: string;
    moves: AnalyzedMove[];
    whiteAccuracy?: number; // Overall accuracy percentage (0-100)
    blackAccuracy?: number;
    analyzedAt: string; // ISO timestamp
};

/**
 * Classification thresholds in centipawns.
 */
export const CLASSIFICATION_THRESHOLDS = {
    excellent: 25,
    good: 50,
    inaccuracy: 100,
    mistake: 200,
    // Above mistake threshold = blunder
} as const;

/**
 * Get the symbol to display for a classification.
 */
export function getClassificationSymbol(
    classification: MoveClassification
): string {
    switch (classification) {
        case 'brilliant':
            return '!!';
        case 'great':
            return '!';
        case 'inaccuracy':
            return '?!';
        case 'mistake':
            return '?';
        case 'blunder':
            return '??';
        default:
            return '';
    }
}

/**
 * Get CSS class suffix for a classification.
 */
export function getClassificationClass(
    classification: MoveClassification
): string {
    return `move${classification.charAt(0).toUpperCase()}${classification.slice(
        1
    )}`;
}

/**
 * Convert a Score to centipawns for comparison.
 * Mate scores are converted to large values.
 */
export function scoreToCp(score: Score | null): number | null {
    if (!score) return null;
    if (score.type === 'cp') return score.value;
    // Mate: positive means side-to-move mates, negative means gets mated
    const sign = Math.sign(score.value || 1);
    return sign * 100000;
}

/**
 * Classify a move based on eval swing and context.
 */
export function classifyMove(args: {
    cpLoss: number; // Eval swing from player's perspective (positive = lost eval)
    isBestMove: boolean;
    isSacrifice?: boolean; // Material given up
    foundDeepTactic?: boolean; // Tactic >3 plies deep
    isBookMove?: boolean;
    wasAlreadyLost?: boolean; // Eval < -300 before move
}): MoveClassification {
    const {
        cpLoss,
        isBestMove,
        isSacrifice,
        foundDeepTactic,
        isBookMove,
        wasAlreadyLost,
    } = args;

    // Book moves from opening theory
    if (isBookMove) return 'book';

    // Brilliant: sacrifice that leads to deep winning tactic
    if (isBestMove && isSacrifice && foundDeepTactic) return 'brilliant';

    // Great: best move in complex position requiring deep calculation
    if (isBestMove && foundDeepTactic) return 'great';

    // Best move or gained eval
    if (cpLoss <= 0) return 'best';
    if (cpLoss <= 10) return 'best'; // Essentially best

    // Good moves
    if (cpLoss <= CLASSIFICATION_THRESHOLDS.excellent) return 'excellent';
    if (cpLoss <= CLASSIFICATION_THRESHOLDS.good) return 'good';

    // Don't penalize as heavily in already-lost positions
    if (wasAlreadyLost && cpLoss <= 150) return 'inaccuracy';

    // Mistakes
    if (cpLoss <= CLASSIFICATION_THRESHOLDS.inaccuracy) return 'inaccuracy';
    if (cpLoss <= CLASSIFICATION_THRESHOLDS.mistake) return 'mistake';

    return 'blunder';
}

/**
 * Convert centipawn evaluation to Lichess win probability (0-100).
 *
 * Lichess mapping:
 *   win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1)
 *
 * Where `cp` is from the player's perspective (positive = better for that player).
 */
export function lichessWinPercentFromCp(cp: number): number {
    const x = -0.00368208 * cp;
    const logistic = 1 / (1 + Math.exp(x)); // in (0,1)
    const centered = 2 * logistic - 1; // in (-1,1)
    return 50 + 50 * centered;
}

/**
 * Lichess move accuracy (0-100) from win% drop (deltaWin >= 0).
 *
 * Lichess mapping:
 *   acc = 103.1668 * exp(-0.04354 * deltaWin) - 3.1669
 */
export function lichessMoveAccuracyFromWinPercentDrop(
    deltaWin: number
): number {
    const acc = 103.1668 * Math.exp(-0.04354 * deltaWin) - 3.1669;
    return Math.max(0, Math.min(100, acc));
}

export function lichessMoveAccuracyFromCps(args: {
    beforeCp: number;
    afterCp: number;
}): {
    winPercentBefore: number;
    winPercentAfter: number;
    deltaWin: number;
    accuracy: number;
} {
    const winPercentBefore = lichessWinPercentFromCp(args.beforeCp);
    const winPercentAfter = lichessWinPercentFromCp(args.afterCp);
    const deltaWin = Math.max(0, winPercentBefore - winPercentAfter);
    return {
        winPercentBefore,
        winPercentAfter,
        deltaWin,
        accuracy: lichessMoveAccuracyFromWinPercentDrop(deltaWin),
    };
}

function harmonicMean(values: number[]): number | null {
    if (values.length === 0) return null;
    // Avoid division by zero; a single 0 should yield 0 overall.
    if (values.some((v) => v <= 0)) return 0;
    const denom = values.reduce((sum, v) => sum + 1 / v, 0);
    return values.length / denom;
}

function weightedMean(values: number[], weights: number[]): number | null {
    if (values.length === 0) return null;
    if (values.length !== weights.length) return null;
    let wSum = 0;
    let vwSum = 0;
    for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        const w = weights[i]!;
        if (!Number.isFinite(v) || !Number.isFinite(w) || w <= 0) continue;
        wSum += w;
        vwSum += v * w;
    }
    if (wSum <= 0) return null;
    return vwSum / wSum;
}

/**
 * Lichess game accuracy aggregates move accuracies by averaging:
 * - a (volatility-)weighted mean, and
 * - the harmonic mean
 *
 * If `weights` are omitted, uses equal weights (1 per move).
 */
export function lichessGameAccuracy(args: {
    moveAccuracies: number[];
    weights?: number[];
}): number | null {
    const moves = args.moveAccuracies.filter((x) => Number.isFinite(x));
    if (moves.length === 0) return null;

    const weights =
        args.weights && args.weights.length === args.moveAccuracies.length
            ? args.weights
            : moves.map(() => 1);

    const wMean = weightedMean(moves, weights);
    const hMean = harmonicMean(moves);
    if (wMean == null && hMean == null) return null;
    if (wMean == null) return hMean;
    if (hMean == null) return wMean;
    return (wMean + hMean) / 2;
}

/**
 * Check if a move involves a material sacrifice.
 * Simple heuristic: checks if the move gives up material that isn't immediately recaptured.
 */
export function isMaterialSacrifice(args: {
    evalBeforeCp: number;
    evalAfterCp: number;
    isCapture: boolean;
    pieceCaptured?: string; // e.g., 'q', 'r', 'b', 'n', 'p'
    pieceMoving?: string;
}): boolean {
    // A sacrifice is when you give up material but maintain or improve eval
    // This is a simplified check - real sacrifice detection is complex
    const { evalBeforeCp, evalAfterCp, isCapture } = args;

    // If eval improved or stayed same despite apparent material loss
    // This is a rough heuristic
    if (!isCapture) {
        // Non-capture that hangs a piece but eval stays good
        // Hard to detect without deeper analysis
        return false;
    }

    // For now, we mark as potential sacrifice if:
    // - Eval didn't drop much despite the move
    // - This is very simplified; real detection needs more context
    return evalAfterCp >= evalBeforeCp - 50;
}
