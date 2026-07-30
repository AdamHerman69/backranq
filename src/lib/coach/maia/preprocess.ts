import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';

export const MAIA_BOARD_SQUARES = 64;
export const MAIA_PIECE_CHANNELS = 12;
export const MAIA_MOVE_VOCABULARY_SIZE = 4_352;

const FILES = 'abcdefgh';
const PROMOTION_PIECES = ['q', 'r', 'b', 'n'] as const;
const PIECE_CHANNEL: Record<PieceSymbol, number> = {
    p: 0,
    n: 1,
    b: 2,
    r: 3,
    q: 4,
    k: 5,
};

export type MaiaLegalMove = {
    /** UCI in the actual, unmirrored position. */
    moveUci: string;
    /** Index in Maia's side-to-move-normalized 4,352-move policy. */
    modelIndex: number;
};

export type MaiaPositionInput = {
    tokens: Float32Array;
    legalMoves: MaiaLegalMove[];
    turn: Color;
};

function fileIndex(file: string): number {
    return FILES.indexOf(file);
}
function squareIndex(square: string): number {
    if (!/^[a-h][1-8]$/.test(square)) {
        throw new Error(`Invalid square: ${square}`);
    }
    return (Number(square[1]) - 1) * 8 + fileIndex(square[0]!);
}

export function mirrorSquare(square: string): string {
    if (!/^[a-h][1-8]$/.test(square)) {
        throw new Error(`Invalid square: ${square}`);
    }
    return `${square[0]}${9 - Number(square[1])}`;
}

export function mirrorUci(moveUci: string): string {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveUci)) {
        throw new Error(`Invalid UCI move: ${moveUci}`);
    }
    return `${mirrorSquare(moveUci.slice(0, 2))}${mirrorSquare(
        moveUci.slice(2, 4)
    )}${moveUci.slice(4)}`;
}

export function modelMoveToIndex(moveUci: string): number {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveUci)) {
        throw new Error(`Invalid Maia move: ${moveUci}`);
    }

    const promotion = moveUci[4];
    if (!promotion) {
        return (
            squareIndex(moveUci.slice(0, 2)) * 64 +
            squareIndex(moveUci.slice(2, 4))
        );
    }
    if (moveUci[1] !== '7' || moveUci[3] !== '8') {
        throw new Error(`Promotion is not normalized for Maia: ${moveUci}`);
    }

    const promotionIndex = PROMOTION_PIECES.indexOf(
        promotion as (typeof PROMOTION_PIECES)[number]
    );
    if (promotionIndex < 0) {
        throw new Error(`Unsupported promotion: ${moveUci}`);
    }
    const fromFile = fileIndex(moveUci[0]!);
    const toFile = fileIndex(moveUci[2]!);
    return 4_096 + (fromFile * 8 + toFile) * 4 + promotionIndex;
}

export function modelIndexToMove(index: number): string {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 4_352) {
        throw new Error(`Invalid Maia move index: ${index}`);
    }
    if (index < 4_096) {
        const from = Math.floor(index / 64);
        const to = index % 64;
        return `${FILES[from % 8]}${Math.floor(from / 8) + 1}${
            FILES[to % 8]
        }${Math.floor(to / 8) + 1}`;
    }
    const promotionIndex = index - 4_096;
    const filePair = Math.floor(promotionIndex / 4);
    return `${FILES[Math.floor(filePair / 8)]}7${FILES[filePair % 8]}8${
        PROMOTION_PIECES[promotionIndex % 4]
    }`;
}

function oppositeColor(color: Color): Color {
    return color === 'w' ? 'b' : 'w';
}

export function encodeMaiaBoard(chess: Chess): Float32Array {
    const turn = chess.turn();
    const tokens = new Float32Array(
        MAIA_BOARD_SQUARES * MAIA_PIECE_CHANNELS
    );

    for (let rank = 1; rank <= 8; rank += 1) {
        for (const file of FILES) {
            const actualSquare = `${file}${rank}` as Square;
            const piece = chess.get(actualSquare);
            if (!piece) continue;

            const normalizedRank = turn === 'b' ? 9 - rank : rank;
            const normalizedColor =
                turn === 'b' ? oppositeColor(piece.color) : piece.color;
            const normalizedSquare = `${file}${normalizedRank}`;
            const channel =
                PIECE_CHANNEL[piece.type] +
                (normalizedColor === 'b' ? 6 : 0);
            tokens[squareIndex(normalizedSquare) * 12 + channel] = 1;
        }
    }

    return tokens;
}

export function legalMaiaMoves(chess: Chess): MaiaLegalMove[] {
    const turn = chess.turn();
    return chess.moves({ verbose: true }).map((move) => {
        const canonicalUci = `${move.from}${move.to}${move.promotion ?? ''}`;
        const modelUci =
            turn === 'b' ? mirrorUci(canonicalUci) : canonicalUci;
        return {
            moveUci: canonicalUci,
            modelIndex: modelMoveToIndex(modelUci),
        };
    });
}

export function prepareMaiaPosition(fen: string): MaiaPositionInput {
    let chess: Chess;
    try {
        chess = new Chess(fen);
    } catch (error) {
        throw new Error('Invalid chess position.', { cause: error });
    }
    const legalMoves = legalMaiaMoves(chess);
    if (legalMoves.length === 0) {
        throw new Error('The position has no legal moves.');
    }
    return {
        tokens: encodeMaiaBoard(chess),
        legalMoves,
        turn: chess.turn(),
    };
}
