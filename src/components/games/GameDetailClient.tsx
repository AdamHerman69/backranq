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
    initialPly,
}: {
    dbGameId: string;
    header: GameHeaderData;
    normalizedGame: NormalizedGame;
    initialAnalysis: GameAnalysis | null;
    puzzles: GamePuzzleRow[];
    usernameByProvider: { lichess?: string; chesscom?: string };
    initialPly?: number;
}) {
    const [analysis, setAnalysis] = useState<GameAnalysis | null>(initialAnalysis);

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
                    userBoardOrientation={userBoardOrientation}
                    initialPly={initialPly}
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
                <GamePuzzlesPreview puzzles={puzzles} pgn={normalizedGame.pgn} />
                </CardContent>
            </Card>
        </div>
    );
}

// Also provide a named export for convenience.
export { GameDetailClient };


