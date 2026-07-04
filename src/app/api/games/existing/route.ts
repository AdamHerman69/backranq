import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { providerToDb } from '@/lib/api/games';
import { isRecord, stringArrayValue } from '@/lib/api/validation';

export const runtime = 'nodejs';
const MAX_EXTERNAL_IDS = 200;

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as unknown;
    if (!isRecord(body)) {
        return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }

    const provider = body.provider;
    if (provider !== 'lichess' && provider !== 'chesscom') {
        return NextResponse.json(
            { error: 'Invalid provider' },
            { status: 400 }
        );
    }
    const parsedExternalIds = stringArrayValue(body.externalIds, 'externalIds', {
        maxItems: MAX_EXTERNAL_IDS,
        maxLength: 500,
        dedupe: true,
    });
    if (!parsedExternalIds.ok) {
        return NextResponse.json(
            { error: parsedExternalIds.error },
            { status: parsedExternalIds.status ?? 400 }
        );
    }
    const externalIds = parsedExternalIds.value;
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
