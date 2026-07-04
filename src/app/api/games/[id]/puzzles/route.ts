import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { validatePuzzleReplacementBody } from './validation';
import { replaceGamePuzzlesInTransaction } from '@/lib/api/puzzlePersistence';
import { providerToUi } from '@/lib/api/games';

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
        select: { id: true, provider: true, externalId: true },
    });
    if (!game)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });

    const normalizedGameId = `${providerToUi(game.provider)}:${game.externalId}`;
    if (
        validation.puzzles.some(
            (puzzle) => puzzle.sourceGameId !== normalizedGameId
        )
    ) {
        return NextResponse.json(
            { error: 'Puzzle game mismatch' },
            { status: 400 }
        );
    }

    // Idempotent: preserve stable puzzle rows by @@unique([gameId, sourcePly, fen])
    // so existing PuzzleAttempt history survives regeneration.
    const result = await prisma.$transaction(async (tx) => {
        const replacement = await replaceGamePuzzlesInTransaction({
            tx,
            userId,
            gameId: id,
            puzzles: validation.puzzles,
        });
        return {
            deleted: true,
            created: replacement.upserted,
            upserted: replacement.upserted,
            staleArchived: replacement.staleArchived,
        };
    });

    return NextResponse.json({ ok: true, ...result });
}
