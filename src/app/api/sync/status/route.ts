import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const [lichessLatest, chesscomLatest, user] = await Promise.all([
        prisma.analyzedGame.findFirst({
            where: { userId, provider: 'LICHESS' },
            orderBy: { playedAt: 'desc' },
            select: { playedAt: true },
        }),
        prisma.analyzedGame.findFirst({
            where: { userId, provider: 'CHESSCOM' },
            orderBy: { playedAt: 'desc' },
            select: { playedAt: true },
        }),
        prisma.user.findUnique({
            where: { id: userId },
            select: { lichessUsername: true, chesscomUsername: true },
        }),
    ]);

    return NextResponse.json({
        linked: {
            lichessUsername: user?.lichessUsername ?? null,
            chesscomUsername: user?.chesscomUsername ?? null,
        },
        lastSync: {
            lichess: lichessLatest?.playedAt?.toISOString() ?? null,
            chesscom: chesscomLatest?.playedAt?.toISOString() ?? null,
        },
    });
}

