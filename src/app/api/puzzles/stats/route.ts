import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const [
        totalPuzzles,
        solvedPuzzles,
        attemptedPuzzles,
        totalAttempts,
        correctAttempts,
    ] = await Promise.all([
        prisma.puzzle.count({ where: { userId } }),
        prisma.puzzle.count({
            where: {
                userId,
                attempts: { some: { userId, wasCorrect: true } },
            },
        }),
        prisma.puzzle.count({
            where: { userId, attempts: { some: { userId } } },
        }),
        prisma.puzzleAttempt.count({ where: { userId } }),
        prisma.puzzleAttempt.count({ where: { userId, wasCorrect: true } }),
    ]);

    const failedPuzzles = Math.max(0, attemptedPuzzles - solvedPuzzles);
    const successRate =
        totalAttempts > 0 ? correctAttempts / totalAttempts : null;

    const byType = await prisma.puzzle.groupBy({
        by: ['type'],
        where: { userId },
        _count: { _all: true },
    });

    const openingGroups = await prisma.puzzle.groupBy({
        by: ['openingEco'],
        where: { userId, openingEco: { not: null } },
        _count: { _all: true },
    });
    const topOpenings = openingGroups
        .slice()
        .sort((a, b) => (b._count._all ?? 0) - (a._count._all ?? 0))
        .slice(0, 10);

    const recentAttempts = await prisma.puzzleAttempt.findMany({
        where: { userId },
        orderBy: { attemptedAt: 'desc' },
        take: 20,
        select: {
            id: true,
            attemptedAt: true,
            wasCorrect: true,
            timeSpentMs: true,
            puzzleId: true,
        },
    });

    return NextResponse.json({
        totals: {
            puzzles: totalPuzzles,
            attemptedPuzzles,
            solvedPuzzles,
            failedPuzzles,
            attempts: totalAttempts,
            correctAttempts,
            successRate,
        },
        breakdown: {
            byType: byType.map((r) => ({ type: r.type, count: r._count._all })),
            topOpenings: topOpenings
                .filter((r) => r.openingEco)
                .map((r) => ({ eco: r.openingEco, count: r._count._all ?? 0 })),
        },
        recentActivity: recentAttempts.map((a) => ({
            id: a.id,
            puzzleId: a.puzzleId,
            attemptedAt: a.attemptedAt.toISOString(),
            wasCorrect: a.wasCorrect,
            timeSpentMs: a.timeSpentMs,
        })),
    });
}
