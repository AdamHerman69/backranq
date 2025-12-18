import type {
    Prisma,
    Puzzle as DbPuzzle,
    PuzzleAttempt,
    AnalyzedGame,
    PuzzleKind,
    GamePhase,
} from '@prisma/client';
import type { Puzzle as UiPuzzle } from '@/lib/analysis/puzzles';

function providerToUi(p: AnalyzedGame['provider']): 'lichess' | 'chesscom' {
    return p === 'LICHESS' ? 'lichess' : 'chesscom';
}

function inferKindFromTags(tags: string[]): UiPuzzle['type'] {
    const kindTag = tags.find((t) => t.startsWith('kind:'));
    const kind = kindTag?.slice('kind:'.length);
    return kind === 'blunder' || kind === 'missedWin' || kind === 'missedTactic'
        ? kind
        : 'blunder';
}

function dbKindToUi(kind: PuzzleKind): UiPuzzle['type'] {
    if (kind === 'MISSED_WIN') return 'missedWin';
    if (kind === 'MISSED_TACTIC') return 'missedTactic';
    return 'blunder';
}

function uiKindToDb(kind: UiPuzzle['type']): PuzzleKind {
    if (kind === 'missedWin') return 'MISSED_WIN';
    if (kind === 'missedTactic') return 'MISSED_TACTIC';
    return 'BLUNDER';
}

function dbPhaseToUi(phase: GamePhase | null): UiPuzzle['phase'] | undefined {
    if (phase === 'OPENING') return 'opening';
    if (phase === 'MIDDLEGAME') return 'middlegame';
    if (phase === 'ENDGAME') return 'endgame';
    return undefined;
}

function uiPhaseToDb(phase: UiPuzzle['phase'] | undefined): GamePhase | null {
    if (phase === 'opening') return 'OPENING';
    if (phase === 'middlegame') return 'MIDDLEGAME';
    if (phase === 'endgame') return 'ENDGAME';
    return null;
}

function stripLegacyPseudoTags(tags: string[]): string[] {
    const out = tags.filter((t) => {
        if (!t) return false;
        if (t === 'avoidBlunder' || t === 'punishBlunder') return false;
        if (t.startsWith('kind:')) return false;
        if (t.startsWith('eco:')) return false;
        if (t.startsWith('opening:')) return false;
        if (t.startsWith('openingVar:')) return false;
        return true;
    });
    return out;
}

function toStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === 'string') as string[];
}

function normalizeUci(s: string): string {
    return (s ?? '').trim().toLowerCase();
}

function toScore(v: unknown): UiPuzzle['score'] {
    if (!v || typeof v !== 'object') return null;
    const obj = v as Record<string, unknown>;
    const t = obj.type;
    const value = obj.value;
    if (t !== 'cp' && t !== 'mate') return null;
    if (typeof value !== 'number') return null;
    return { type: t, value };
}

export type PuzzleAttemptStats = {
    attempted: number;
    correct: number;
    successRate: number | null;
    solved: boolean;
    failed: boolean;
    lastAttemptedAt: string | null;
    averageTimeMs: number | null;
};

export function aggregatePuzzleStats(
    attempts: Pick<
        PuzzleAttempt,
        'wasCorrect' | 'attemptedAt' | 'timeSpentMs'
    >[]
): PuzzleAttemptStats {
    const attempted = attempts.length;
    const correct = attempts.reduce((n, a) => n + (a.wasCorrect ? 1 : 0), 0);
    const solved = correct > 0;
    const failed = attempted > 0 && correct === 0;
    const successRate = attempted > 0 ? correct / attempted : null;
    const lastAttemptedAt =
        attempted > 0
            ? attempts
                  .slice()
                  .sort(
                      (a, b) =>
                          b.attemptedAt.getTime() - a.attemptedAt.getTime()
                  )[0]
                  ?.attemptedAt.toISOString() ?? null
            : null;
    const times = attempts
        .map((a) => a.timeSpentMs)
        .filter(
            (x): x is number =>
                typeof x === 'number' && Number.isFinite(x) && x >= 0
        );
    const averageTimeMs =
        times.length > 0
            ? times.reduce((a, b) => a + b, 0) / times.length
            : null;

    return {
        attempted,
        correct,
        successRate,
        solved,
        failed,
        lastAttemptedAt,
        averageTimeMs,
    };
}

