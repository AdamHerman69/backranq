import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { gameAnalysisToJson } from '@/lib/api/games';
import { Prisma } from '@prisma/client';

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
    const analysis = (await req
        .json()
        .catch(() => null)) as GameAnalysis | null;
    if (!analysis) {
        return NextResponse.json(
            { error: 'Missing analysis' },
            { status: 400 }
        );
    }

    const exists = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: { id: true },
    });
    if (!exists)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const game = await prisma.analyzedGame.update({
        where: { id },
        data: {
            analysis: gameAnalysisToJson(analysis) as Prisma.InputJsonValue,
            analyzedAt: new Date(),
        },
        select: { id: true, analyzedAt: true },
    });

    return NextResponse.json({ ok: true, game });
}

