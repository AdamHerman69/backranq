import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';

function normalizedSourcePgn(sourcePgn: string): string {
    return sourcePgn.replace(/\r\n?/g, '\n').trim();
}

export function hashSourcePgn(sourcePgn: string): string {
    return createHash('sha256')
        .update(`backranq-source-pgn\u0000${normalizedSourcePgn(sourcePgn)}`)
        .digest('hex');
}

export function isValidSourcePgn(sourcePgn: string): boolean {
    try {
        const chess = new Chess();
        chess.loadPgn(sourcePgn, { strict: false });
        return true;
    } catch {
        return false;
    }
}

/**
 * Returns the exact FEN before every source-game ply, followed by the final
 * position. This preserves clocks because they are relevant to draw rules.
 */
export function sourcePgnPositionFens(sourcePgn: string): string[] | null {
    try {
        const chess = new Chess();
        chess.loadPgn(sourcePgn, { strict: false });
        const history = chess.history({ verbose: true });
        if (history.length === 0) return [chess.fen()];
        return [...history.map((move) => move.before), chess.fen()];
    } catch {
        return null;
    }
}
