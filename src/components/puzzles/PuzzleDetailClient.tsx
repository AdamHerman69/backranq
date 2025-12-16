'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Puzzle } from '@/lib/analysis/puzzles';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { PuzzlePanel } from '@/app/puzzle/PuzzlePanel';
import type { NormalizedGame } from '@/lib/types/game';
import { Chess, type Move } from 'chess.js';
import { extractStartFenFromPgn, sideToMoveFromFen } from '@/lib/chess/utils';

function timeClassToUi(tc: string): NormalizedGame['timeClass'] {
    const t = (tc ?? '').toUpperCase();
    if (t === 'BULLET') return 'bullet';
    if (t === 'BLITZ') return 'blitz';
    if (t === 'RAPID') return 'rapid';
    if (t === 'CLASSICAL') return 'classical';
    return 'unknown';
}

function providerToUi(p: string): NormalizedGame['provider'] {
    return (p ?? '').toUpperCase() === 'CHESSCOM' ? 'chesscom' : 'lichess';
}

function dbGameToNormalizedLoose(game: any): NormalizedGame {
    return {
        id: String(game.id),
        provider: providerToUi(game.provider),
        url: game.url ?? undefined,
        playedAt:
            typeof game.playedAt === 'string'
                ? game.playedAt
                : new Date(game.playedAt).toISOString(),
        timeClass: timeClassToUi(game.timeClass),
        rated: typeof game.rated === 'boolean' ? game.rated : undefined,
        white: {
            name: String(game.whiteName ?? ''),
            rating:
                typeof game.whiteRating === 'number' ? game.whiteRating : undefined,
        },
        black: {
            name: String(game.blackName ?? ''),
            rating:
                typeof game.blackRating === 'number' ? game.blackRating : undefined,
        },
        result: typeof game.result === 'string' ? game.result : undefined,
        termination:
            typeof game.termination === 'string' ? game.termination : undefined,
        pgn: String(game.pgn ?? ''),
    };
}

function parseSourceGame(pgn: string): { startFen: string; moves: Move[] } | null {
    if (!pgn) return null;
    const chess = new Chess();
    try {
        chess.loadPgn(pgn, { strict: false });
    } catch {
        return null;
    }
    const moves = chess.history({ verbose: true }) as Move[];
    const fenTag = extractStartFenFromPgn(pgn);
    if (fenTag) return { startFen: fenTag, moves };

    const startChess = new Chess();
    try {
        startChess.loadPgn(pgn, { strict: false });
        while (startChess.undo()) {}
        return { startFen: startChess.fen(), moves };
    } catch {
        return { startFen: new Chess().fen(), moves };
    }
}

export function PuzzleDetailClient({ puzzle }: { puzzle: Puzzle }) {
    const engineRef = useRef<StockfishClient | null>(null);
    const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);
    const [sourceGame, setSourceGame] = useState<NormalizedGame | null>(null);
    const [sourceParsed, setSourceParsed] = useState<{ startFen: string; moves: Move[] } | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    useEffect(() => {
        return () => {
            engineRef.current?.terminate();
            engineRef.current = null;
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        async function run() {
            if (!puzzle?.sourceGameId) return;
            setLoading(true);
            setLoadError(null);
            try {
                const res = await fetch(`/api/games/${puzzle.sourceGameId}`);
                const json = (await res.json().catch(() => ({}))) as any;
                if (!res.ok) throw new Error(json?.error ?? 'Failed to load source game');
                const ng = dbGameToNormalizedLoose(json?.game);
                const parsed = parseSourceGame(ng.pgn);
                if (!parsed) throw new Error('Failed to parse source game PGN');
                if (cancelled) return;
                setSourceGame(ng);
                setSourceParsed(parsed);
            } catch (e) {
                if (cancelled) return;
                setSourceGame(null);
                setSourceParsed(null);
                setLoadError(e instanceof Error ? e.message : 'Failed to load source game');
            } finally {
                if (!cancelled) setLoading(false);
            }
        }
        void run();
        return () => {
            cancelled = true;
        };
    }, [puzzle?.sourceGameId]);

    const orientation = useMemo(() => {
        const stm = sideToMoveFromFen(puzzle.fen);
        return stm === 'b' ? ('black' as const) : ('white' as const);
    }, [puzzle.fen]);

    if (loading || !sourceGame || !sourceParsed) {
        return (
            <div style={{ opacity: 0.75 }}>
                {loadError ? loadError : 'Loading source game…'}
            </div>
        );
    }

    return (
        <PuzzlePanel
            puzzles={[puzzle]}
            puzzleIdx={0}
            setPuzzleIdx={() => {}}
            currentPuzzle={puzzle}
            puzzleSourceGame={sourceGame}
            puzzleSourceParsed={sourceParsed}
            userBoardOrientation={orientation}
            engineClient={engineClient}
            setEngineClient={(next) => {
                const value =
                    typeof next === 'function'
                        ? (next as any)(engineRef.current)
                        : next;
                engineRef.current = value;
                setEngineClient(value);
            }}
            engineMoveTimeMs="200"
            gameAnalysis={null}
            allPuzzles={[puzzle]}
        />
    );
}

