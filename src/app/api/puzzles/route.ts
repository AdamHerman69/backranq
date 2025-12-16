import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    aggregatePuzzleStats,
    dbToPuzzle,
    puzzleToDb,
} from '@/lib/api/puzzles';
import type { Puzzle as UiPuzzle } from '@/lib/analysis/puzzles';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function parseBool(v: string | null): boolean | null {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
}

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const page = clampInt(
        Number(url.searchParams.get('page') ?? '1') || 1,
        1,
        100_000
    );
    const limit = clampInt(
        Number(url.searchParams.get('limit') ?? '20') || 20,
        1,
        50
    );
    const type = url.searchParams.get('type'); // avoidBlunder | punishBlunder
    const gameId = url.searchParams.get('gameId');
    const opening = (url.searchParams.get('opening') ?? '').trim();
    const tagsParam = (url.searchParams.get('tags') ?? '').trim();
    const solved = parseBool(url.searchParams.get('solved'));
    const failed = parseBool(url.searchParams.get('failed'));

    const tags = tagsParam
        ? tagsParam
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
              .slice(0, 16)
        : [];

    const where: any = { userId };
    if (type === 'avoidBlunder') where.type = 'AVOID_BLUNDER';
    if (type === 'punishBlunder') where.type = 'PUNISH_BLUNDER';
    if (gameId) where.gameId = gameId;
    if (tags.length > 0) where.tags = { hasEvery: tags };
    if (opening) {
        where.OR = [
            { openingEco: { contains: opening, mode: 'insensitive' } },
            { openingName: { contains: opening, mode: 'insensitive' } },
            { openingVariation: { contains: opening, mode: 'insensitive' } },
        ];
    }

    // Attempt-based filters
    if (solved === true && failed === true) {
        where.attempts = { some: { userId } }; // attempted
    } else if (solved === true) {
        where.attempts = { some: { userId, wasCorrect: true } };
    } else if (failed === true) {
        where.attempts = { some: { userId } };
        where.NOT = { attempts: { some: { userId, wasCorrect: true } } };
    }

    const [total, rows] = await Promise.all([
        prisma.puzzle.count({ where }),
        prisma.puzzle.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
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
        }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const puzzles = rows.map((r) => {
        const puzzle = dbToPuzzle(r as any);
        const stats = aggregatePuzzleStats(r.attempts);
        return { ...puzzle, attemptStats: stats };
    });

    return NextResponse.json({ puzzles, total, page, totalPages });
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as {
        puzzles?: UiPuzzle[];
        gameId?: string;
    } | null;
    const puzzles = Array.isArray(body?.puzzles)
        ? (body?.puzzles as UiPuzzle[])
        : [];
    if (puzzles.length === 0) {
        return NextResponse.json({ saved: 0, duplicates: 0 });
    }

    // For this endpoint, we require db game ids (either in body.gameId or puzzle.sourceGameId).
    const data = puzzles.map((p) =>
        puzzleToDb({
            puzzle: p,
            userId,
            gameId: body?.gameId ?? p.sourceGameId,
        })
    );

    // Ensure all referenced games belong to the user (basic safety).
    const gameIds = Array.from(new Set(data.map((d) => d.gameId)));
    const owned = await prisma.analyzedGame.findMany({
        where: { id: { in: gameIds }, userId },
        select: { id: true },
    });
    const ownedSet = new Set(owned.map((g) => g.id));
    const filtered = data.filter((d) => ownedSet.has(d.gameId));

    const created = await prisma.puzzle.createMany({
        data: filtered,
        skipDuplicates: true,
    });

    const saved = created.count;
    const duplicates = Math.max(0, filtered.length - saved);
    return NextResponse.json({ saved, duplicates });
}
