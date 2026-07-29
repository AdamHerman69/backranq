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
    usernameByProvider,
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
    usernameByProvider: { lichess?: string; chesscom?: string };
    initialPly?: number;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
}) {
    const [analysisState, setAnalysisState] = useState(() => ({
        analysis: initialHasAnalysis ? initialAnalysis : null,
        hasAnalysis: initialHasAnalysis,
    }));

    const { analysis, hasAnalysis } = analysisState;

    const userBoardOrientation = (() => {
        const providerKey = normalizedGame.provider;
        const linked =
            providerKey === 'lichess'
                ? usernameByProvider.lichess
                : usernameByProvider.chesscom;
        const norm = (s: string | undefined) =>
            (s ?? '')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9_]+/g, '');

        const me = norm(linked);
        if (!me) return 'white' as const;

        const white = norm(normalizedGame.white?.name);
        const black = norm(normalizedGame.black?.name);

        const matches = (a: string, b: string) =>
            !!a && !!b && (a === b || a.includes(b) || b.includes(a));

        if (matches(me, black)) return 'black' as const;
        if (matches(me, white)) return 'white' as const;
        return 'white' as const;
    })();

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
                    usernameByProvider={usernameByProvider}
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
