"use client";

import { useState } from 'react';
import Link from 'next/link';
import { GameViewer } from '@/components/games/GameViewer';
import { GameActions } from '@/components/games/GameActions';
import { GamePuzzlesPreview, type GamePuzzleRow } from '@/components/games/GamePuzzlesPreview';
import { GameHeader, type GameHeaderData } from '@/components/games/GameHeader';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export default function GameDetailClient({
    dbGameId,
    header,
    normalizedGame,
    initialAnalysis,
    puzzles,
    usernameByProvider,
}: {
    dbGameId: string;
    header: GameHeaderData;
    normalizedGame: NormalizedGame;
    initialAnalysis: GameAnalysis | null;
    puzzles: GamePuzzleRow[];
    usernameByProvider: { lichess?: string; chesscom?: string };
}) {
    const [analysis, setAnalysis] = useState<GameAnalysis | null>(initialAnalysis);

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
                    dbGameId={dbGameId}
                    normalizedGame={normalizedGame}
                    usernameByProvider={usernameByProvider}
                    hasAnalysis={!!analysis}
                    onAnalysisSaved={(a) => setAnalysis(a)}
                />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6">
                <GameViewer
                    pgn={normalizedGame.pgn}
                    metaLabel={`${normalizedGame.provider} • ${normalizedGame.timeClass} • ${new Date(normalizedGame.playedAt).toLocaleString()}`}
                    analysis={analysis}
                    puzzles={puzzles.map((p) => ({
                        sourcePly: p.sourcePly,
                        type: p.type,
                        bestMoveUci: p.bestMoveUci,
                    }))}
                />
                </CardContent>
            </Card>

            <Card>
                <CardContent className="pt-6">
                <GamePuzzlesPreview puzzles={puzzles} />
                </CardContent>
            </Card>
        </div>
    );
}

// Also provide a named export for convenience.
export { GameDetailClient };


