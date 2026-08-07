import { Chess } from 'chess.js';

export type SubmittedBoardMove = {
    moveUci: string;
    fenAfterMove: string;
};

export function legalMoveFromInput(
    fen: string,
    input: string
): SubmittedBoardMove | null {
    const notation = input.trim();
    if (!notation) return null;
    try {
        const chess = new Chess(fen);
        const normalized = notation.toLowerCase();
        const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)
            ? chess.move({
                  from: normalized.slice(0, 2),
                  to: normalized.slice(2, 4),
                  promotion: normalized.slice(4, 5) || undefined,
              })
            : chess.move(notation);
        if (!move) return null;
        return {
            moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
            fenAfterMove: chess.fen(),
        };
    } catch {
        return null;
    }
}
