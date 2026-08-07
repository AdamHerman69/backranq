import { notFound, redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { dbGameToNormalized } from '@/lib/api/games';
import type { GameAnalysis } from '@/lib/analysis/classification';
import GameDetailClient from '@/components/games/GameDetailClient';
import { getManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import { GAME_TRAINING_MOMENT_MARKER_SELECT } from '@/lib/games/trainingMomentMarkers';

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

    const [trainingMoments, serverAnalysisCapacity] = await Promise.all([
        prisma.trainingMoment.findMany({
            where: {
                userId,
                gameId: id,
                archivedAt: null,
                status: 'ACTIVE',
                currentSolutionRevisionId: { not: null },
                currentSolutionRevision: {
                    is: {
                        trainable: true,
                        verificationStatus: {
                            in: ['VERIFIED', 'AMBIGUOUS'],
                        },
                    },
                },
            },
            orderBy: { decisionPly: 'asc' },
            select: GAME_TRAINING_MOMENT_MARKER_SELECT,
        }),
        getManualServerAnalysisCapacity(userId),
    ]);

    const normalized = dbGameToNormalized(game);
    const initialAnalysis =
        game.analyzedAt && game.analysis && typeof game.analysis === 'object'
            ? (game.analysis as unknown as GameAnalysis)
            : null;

    const sp = (await searchParams) ?? {};
    const plyRaw = typeof sp.ply === 'string' ? sp.ply : '';
    const initialPly = Number.isFinite(Number(plyRaw)) ? Math.max(0, Math.trunc(Number(plyRaw))) : undefined;

    return (
        <GameDetailClient
            key={game.analyzedAt?.toISOString() ?? 'not-analyzed'}
            ownerId={userId}
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
            initialHasAnalysis={game.analyzedAt !== null}
            initialPly={initialPly}
            trainingMoments={trainingMoments}
            serverAnalysisCapacity={serverAnalysisCapacity}
        />
    );
}
