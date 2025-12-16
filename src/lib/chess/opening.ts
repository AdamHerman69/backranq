import { Chess } from 'chess.js';
import { ecoName } from '@/lib/chess/eco';

export type OpeningInfo = {
    eco?: string;
    name?: string;
    variation?: string;
    /**
     * Where the classification came from.
     * - pgn: PGN headers (ECO/Opening/Variation)
     * - guess: best-effort move-prefix match against a small built-in book
     * - unknown: could not determine
     */
    source: 'pgn' | 'guess' | 'unknown';
};

function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort PGN header tag parser for single tag values.
 * Example line: [Opening "Italian Game"]
 */
function getPgnHeaderTag(pgn: string, tag: string): string | undefined {
    if (!pgn) return undefined;
    const t = escapeRegExp(tag);
    const re = new RegExp(`^\\s*\\[${t}\\s+"([^"]*)"\\]\\s*$`, 'mi');
    const m = pgn.match(re);
    const v = m?.[1]?.trim();
    return v ? v : undefined;
}

type OpeningBookEntry = {
    eco: string;
    name: string;
    variation?: string;
    /** SAN sequence from the initial position */
    san: string[];
};

// Intentionally small starter book. Easy to extend over time.
// Notes:
// - Keep SAN exactly as chess.js produces (e.g. "Nf3", "Bb5", "O-O").
// - Longer lines should come after shorter siblings so "longest match wins" feels right.
const OPENING_BOOK: OpeningBookEntry[] = [
    // 1.e4 e5
    { eco: 'C20', name: "King's Pawn Game", san: ['e4', 'e5'] },
    { eco: 'C40', name: "King's Knight Opening", san: ['e4', 'e5', 'Nf3'] },
    {
        eco: 'C50',
        name: 'Italian Game',
        san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'],
    },
    {
        eco: 'C54',
        name: 'Italian Game',
        variation: 'Giuoco Piano',
        san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'],
    },
    { eco: 'C60', name: 'Ruy Lopez', san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'] },
    {
        eco: 'C70',
        name: 'Ruy Lopez',
        variation: 'Morphy Defense',
        san: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'],
    },
    // Sicilian
    { eco: 'B20', name: 'Sicilian Defense', san: ['e4', 'c5'] },
    // French / Caro / Scandi
    { eco: 'C00', name: 'French Defense', san: ['e4', 'e6'] },
    { eco: 'B10', name: 'Caro-Kann Defense', san: ['e4', 'c6'] },
    { eco: 'B01', name: 'Scandinavian Defense', san: ['e4', 'd5'] },
    // 1.d4
    { eco: 'D00', name: "Queen's Pawn Game", san: ['d4', 'd5'] },
    { eco: 'D06', name: "Queen's Gambit", san: ['d4', 'd5', 'c4'] },
    {
        eco: 'A40',
        name: "Queen's Pawn Game",
        variation: 'English Defense',
        san: ['d4', 'b6'],
    },
    // Indian defenses
    {
        eco: 'E60',
        name: "King's Indian Defense",
        san: ['d4', 'Nf6', 'c4', 'g6'],
    },
    {
        eco: 'E20',
        name: 'Nimzo-Indian Defense',
        san: ['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'],
    },
    // Flank
    { eco: 'A10', name: 'English Opening', san: ['c4'] },
];

function bestBookMatch(sanMoves: string[]): OpeningBookEntry | null {
    let best: OpeningBookEntry | null = null;
    for (const entry of OPENING_BOOK) {
        if (entry.san.length === 0) continue;
        if (entry.san.length > sanMoves.length) continue;
        let ok = true;
        for (let i = 0; i < entry.san.length; i++) {
            if (sanMoves[i] !== entry.san[i]) {
                ok = false;
                break;
            }
        }
        if (!ok) continue;
        if (!best || entry.san.length > best.san.length) best = entry;
    }
    return best;
}

export function classifyOpeningFromPgn(pgn: string): OpeningInfo {
    // 1) Prefer explicit PGN tags when present (lichess often provides these).
    const eco = getPgnHeaderTag(pgn, 'ECO');
    const name = getPgnHeaderTag(pgn, 'Opening') ?? ecoName(eco);
    const variation = getPgnHeaderTag(pgn, 'Variation');
    if (eco || name || variation) {
        return {
            eco: eco || undefined,
            name: name || undefined,
            variation: variation || undefined,
            source: 'pgn',
        };
    }

    // 2) Otherwise, best-effort guess from early move sequence.
    const c = new Chess();
    try {
        c.loadPgn(pgn, { strict: false });
    } catch {
        return { source: 'unknown' };
    }
    const sanMoves = c.history(); // SAN, from start position (or PGN SetUp/FEN if provided)
    const early = sanMoves.slice(0, 16); // enough to identify most common openings in a starter book
    const match = bestBookMatch(early);
    if (!match) return { source: 'unknown' };
    return {
        eco: match.eco,
        name: match.name,
        variation: match.variation,
        source: 'guess',
    };
}
