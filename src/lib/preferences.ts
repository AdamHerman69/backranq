import type { TimeClass } from '@/lib/types/game';
import type { Puzzle } from '@/lib/analysis/puzzles';
import type { PuzzleMode } from '@/lib/analysis/extractPuzzles';

export type RatedFilter = 'any' | 'rated' | 'casual';

export type Filters = {
    lichessUsername: string;
    chesscomUsername: string;
    timeClass: TimeClass | 'any';
    rated: RatedFilter;
    since: string; // yyyy-mm-dd
    until: string; // yyyy-mm-dd
    minElo: string;
    maxElo: string;
    max: string;
};

export type PreferencesSchema = {
    filters: Filters;

    // puzzle library state
    puzzles: Puzzle[];
    puzzleIdx: number;
    puzzleTagFilter: string[];
    puzzleOpeningFilter: string;

    // extraction options
    puzzleMode: PuzzleMode;
    maxPuzzlesPerGame: string;
    blunderSwingCp: string;
    missedTacticSwingCp: string;
    evalBandMinCp: string;
    evalBandMaxCp: string;
    requireTactical: boolean;
    tacticalLookaheadPlies: string;
    openingSkipPlies: string;
    minPvMoves: string;
    skipTrivialEndgames: boolean;
    minNonKingPieces: string;
    confirmMovetimeMs: string;
    engineMoveTimeMs: string;
};

export type PartialPreferences = Partial<PreferencesSchema> & {
    filters?: Partial<Filters>;
};

export function defaultPreferences(): PreferencesSchema {
    return {
        filters: {
            lichessUsername: '',
            chesscomUsername: '',
            timeClass: 'any',
            rated: 'any',
            since: '',
            until: '',
            minElo: '',
            maxElo: '',
            max: '100',
        },
        puzzles: [],
        puzzleIdx: 0,
        puzzleTagFilter: [],
        puzzleOpeningFilter: '',
        puzzleMode: 'both',
        maxPuzzlesPerGame: '5',
        blunderSwingCp: '250',
        missedTacticSwingCp: '180',
        evalBandMinCp: '-300',
        evalBandMaxCp: '600',
        requireTactical: true,
        tacticalLookaheadPlies: '4',
        openingSkipPlies: '8',
        minPvMoves: '2',
        skipTrivialEndgames: true,
        minNonKingPieces: '4',
        confirmMovetimeMs: '',
        engineMoveTimeMs: '200',
    };
}

function dedupPuzzles(puzzles: Puzzle[]): Puzzle[] {
    const map = new Map<string, Puzzle>();
    for (const p of puzzles) {
        const k = `${p.sourceGameId}::${p.sourcePly}::${p.fen}`;
        if (!map.has(k)) map.set(k, p);
    }
    return Array.from(map.values());
}

export function mergePreferences(
    base: PreferencesSchema,
    patch: PartialPreferences
): PreferencesSchema {
    const merged: PreferencesSchema = {
        ...base,
        ...patch,
        filters: { ...base.filters, ...(patch.filters ?? {}) },
    };

    if (patch.puzzles) {
        merged.puzzles = dedupPuzzles(patch.puzzles);
    }

    // Clamp puzzleIdx if puzzles changed
    merged.puzzleIdx = Math.max(
        0,
        Math.min(
            merged.puzzleIdx ?? 0,
            Math.max(0, (merged.puzzles?.length ?? 0) - 1)
        )
    );

    return merged;
}

