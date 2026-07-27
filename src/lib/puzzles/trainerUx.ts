export type PuzzleMoveFeedback = 'best' | 'accepted' | 'wrong';

function normalizeMove(move: string) {
    return (move ?? '').trim().toLowerCase();
}

export function classifyPuzzleMove(args: {
    move: string;
    bestMove: string;
    acceptedMoves: string[];
}): PuzzleMoveFeedback {
    const move = normalizeMove(args.move);
    const best = normalizeMove(args.bestMove);
    if (move && move === best) return 'best';
    const accepted = new Set(args.acceptedMoves.map(normalizeMove).filter(Boolean));
    return move && accepted.has(move) ? 'accepted' : 'wrong';
}

export function mayShowPuzzleContext(args: {
    preferenceEnabled: boolean;
    attempted: boolean;
    explicitContextFilter?: boolean;
}) {
    return (
        args.preferenceEnabled ||
        args.attempted ||
        args.explicitContextFilter === true
    );
}

export function legalPromotionChoices(
    moves: Array<{ from: string; to: string; promotion?: string }>,
    from: string,
    to: string
): Array<'q' | 'r' | 'b' | 'n'> {
    const allowed = new Set(['q', 'r', 'b', 'n']);
    return Array.from(
        new Set(
            moves
                .filter((move) => move.from === from && move.to === to)
                .map((move) => move.promotion?.toLowerCase())
                .filter(
                    (piece): piece is 'q' | 'r' | 'b' | 'n' =>
                        typeof piece === 'string' && allowed.has(piece)
                )
        )
    );
}

export function isStateForPuzzle(
    statePuzzleId: string | null | undefined,
    currentPuzzleId: string | null | undefined
) {
    return Boolean(
        statePuzzleId &&
            currentPuzzleId &&
            statePuzzleId === currentPuzzleId
    );
}

export function appendAnalysisBranch(args: {
    history: string[];
    historyIndex: number;
    displayedFen: string;
    nextFen: string;
}) {
    const safeIndex = Math.max(
        0,
        Math.min(args.historyIndex, Math.max(0, args.history.length - 1))
    );
    const currentHistoryFen = args.history[safeIndex];
    const base =
        currentHistoryFen === args.displayedFen
            ? args.history.slice(0, safeIndex + 1)
            : [args.displayedFen];
    return [...base, args.nextFen];
}

export function analysisHistoryStepLabel(args: {
    historyLength: number;
    historyIndex: number;
}) {
    if (args.historyLength > 1 && args.historyIndex === 0) {
        return 'Your analysis · branch point';
    }
    return `Your analysis · move ${Math.max(0, args.historyIndex)}`;
}
