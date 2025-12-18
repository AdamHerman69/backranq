import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    aggregatePuzzleStats,
    dbToPuzzle,
    puzzleToDb,
} from '@/lib/api/puzzles';
import type { Puzzle as UiPuzzle } from '@/lib/analysis/puzzles';
import type { Prisma } from '@prisma/client';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function parseBool(v: string | null): boolean | null {
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
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
    const kind = url.searchParams.get('kind'); // blunder | missedWin | missedTactic
    const phase = url.searchParams.get('phase'); // opening | middlegame | endgame
    const gameId = url.searchParams.get('gameId');
    const opening = (url.searchParams.get('opening') ?? '').trim();
    const openingEcoParam = (url.searchParams.get('openingEco') ?? '').trim();
    const multiSolution = (url.searchParams.get('multiSolution') ?? '').trim(); // any | single | multi
    const solved = parseBool(url.searchParams.get('solved'));
    const failed = parseBool(url.searchParams.get('failed'));
    const tags = parseCsv(url.searchParams.get('tags'), 16);
    const openingEco = parseCsv(openingEcoParam, 32).map((s) =>
        s.toUpperCase()
    );

    const where: Prisma.PuzzleWhereInput = { userId };
    const and: Prisma.PuzzleWhereInput[] = [];

    if (type === 'avoidBlunder') where.type = 'AVOID_BLUNDER';
    if (type === 'punishBlunder') where.type = 'PUNISH_BLUNDER';
    if (kind === 'blunder') where.kind = 'BLUNDER';
    if (kind === 'missedWin') where.kind = 'MISSED_WIN';
    if (kind === 'missedTactic') where.kind = 'MISSED_TACTIC';
    if (phase === 'opening') where.phase = 'OPENING';
    if (phase === 'middlegame') where.phase = 'MIDDLEGAME';
    if (phase === 'endgame') where.phase = 'ENDGAME';
    if (gameId) where.gameId = gameId;

    if (multiSolution === 'multi') {
        const need = Array.from(new Set([...tags, 'multiSolution'])).slice(
            0,
            16
        );
        if (need.length > 0) where.tags = { hasEvery: need };
    } else if (tags.length > 0) {
        where.tags = { hasEvery: tags };
    }

    if (multiSolution === 'single') {
        and.push({ NOT: { tags: { has: 'multiSolution' } } });
    }

    if (openingEco.length > 0) {
        where.openingEco = { in: openingEco };
    } else if (opening) {
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
        and.push({ NOT: { attempts: { some: { userId, wasCorrect: true } } } });
    }

    if (and.length > 0) where.AND = and;

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
        const puzzle = dbToPuzzle(r as Parameters<typeof dbToPuzzle>[0]);
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

    // Upsert based on @@unique([gameId, sourcePly, fen])
    // Note: Prisma doesn't support "upsert many", so we do a transaction.
    let saved = 0;
    let duplicates = 0;
    await prisma.$transaction(async (tx) => {
        for (const p of filtered) {
            const exists = await tx.puzzle.findUnique({
                where: {
                    gameId_sourcePly_fen: {
                        gameId: p.gameId,
                        sourcePly: p.sourcePly,
                        fen: p.fen,
                    },
                },
                select: { id: true },
            });
            if (exists) duplicates += 1;
            else saved += 1;

            await tx.puzzle.upsert({
                where: {
                    gameId_sourcePly_fen: {
                        gameId: p.gameId,
                        sourcePly: p.sourcePly,
                        fen: p.fen,
                    },
                },
                create: p,
                update: {
                    // keep userId/gameId/sourcePly/fen stable, update content
                    type: p.type,
                    severity: p.severity,
                    bestMoveUci: p.bestMoveUci,
                    acceptedMovesUci: Array.isArray(p.acceptedMovesUci)
                        ? p.acceptedMovesUci
                        : [],
                    bestLine: p.bestLine,
                    score: p.score,
                    tags: p.tags,
                    openingEco: p.openingEco,
                    openingName: p.openingName,
                    openingVariation: p.openingVariation,
                    label: p.label,
                },
            });
        }
    });

    return NextResponse.json({ saved, duplicates });
}
