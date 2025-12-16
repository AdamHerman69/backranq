'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AppNav } from '@/components/nav/AppNav';
import { GameViewer } from '@/components/games/GameViewer';
import { GameActions } from '@/components/games/GameActions';
import { GamePuzzlesPreview, type GamePuzzleRow } from '@/components/games/GamePuzzlesPreview';
import { GameHeader, type GameHeaderData } from '@/components/games/GameHeader';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';

export function GameDetailClient({
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AppNav />
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <Link href="/games">← Back to Games</Link>
            </div>

            <GameHeader game={{ ...header, accuracy: { white: analysis?.whiteAccuracy, black: analysis?.blackAccuracy } }} />

            <div style={{ border: '1px solid var(--border, #e6e6e6)', borderRadius: 12, padding: 12 }}>
                <GameActions
                    dbGameId={dbGameId}
                    normalizedGame={normalizedGame}
                    usernameByProvider={usernameByProvider}
                    hasAnalysis={!!analysis}
                    onAnalysisSaved={(a) => setAnalysis(a)}
                />
            </div>

            <div style={{ border: '1px solid var(--border, #e6e6e6)', borderRadius: 12, padding: 12 }}>
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
            </div>

            <div style={{ border: '1px solid var(--border, #e6e6e6)', borderRadius: 12, padding: 12 }}>
                <GamePuzzlesPreview puzzles={puzzles} />
            </div>
        </div>
    );
}