export function puzzleToDb(args: {
    puzzle: UiPuzzle;
    userId: string;
    gameId: string;
}): Prisma.PuzzleCreateManyInput {
    const p = args.puzzle;
    const rawTags = Array.isArray(p.tags) ? p.tags : [];
    const tags = Array.from(
        new Set(
            stripLegacyPseudoTags(rawTags).filter(
                (t) => typeof t === 'string' && t.length > 0
            )
        )
    ).slice(0, 64);

    // The DB enum stores "mode" (avoid/punish). Prefer explicit field, fall back to legacy tags.
    const mode =
        p.mode === 'punishBlunder' || rawTags.includes('punishBlunder')
            ? 'PUNISH_BLUNDER'
            : 'AVOID_BLUNDER';

    const acceptedMovesUci = Array.from(
        new Set(
            [p.bestMoveUci, ...(p.acceptedMovesUci ?? [])]
                .map(normalizeUci)
                .filter(Boolean)
        )
    ).slice(0, 16);

    return {
        userId: args.userId,
        gameId: args.gameId,
        sourcePly: Math.max(0, Math.trunc(p.sourcePly)),
        fen: p.fen,
        type: mode,
        kind: uiKindToDb(p.type),
        phase: uiPhaseToDb(p.phase),
        severity: p.severity ?? null,
        bestMoveUci: p.bestMoveUci,
        acceptedMovesUci,
        bestLine: p.bestLineUci as unknown as Prisma.InputJsonValue,
        score: (p.score ?? null) as unknown as Prisma.InputJsonValue,
        tags,
        openingEco: p.opening?.eco ?? null,
        openingName: p.opening?.name ?? null,
        openingVariation: p.opening?.variation ?? null,
        label: p.label ?? null,
    };
}

export function dbToPuzzle(
    row: DbPuzzle & {
        game: Pick<AnalyzedGame, 'provider' | 'playedAt'>;
    }
): UiPuzzle {
    const rawTags = Array.isArray(row.tags) ? row.tags : [];
    const tags = stripLegacyPseudoTags(rawTags);
    const bestLineUci = toStringArray(row.bestLine);
    const score = toScore(row.score);
    const kind = row.kind ? dbKindToUi(row.kind) : inferKindFromTags(rawTags);
    const acceptedMovesUci = (row.acceptedMovesUci ?? [])
        .filter((s) => typeof s === 'string')
        .map(normalizeUci)
        .filter(Boolean);

    const severity =
        row.severity === 'small' ||
        row.severity === 'medium' ||
        row.severity === 'big'
            ? row.severity
            : undefined;

    return {
        id: row.id,
        type: kind,
        mode: row.type === 'PUNISH_BLUNDER' ? 'punishBlunder' : 'avoidBlunder',
        provider: providerToUi(row.game.provider),
        sourceGameId: row.gameId,
        sourcePly: row.sourcePly,
        playedAt: row.game.playedAt.toISOString(),
        fen: row.fen,
        sideToMove: (row.fen.split(' ')[1] === 'b' ? 'b' : 'w') as 'w' | 'b',
        bestLineUci,
        bestMoveUci: row.bestMoveUci,
        acceptedMovesUci,
        score,
        label: row.label ?? 'Find the best move',
        tags,
        opening: {
            eco: row.openingEco ?? undefined,
            name: row.openingName ?? undefined,
            variation: row.openingVariation ?? undefined,
            source: 'unknown',
        },
        severity,
        phase: dbPhaseToUi(row.phase ?? null),
    };
}
