import { Chess } from 'chess.js';

export function moveToUci(m: { from: string; to: string; promotion?: string }) {
    return `${m.from}${m.to}${m.promotion ?? ''}`;
}

export function parseUci(
    uci: string
): { from: string; to: string; promotion?: string } | null {
    const s = uci.trim();
    if (s.length < 4) return null;
    const from = s.slice(0, 2);
    const to = s.slice(2, 4);
    const promotion = s.length >= 5 ? s[4] : undefined;
    return { from, to, promotion };
}

export function extractStartFenFromPgn(pgn: string): string | null {
    const m = pgn.match(/^\[FEN\s+"([^"]+)"\]\s*$/m);
    return m?.[1] ?? null;
}

export function normalizeName(s: string) {
    return s.trim().toLowerCase();
}

export function sideToMoveFromFen(fen: string): 'w' | 'b' {
    const parts = fen.split(' ');
    return (parts[1] === 'b' ? 'b' : 'w') as 'w' | 'b';
}

export function prettyTurnFromFen(fen: string) {
    return sideToMoveFromFen(fen) === 'w' ? 'White to move' : 'Black to move';
}

export function applyUciLine(
    baseFen: string,
    uciLine: string[],
    maxPlies: number
) {
    const c = new Chess(baseFen);
    const applied: {
        fen: string;
        lastMove: { from: string; to: string } | null;
    }[] = [{ fen: c.fen(), lastMove: null }];
    for (let i = 0; i < Math.min(uciLine.length, maxPlies); i++) {
        const parsed = parseUci(uciLine[i]);
        if (!parsed) break;
        try {
            const mv = c.move({
                from: parsed.from,
                to: parsed.to,
                promotion: parsed.promotion,
            });
            if (!mv) break;
            applied.push({
                fen: c.fen(),
                lastMove: { from: mv.from, to: mv.to },
            });
        } catch {
            break;
        }
    }
    return applied;
}
