import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { puzzleToDb } from '@/lib/api/puzzles';
import { validatePuzzleReplacementBody } from './validation';

export const runtime = 'nodejs';

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

    const validation = validatePuzzleReplacementBody(body);
    if (!validation.ok) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!game)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const cleaned = validation.puzzles.map((p) =>
        puzzleToDb({ puzzle: p, userId, gameId: id })
    );

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
