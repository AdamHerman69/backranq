import type { Puzzle as ExtractedPuzzle } from '@/lib/analysis/puzzles';

type PuzzleReplacementValidation =
    | { ok: true; puzzles: ExtractedPuzzle[] }
    | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
    return value === undefined || isStringArray(value);
}

function isPuzzleScore(value: unknown): value is ExtractedPuzzle['score'] {
    if (value === null) return true;
    if (!isObject(value)) return false;
    return (
        (value.type === 'cp' || value.type === 'mate') &&
        typeof value.value === 'number' &&
        Number.isFinite(value.value)
    );
}

function isOptionalEnum<T extends string>(
    value: unknown,
    allowed: readonly T[]
): value is T | undefined {
    return value === undefined || allowed.includes(value as T);
}

export function isExtractedPuzzle(value: unknown): value is ExtractedPuzzle {
    if (!isObject(value)) return false;

    return (
        isNonEmptyString(value.id) &&
        (value.type === 'blunder' ||
            value.type === 'missedWin' ||
            value.type === 'missedTactic') &&
        (value.mode === 'avoidBlunder' || value.mode === 'punishBlunder') &&
        (value.provider === 'lichess' || value.provider === 'chesscom') &&
        isNonEmptyString(value.sourceGameId) &&
        typeof value.sourcePly === 'number' &&
        Number.isFinite(value.sourcePly) &&
        value.sourcePly >= 0 &&
        isNonEmptyString(value.playedAt) &&
        isNonEmptyString(value.fen) &&
        (value.sideToMove === 'w' || value.sideToMove === 'b') &&
        isStringArray(value.bestLineUci) &&
        isNonEmptyString(value.bestMoveUci) &&
        isOptionalStringArray(value.acceptedMovesUci) &&
        isPuzzleScore(value.score) &&
        isNonEmptyString(value.label) &&
        isStringArray(value.tags) &&
        isOptionalEnum(value.severity, ['small', 'medium', 'big'] as const) &&
        isOptionalEnum(value.phase, ['opening', 'middlegame', 'endgame'] as const)
    );
}

export function validatePuzzleReplacementBody(
    body: unknown
): PuzzleReplacementValidation {
    if (!isObject(body) || !Array.isArray(body.puzzles)) {
        return { ok: false, error: 'Invalid puzzles' };
    }

    if (!body.puzzles.every(isExtractedPuzzle)) {
        return { ok: false, error: 'Invalid puzzles' };
    }

    return { ok: true, puzzles: body.puzzles };
}
