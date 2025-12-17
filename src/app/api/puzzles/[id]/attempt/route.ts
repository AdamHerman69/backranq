import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { aggregatePuzzleStats } from '@/lib/api/puzzles';

export const runtime = 'nodejs';

function normalizeUci(s: string): string {
    return (s ?? '').trim().toLowerCase();
}

export async function POST(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const body = (await req.json().catch(() => null)) as {
        userMoveUci?: string;
        wasCorrect?: boolean;
        timeSpentMs?: number;
    } | null;

    const userMoveUci =
        typeof body?.userMoveUci === 'string' ? body.userMoveUci.trim() : '';
    const timeSpentMs =
        typeof body?.timeSpentMs === 'number' &&
        Number.isFinite(body.timeSpentMs)
            ? Math.max(0, Math.trunc(body.timeSpentMs))
            : null;

    if (!userMoveUci) {
        return NextResponse.json(
            { error: 'Missing userMoveUci' },
            { status: 400 }
        );
    }

    const puzzle = await prisma.puzzle.findFirst({
        where: { id, userId },
        select: { id: true, bestMoveUci: true, acceptedMovesUci: true },
    });
    if (!puzzle)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    // Compute correctness server-side (do not trust client).
    const move = normalizeUci(userMoveUci);
    const best = normalizeUci(puzzle.bestMoveUci);
    const accepted = new Set(
        [best, ...((puzzle.acceptedMovesUci ?? []) as any)]
            .map((s: any) => (typeof s === 'string' ? normalizeUci(s) : ''))
            .filter(Boolean)
    );
    const wasCorrect = accepted.has(move);

    await prisma.puzzleAttempt.create({
        data: {
            puzzleId: id,
            userId,
            userMoveUci: move,
            wasCorrect,
            timeSpentMs,
        },
    });

    const attempts = await prisma.puzzleAttempt.findMany({
        where: { puzzleId: id, userId },
        select: { wasCorrect: true, attemptedAt: true, timeSpentMs: true },
        orderBy: { attemptedAt: 'desc' },
    });

    const stats = aggregatePuzzleStats(attempts);
    return NextResponse.json({ ok: true, attemptStats: stats });
}
