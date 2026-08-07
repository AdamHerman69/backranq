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
import { Card, CardContent } from '@/components/ui/card';
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

    return (
        <div className="space-y-6">
            <div>
                <Button asChild variant="outline" size="sm">
                    <Link href="/games">← Back to Games</Link>
                </Button>
            </div>
            <GameHeader game={{ ...header, accuracy: { white: analysis?.whiteAccuracy, black: analysis?.blackAccuracy } }} />

            <Card>
                <CardContent className="pt-6">
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
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6">
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
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6">
                <GameTrainingMomentsPreview
                    trainingMoments={trainingMoments}
                />
                </CardContent>
            </Card>
        </div>
    );
}

// Also provide a named export for convenience.
export { GameDetailClient };
