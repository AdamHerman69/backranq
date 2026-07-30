import type { Chess } from 'chess.js';

import type { EngineEvaluation } from '@/lib/coach/assessment';

export type CoachGameOutcome = {
    outcome: 'win' | 'draw' | 'loss';
    title: string;
    reason: string;
};

export function terminalEvaluation(
    chess: Chess
): EngineEvaluation | null {
    if (!chess.isGameOver()) return null;
    if (chess.isCheckmate()) {
        return {
            score: { type: 'mate', value: -1 },
            wdl: { win: 0, draw: 0, loss: 1_000 },
        };
    }
    return {
        score: { type: 'cp', value: 0 },
        wdl: { win: 0, draw: 1_000, loss: 0 },
    };
}

export function getCoachGameOutcome(
    chess: Chess,
    userColor: 'w' | 'b'
): CoachGameOutcome | null {
    if (!chess.isGameOver()) return null;
    if (chess.isCheckmate()) {
        const userWon = chess.turn() !== userColor;
        return {
            outcome: userWon ? 'win' : 'loss',
            title: userWon ? 'Checkmate — you won' : 'Checkmate — the bot won',
            reason: userWon
                ? 'You converted the game successfully.'
                : 'The game is over, but every caught mistake remains available in this session.',
        };
    }
    const reason = chess.isStalemate()
        ? 'Draw by stalemate.'
        : chess.isThreefoldRepetition()
          ? 'Draw by threefold repetition.'
          : chess.isInsufficientMaterial()
            ? 'Draw by insufficient material.'
            : 'The game ended in a draw.';
    return {
        outcome: 'draw',
        title: 'Draw',
        reason,
    };
}
