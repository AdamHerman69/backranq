'use client';

import { useState } from 'react';
import Link from 'next/link';
import { GameViewer } from '@/components/games/GameViewer';
import { GameActions } from '@/components/games/GameActions';
import {
    GameTrainingMomentsPreview,
    type GameTrainingMomentRow,
} from '@/components/games/GameTrainingMomentsPreview';
import { GameHeader, type GameHeaderData } from '@/components/games/GameHeader';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { Button } from '@/components/ui/button';
import type { ManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';

export default function GameDetailClient({
    ownerId,
    dbGameId,
    header,
    normalizedGame,
    initialAnalysis,
    initialHasAnalysis,
    trainingMoments,
    initialPly,
    serverAnalysisCapacity,
}: {
    ownerId: string;
    dbGameId: string;
    header: GameHeaderData;
    normalizedGame: NormalizedGame;
    initialAnalysis: GameAnalysis | null;
    initialHasAnalysis: boolean;
    trainingMoments: GameTrainingMomentRow[];
    initialPly?: number;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
}) {
    const [analysisState, setAnalysisState] = useState(() => ({
        analysis: initialHasAnalysis ? initialAnalysis : null,
        hasAnalysis: initialHasAnalysis,
    }));

    const { analysis, hasAnalysis } = analysisState;

    const userBoardOrientation =
        normalizedGame.provenance?.userSide === 'black'
            ? ('black' as const)
            : normalizedGame.provenance?.userSide === 'white'
              ? ('white' as const)
              : undefined;
    const gameActions = (
        <GameActions
            ownerId={ownerId}
            dbGameId={dbGameId}
            normalizedGame={normalizedGame}
            hasAnalysis={hasAnalysis}
            trainingMomentCount={trainingMoments.length}
            serverAnalysisCapacity={serverAnalysisCapacity}
            onAnalysisSaved={(nextAnalysis) =>
                setAnalysisState({
                    analysis: nextAnalysis,
                    hasAnalysis: true,
                })
            }
        />
    );

    return (
        <div className="mx-auto max-w-[1480px] space-y-4 sm:space-y-6">
            <div className="flex items-center justify-between gap-3">
                <h1 className="font-display text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
                    Game review
                </h1>
                <Button asChild variant="outline" size="sm">
                    <Link href="/games">← Back to Games</Link>
                </Button>
            </div>
            <GameHeader game={{ ...header, accuracy: { white: analysis?.whiteAccuracy, black: analysis?.blackAccuracy } }} />

            {!hasAnalysis ? gameActions : null}

            <GameViewer
                pgn={normalizedGame.pgn}
                metaLabel={`${normalizedGame.provider} • ${normalizedGame.timeClass} • ${new Date(normalizedGame.playedAt).toLocaleString()}`}
                analysis={analysis}
                userBoardOrientation={userBoardOrientation}
                initialPly={initialPly}
                trainingMoments={trainingMoments.map((moment) => ({
                    decisionPly: moment.decisionPly,
                }))}
            />

            {hasAnalysis ? gameActions : null}

            <GameTrainingMomentsPreview
                trainingMoments={trainingMoments}
                gameId={dbGameId}
            />
        </div>
    );
}

// Also provide a named export for convenience.
export { GameDetailClient };
