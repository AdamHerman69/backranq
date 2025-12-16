import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { aggregatePuzzleStats, dbToPuzzle } from '@/lib/api/puzzles';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
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
    const excludeIdsParam = (url.searchParams.get('excludeIds') ?? '').trim();
    const preferFailed = url.searchParams.get('preferFailed') === 'true';
    const excludeIds = excludeIdsParam
        ? excludeIdsParam
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 200)
        : [];

    const baseWhere: any = { userId };
    if (type === 'avoidBlunder') baseWhere.type = 'AVOID_BLUNDER';
    if (type === 'punishBlunder') baseWhere.type = 'PUNISH_BLUNDER';
    if (excludeIds.length > 0) baseWhere.id = { notIn: excludeIds };

    // Buckets:
    // - failed: attempted, no correct
    // - unsolved: no correct (includes unattempted)
    // - solved: has correct
    const failedWhere = {
        ...baseWhere,
        attempts: { some: { userId } },
        NOT: { attempts: { some: { userId, wasCorrect: true } } },
    };
    const unsolvedWhere = {
        ...baseWhere,
        NOT: { attempts: { some: { userId, wasCorrect: true } } },
    };
    const unattemptedWhere = {
        ...baseWhere,
        attempts: { none: { userId } },
    };
    const solvedWhere = {
        ...baseWhere,
        attempts: { some: { userId, wasCorrect: true } },
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
            const puzzle = dbToPuzzle(r as any);
            const stats = aggregatePuzzleStats((r as any).attempts ?? []);
            return { ...puzzle, attemptStats: stats };
        });

    return NextResponse.json({ puzzles });
}
