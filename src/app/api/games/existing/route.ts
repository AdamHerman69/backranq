import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { providerToDb } from '@/lib/api/games';

export const runtime = 'nodejs';

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
        provider?: 'lichess' | 'chesscom';
        externalIds?: string[];
    };

    const provider = body.provider;
    const externalIds = Array.isArray(body.externalIds) ? body.externalIds : [];
    if (provider !== 'lichess' && provider !== 'chesscom') {
        return NextResponse.json(
            { error: 'Invalid provider' },
            { status: 400 }
        );
    }
    if (externalIds.length === 0) {
        return NextResponse.json({ existingExternalIds: [] });
    }

    const rows = await prisma.analyzedGame.findMany({
        where: {
            userId,
            provider: providerToDb(provider),
            externalId: { in: externalIds },
        },
        select: { externalId: true },
    });

    return NextResponse.json({
        existingExternalIds: rows.map((r) => r.externalId),
    });
}

