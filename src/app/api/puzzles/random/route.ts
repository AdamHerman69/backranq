import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { aggregatePuzzleStats, dbToPuzzle } from '@/lib/api/puzzles';
import type { Prisma } from '@prisma/client';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function parseCsv(v: string | null, max: number): string[] {
    const s = (v ?? '').trim();
    if (!s) return [];
    return s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, max);
}

function parseBool(v: string | null): boolean | null {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
}

function shuffle<T>(arr: T[]) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const count = clampInt(
        Number(url.searchParams.get('count') ?? '1') || 1,
        1,
        20
    );
    const type = url.searchParams.get('type'); // avoidBlunder | punishBlunder
    const kind = url.searchParams.get('kind'); // blunder | missedWin | missedTactic
    const phase = url.searchParams.get('phase'); // opening | middlegame | endgame
    const gameId = (url.searchParams.get('gameId') ?? '').trim();
    const multiSolution = (url.searchParams.get('multiSolution') ?? '').trim(); // any | single | multi
    const openingEco = parseCsv(url.searchParams.get('openingEco'), 32).map(
        (s) => s.toUpperCase()
    );
    const tags = parseCsv(url.searchParams.get('tags'), 16);
    const solvedFilter = parseBool(url.searchParams.get('solved'));
    const failedFilter = parseBool(url.searchParams.get('failed'));
    const excludeIdsParam = (url.searchParams.get('excludeIds') ?? '').trim();
    const preferFailed = url.searchParams.get('preferFailed') === 'true';
    const excludeIds = excludeIdsParam
        ? excludeIdsParam
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 200)
        : [];

    const baseWhere: Prisma.PuzzleWhereInput = { userId };
    const and: Prisma.PuzzleWhereInput[] = [];
    if (type === 'avoidBlunder') baseWhere.type = 'AVOID_BLUNDER';
    if (type === 'punishBlunder') baseWhere.type = 'PUNISH_BLUNDER';
    if (kind === 'blunder') baseWhere.kind = 'BLUNDER';
    if (kind === 'missedWin') baseWhere.kind = 'MISSED_WIN';
    if (kind === 'missedTactic') baseWhere.kind = 'MISSED_TACTIC';
    if (phase === 'opening') baseWhere.phase = 'OPENING';
    if (phase === 'middlegame') baseWhere.phase = 'MIDDLEGAME';
    if (phase === 'endgame') baseWhere.phase = 'ENDGAME';
    if (gameId) baseWhere.gameId = gameId;
    if (openingEco.length > 0) baseWhere.openingEco = { in: openingEco };
    if (excludeIds.length > 0) baseWhere.id = { notIn: excludeIds };

    if (multiSolution === 'multi') {
        const need = Array.from(new Set([...tags, 'multiSolution'])).slice(
            0,
            16
        );
        if (need.length > 0) baseWhere.tags = { hasEvery: need };
    } else if (tags.length > 0) {
        baseWhere.tags = { hasEvery: tags };
    }
    if (multiSolution === 'single') {
        and.push({ NOT: { tags: { has: 'multiSolution' } } });
    }

    if (solvedFilter === true && failedFilter === true) {
        baseWhere.attempts = { some: { userId } }; // attempted
    } else if (solvedFilter === true) {
        baseWhere.attempts = { some: { userId, wasCorrect: true } };
    } else if (failedFilter === true) {
        baseWhere.attempts = { some: { userId } };
        and.push({ NOT: { attempts: { some: { userId, wasCorrect: true } } } });
    }

    if (and.length > 0) baseWhere.AND = and;

    // Buckets:
    // - failed: attempted, no correct
    // - unsolved: no correct (includes unattempted)
    // - solved: has correct
    const failedWhere: Prisma.PuzzleWhereInput = {
        AND: [
            baseWhere,
            {
                attempts: { some: { userId } },
                NOT: { attempts: { some: { userId, wasCorrect: true } } },
            },
        ],
    };
    const unsolvedWhere: Prisma.PuzzleWhereInput = {
        AND: [
            baseWhere,
            { NOT: { attempts: { some: { userId, wasCorrect: true } } } },
        ],
    };
    const unattemptedWhere: Prisma.PuzzleWhereInput = {
        AND: [baseWhere, { attempts: { none: { userId } } }],
    };
    const solvedWhere: Prisma.PuzzleWhereInput = {
        AND: [baseWhere, { attempts: { some: { userId, wasCorrect: true } } }],
    };

    // Pull a reasonably sized pool then sample in memory.
    const poolSize = 500;
    const [failed, unattempted, unsolved, solved] = await Promise.all([
        prisma.puzzle.findMany({
            where: failedWhere,
            select: { id: true },
            take: poolSize,
        }),
        prisma.puzzle.findMany({
            where: unattemptedWhere,
            select: { id: true },
            take: poolSize,
        }),
        prisma.puzzle.findMany({
            where: unsolvedWhere,
            select: { id: true },
            take: poolSize,
        }),
        prisma.puzzle.findMany({
            where: solvedWhere,
            select: { id: true },
            take: poolSize,
        }),
    ]);

    const failedIds = shuffle(failed.map((r) => r.id));
    const unattemptedIds = shuffle(unattempted.map((r) => r.id));
    const unsolvedIds = shuffle(
        unsolved.map((r) => r.id).filter((id) => !unattemptedIds.includes(id))
    );
    const solvedIds = shuffle(solved.map((r) => r.id));

    const picked: string[] = [];
    const pushFrom = (list: string[]) => {
        for (const id of list) {
            if (picked.length >= count) break;
            if (!picked.includes(id)) picked.push(id);
        }
    };

    if (preferFailed) {
        pushFrom(failedIds);
        pushFrom(unattemptedIds);
        pushFrom(unsolvedIds);
        pushFrom(solvedIds);
    } else {
        pushFrom(unattemptedIds);
        pushFrom(failedIds);
        pushFrom(unsolvedIds);
        pushFrom(solvedIds);
    }

    if (picked.length === 0) return NextResponse.json({ puzzles: [] });

    const rows = await prisma.puzzle.findMany({
        where: { userId, id: { in: picked } },
        include: {
            game: { select: { provider: true, playedAt: true } },
            attempts: {
                where: { userId },
                select: {
                    wasCorrect: true,
                    attemptedAt: true,
                    timeSpentMs: true,
                },
                orderBy: { attemptedAt: 'desc' },
            },
        },
    });

    // Keep the random order we picked
    const byId = new Map(rows.map((r) => [r.id, r]));
    const puzzles = picked
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((r) => {
            const row = r as NonNullable<typeof r>;
            const puzzle = dbToPuzzle(row as Parameters<typeof dbToPuzzle>[0]);
            const stats = aggregatePuzzleStats(row.attempts);
            return { ...puzzle, attemptStats: stats };
        });

    return NextResponse.json({ puzzles });
}
