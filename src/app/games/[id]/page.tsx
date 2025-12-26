import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { dbGameToNormalized } from '@/lib/api/games';
import type { GameAnalysis } from '@/lib/analysis/classification';
import GameDetailClient from '@/components/games/GameDetailClient';

export default async function GameDetailPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) redirect('/login?callbackUrl=/games');

    const { id } = await params;
    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
    });
    if (!game) notFound();

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { lichessUsername: true, chesscomUsername: true },
    });

    const puzzles = await prisma.puzzle.findMany({
        where: { userId, gameId: id },
        orderBy: { sourcePly: 'asc' },
        select: {
            id: true,
            sourcePly: true,
            type: true,
            bestMoveUci: true,
        },
    });

    const normalized = dbGameToNormalized(game);
    const initialAnalysis =
        game.analysis && typeof game.analysis === 'object'
            ? (game.analysis as unknown as GameAnalysis)
            : null;

    const sp = (await searchParams) ?? {};
    const plyRaw = typeof sp.ply === 'string' ? sp.ply : '';
    const initialPly = Number.isFinite(Number(plyRaw)) ? Math.max(0, Math.trunc(Number(plyRaw))) : undefined;

    return (
        <GameDetailClient
            dbGameId={game.id}
            header={{
                provider: game.provider,
                url: game.url,
                playedAt: game.playedAt.toISOString(),
                timeClass: game.timeClass,
                rated: game.rated,
                result: game.result,
                termination: game.termination,
                whiteName: game.whiteName,
                whiteRating: game.whiteRating,
                blackName: game.blackName,
                blackRating: game.blackRating,
                openingEco: game.openingEco,
                openingName: game.openingName,
                openingVariation: game.openingVariation,
                analyzedAt: game.analyzedAt ? game.analyzedAt.toISOString() : null,
            }}
            normalizedGame={normalized}
            initialAnalysis={initialAnalysis}
            initialPly={initialPly}
            puzzles={puzzles.map((p) => ({
                id: p.id,
                sourcePly: p.sourcePly,
                type: String(p.type),
                bestMoveUci: p.bestMoveUci,
            }))}
            usernameByProvider={{
                lichess: user?.lichessUsername ?? undefined,
                chesscom: user?.chesscomUsername ?? undefined,
            }}
        />
    );
}


