import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { Puzzle as ExtractedPuzzle } from '@/lib/analysis/puzzles';
import { puzzleToDb } from '@/lib/api/puzzles';

export const runtime = 'nodejs';

function isExtractedPuzzle(x: any): x is ExtractedPuzzle {
    return (
        x &&
        typeof x === 'object' &&
        typeof x.sourcePly === 'number' &&
        typeof x.fen === 'string' &&
        typeof x.bestMoveUci === 'string' &&
        Array.isArray(x.bestLineUci) &&
        Array.isArray(x.tags)
    );
}

export async function PUT(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
        puzzles?: unknown;
    } | null;

    const puzzles = Array.isArray(body?.puzzles) ? body?.puzzles : [];
    if (!Array.isArray(puzzles)) {
        return NextResponse.json({ error: 'Invalid puzzles' }, { status: 400 });
    }

    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!game)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const cleaned = puzzles
        .filter(isExtractedPuzzle)
        .map((p) => puzzleToDb({ puzzle: p, userId, gameId: id }));

    // Idempotent: replace puzzles for this game.
    const result = await prisma.$transaction(async (tx) => {
        await tx.puzzle.deleteMany({ where: { userId, gameId: id } });
        if (cleaned.length === 0) return { deleted: true, created: 0 };
        const created = await tx.puzzle.createMany({
            data: cleaned,
            skipDuplicates: true,
        });
        return { deleted: true, created: created.count };
    });

    return NextResponse.json({ ok: true, ...result });
}
