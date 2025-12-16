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
 * Calculate accuracy percentage from average centipawn loss.
 * Formula similar to chess.com: accuracy decreases with cp loss.
 */
export function calculateAccuracy(avgCpLoss: number): number {
    // Using a formula that gives ~98% for 10cp loss, ~90% for 50cp, etc.
    // accuracy = 103.1668 * exp(-0.04354 * avgCpLoss) - 3.1669
    // Simplified: 100 - (avgCpLoss * 0.5) clamped to 0-100
    const accuracy = Math.max(
        0,
        Math.min(100, 103.1668 * Math.exp(-0.04354 * avgCpLoss) - 3.1669)
    );
    return Math.round(accuracy * 10) / 10; // Round to 1 decimal
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


