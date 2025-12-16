import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { aggregatePuzzleStats, dbToPuzzle } from '@/lib/api/puzzles';

export const runtime = 'nodejs';

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const row = await prisma.puzzle.findFirst({
        where: { id, userId },
        include: {
            game: { select: { provider: true, playedAt: true } },
            attempts: {
                where: { userId },
                orderBy: { attemptedAt: 'desc' },
                select: {
                    id: true,
                    attemptedAt: true,
                    userMoveUci: true,
                    wasCorrect: true,
                    timeSpentMs: true,
                },
            },
        },
    });
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const puzzle = dbToPuzzle(row as any);
    const stats = aggregatePuzzleStats(
        row.attempts.map((a) => ({
            wasCorrect: a.wasCorrect,
            attemptedAt: a.attemptedAt,
            timeSpentMs: a.timeSpentMs,
        }))
    );

    return NextResponse.json({
        puzzle: { ...puzzle, attemptStats: stats },
        attempts: row.attempts.map((a) => ({
            id: a.id,
            attemptedAt: a.attemptedAt.toISOString(),
            userMoveUci: a.userMoveUci,
            wasCorrect: a.wasCorrect,
            timeSpentMs: a.timeSpentMs,
        })),
    });
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const exists = await prisma.puzzle.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!exists)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    await prisma.puzzle.delete({ where: { id } });
    return NextResponse.json({ ok: true });
}
