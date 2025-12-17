import type { TimeClass } from '@/lib/types/game';
import type { Puzzle } from '@/lib/analysis/puzzles';
import type { ExtractOptions, PuzzleMode } from '@/lib/analysis/extractPuzzles';

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
    uniquenessMarginCp: string;
};

export type PartialPreferences = Partial<PreferencesSchema> & {
    filters?: Partial<Filters>;
};

export type AnalysisDefaults = Pick<
    PreferencesSchema,
    | 'puzzleMode'
    | 'engineMoveTimeMs'
    | 'openingSkipPlies'
    | 'minPvMoves'
    | 'skipTrivialEndgames'
    | 'minNonKingPieces'
    | 'evalBandMinCp'
    | 'evalBandMaxCp'
    | 'requireTactical'
    | 'tacticalLookaheadPlies'
    | 'maxPuzzlesPerGame'
    | 'blunderSwingCp'
    | 'missedTacticSwingCp'
    | 'confirmMovetimeMs'
    | 'uniquenessMarginCp'
>;

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
        uniquenessMarginCp: '',
    };
}

export function pickAnalysisDefaults(
    prefs: PreferencesSchema
): AnalysisDefaults {
    return {
        puzzleMode: prefs.puzzleMode,
        engineMoveTimeMs: prefs.engineMoveTimeMs,
        openingSkipPlies: prefs.openingSkipPlies,
        minPvMoves: prefs.minPvMoves,
        skipTrivialEndgames: prefs.skipTrivialEndgames,
        minNonKingPieces: prefs.minNonKingPieces,
        evalBandMinCp: prefs.evalBandMinCp,
        evalBandMaxCp: prefs.evalBandMaxCp,
        requireTactical: prefs.requireTactical,
        tacticalLookaheadPlies: prefs.tacticalLookaheadPlies,
        maxPuzzlesPerGame: prefs.maxPuzzlesPerGame,
        blunderSwingCp: prefs.blunderSwingCp,
        missedTacticSwingCp: prefs.missedTacticSwingCp,
        confirmMovetimeMs: prefs.confirmMovetimeMs,
        uniquenessMarginCp: prefs.uniquenessMarginCp,
    };
}

function parseFiniteNumber(s: string): number | null {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
}

function parseFiniteNumberOrDefault(s: string, fallback: number): number {
    const n = parseFiniteNumber(s);
    return n ?? fallback;
}

function parseOptionalFiniteNumber(s: string): number | null {
    const t = (s ?? '').trim();
    if (!t) return null;
    return parseFiniteNumber(t);
}

function parseOptionalPositiveNumber(s: string): number | null {
    const n = parseOptionalFiniteNumber(s);
    if (n == null) return null;
    return n > 0 ? n : null;
}

function parseMaxPuzzlesPerGame(s: string): number | null {
    const t = (s ?? '').trim();
    if (!t) return null; // blank = unlimited
    const n = Math.trunc(Number(t));
    if (!Number.isFinite(n)) return null;
    if (n <= 0) return null; // 0 or negative = unlimited
    return n;
}

export function analysisDefaultsToExtractOptions(
    a: AnalysisDefaults,
    opts?: { returnAnalysis?: boolean }
): ExtractOptions {
    return {
        movetimeMs: parseFiniteNumberOrDefault(a.engineMoveTimeMs, 200),
        puzzleMode: a.puzzleMode ?? 'both',
        maxPuzzlesPerGame: parseMaxPuzzlesPerGame(a.maxPuzzlesPerGame),
        blunderSwingCp: parseFiniteNumberOrDefault(a.blunderSwingCp, 250),
        missedTacticSwingCp: parseFiniteNumberOrDefault(
            a.missedTacticSwingCp,
            180
        ),
        evalBandMinCp: parseOptionalFiniteNumber(a.evalBandMinCp),
        evalBandMaxCp: parseOptionalFiniteNumber(a.evalBandMaxCp),
        requireTactical: !!a.requireTactical,
        tacticalLookaheadPlies: parseFiniteNumberOrDefault(
            a.tacticalLookaheadPlies,
            4
        ),
        openingSkipPlies: parseFiniteNumberOrDefault(a.openingSkipPlies, 8),
        minPvMoves: parseFiniteNumberOrDefault(a.minPvMoves, 2),
        skipTrivialEndgames: !!a.skipTrivialEndgames,
        minNonKingPieces: parseFiniteNumberOrDefault(a.minNonKingPieces, 4),
        confirmMovetimeMs: parseOptionalPositiveNumber(a.confirmMovetimeMs),
        uniquenessMarginCp: parseOptionalPositiveNumber(a.uniquenessMarginCp),
        returnAnalysis: opts?.returnAnalysis ?? false,
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
