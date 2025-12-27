import type {
    NormalizedGame,
    NormalizedPlayer,
    TimeClass,
} from '@/lib/types/game';
import type { GameFetchFilters } from '@/lib/providers/filters';

function inRange(n: number | undefined, min?: number, max?: number) {
    if (n == null) return true;
    if (min != null && n < min) return false;
    if (max != null && n > max) return false;
    return true;
}

function escapeRegExp(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Best-effort PGN header parser for single tag values.
 * Example line: [Result "1-0"]
 */
export function getPgnHeaderTag(pgn: string, tag: string): string | undefined {
    if (!pgn) return undefined;
    const t = escapeRegExp(tag);
    // Allow optional leading whitespace/BOM; tolerate CRLF and trailing spaces.
    const re = new RegExp(`^\\s*\\[${t}\\s+"([^"]*)"\\]\\s*$`, 'mi');
    const m = pgn.match(re);
    const v = m?.[1]?.trim();
    return v ? v : undefined;
}

export function parsePgnSummary(pgn: string): {
    result?: string;
    termination?: string;
} {
    return {
        result: getPgnHeaderTag(pgn, 'Result'),
        termination: getPgnHeaderTag(pgn, 'Termination'),
    };
}

export function normalizeTimeClass(v: string | undefined | null): TimeClass {
    if (!v) return 'unknown';
    const s = v.toLowerCase();
    if (s === 'bullet') return 'bullet';
    if (s === 'blitz') return 'blitz';
    if (s === 'rapid') return 'rapid';
    if (s === 'classical') return 'classical';
    return 'unknown';
}

export function passesFilters(
    game: NormalizedGame,
    filters: GameFetchFilters
): boolean {
    // Time class filter: if array provided and non-empty, game must match one of them
    if (filters.timeClasses && filters.timeClasses.length > 0) {
        if (!filters.timeClasses.includes(game.timeClass)) {
            return false;
        }
    }
    if (
        filters.rated != null &&
        game.rated != null &&
        game.rated !== filters.rated
    ) {
        return false;
    }
    if (filters.since) {
        if (
            new Date(game.playedAt).getTime() <
            new Date(filters.since).getTime()
        )
            return false;
    }
    if (filters.until) {
        if (
            new Date(game.playedAt).getTime() >
            new Date(filters.until).getTime()
        )
            return false;
    }
    // Elo filtering is applied to both players' ratings (where present).
    if (!inRange(game.white.rating, filters.minElo, filters.maxElo))
        return false;
    if (!inRange(game.black.rating, filters.minElo, filters.maxElo))
        return false;
    return true;
}

export function player(name: string, rating?: number): NormalizedPlayer {
    return { name, rating };
}
