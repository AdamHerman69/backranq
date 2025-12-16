import type {
    Prisma,
    Puzzle as DbPuzzle,
    PuzzleAttempt,
    AnalyzedGame,
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

function toStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === 'string') as string[];
}

function toScore(v: unknown): UiPuzzle['score'] {
    if (!v || typeof v !== 'object') return null;
    const t = (v as any).type;
    const value = (v as any).value;
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
    const tags = Array.from(new Set([...(p.tags ?? []), `kind:${p.type}`]))
        .filter((t) => typeof t === 'string' && t.length > 0)
        .slice(0, 64);

    // The DB enum stores "mode" (avoid/punish). We infer from tags (the extractor adds these).
    const mode = tags.includes('punishBlunder')
        ? 'PUNISH_BLUNDER'
        : 'AVOID_BLUNDER';

    return {
        userId: args.userId,
        gameId: args.gameId,
        sourcePly: Math.max(0, Math.trunc(p.sourcePly)),
        fen: p.fen,
        type: mode,
        severity: p.severity ?? null,
        bestMoveUci: p.bestMoveUci,
        bestLine: p.bestLineUci as any,
        score: (p.score ?? null) as any,
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
    const tags = Array.isArray(row.tags) ? row.tags : [];
    const bestLineUci = toStringArray(row.bestLine);
    const score = toScore(row.score);
    const kind = inferKindFromTags(tags);

    return {
        id: row.id,
        type: kind,
        provider: providerToUi(row.game.provider),
        sourceGameId: row.gameId,
        sourcePly: row.sourcePly,
        playedAt: row.game.playedAt.toISOString(),
        fen: row.fen,
        sideToMove: (row.fen.split(' ')[1] === 'b' ? 'b' : 'w') as 'w' | 'b',
        bestLineUci,
        bestMoveUci: row.bestMoveUci,
        score,
        label: row.label ?? 'Find the best move',
        tags,
        opening: {
            eco: row.openingEco ?? undefined,
            name: row.openingName ?? undefined,
            variation: row.openingVariation ?? undefined,
            source: 'unknown',
        },
        severity: (row.severity as any) ?? undefined,
    };
}
