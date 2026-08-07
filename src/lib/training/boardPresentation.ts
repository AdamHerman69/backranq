import type { Square } from 'chess.js';

export type BoardArrowPresentation = {
    startSquare: Square;
    endSquare: Square;
    color: string;
};

export function bestMoveReviewArrows(
    moveUci: string | null | undefined
): BoardArrowPresentation[] {
    const move = moveUci?.trim().toLowerCase() ?? '';
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return [];
    return [
        {
            startSquare: move.slice(0, 2) as Square,
            endSquare: move.slice(2, 4) as Square,
            color: 'rgba(16, 185, 129, 0.82)',
        },
    ];
}
