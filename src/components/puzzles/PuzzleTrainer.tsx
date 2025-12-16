'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import type { Puzzle } from '@/lib/analysis/puzzles';
import { PuzzlePanel } from '@/app/puzzle/PuzzlePanel';
import { useRandomPuzzles } from '@/lib/api/usePuzzles';
import type { NormalizedGame } from '@/lib/types/game';
import { Chess, type Move } from 'chess.js';
import { extractStartFenFromPgn, sideToMoveFromFen } from '@/lib/chess/utils';

export type TrainingMode = 'quick' | 'reviewFailed';

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
        playedAt: typeof game.playedAt === 'string' ? game.playedAt : new Date(game.playedAt).toISOString(),
        timeClass: timeClassToUi(game.timeClass),
        rated: typeof game.rated === 'boolean' ? game.rated : undefined,
        white: { name: String(game.whiteName ?? ''), rating: typeof game.whiteRating === 'number' ? game.whiteRating : undefined },
        black: { name: String(game.blackName ?? ''), rating: typeof game.blackRating === 'number' ? game.blackRating : undefined },
        result: typeof game.result === 'string' ? game.result : undefined,
        termination: typeof game.termination === 'string' ? game.termination : undefined,
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

    // undo-all to find starting FEN
    const startChess = new Chess();
    try {
        startChess.loadPgn(pgn, { strict: false });
        while (startChess.undo()) {}
        return { startFen: startChess.fen(), moves };
    } catch {
        return { startFen: new Chess().fen(), moves };
    }
}

export function PuzzleTrainer({ mode }: { mode: TrainingMode }) {
    const { getRandom, loading, error } = useRandomPuzzles();
    const engineRef = useRef<StockfishClient | null>(null);
    const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);

    const [queue, setQueue] = useState<Puzzle[]>([]);
    const [idx, setIdx] = useState(0);

    const currentPuzzle = queue[idx] ?? null;

    const preferFailed = mode === 'reviewFailed';

    const [sourceGame, setSourceGame] = useState<NormalizedGame | null>(null);
    const [sourceParsed, setSourceParsed] = useState<{ startFen: string; moves: Move[] } | null>(null);
    const [sourceLoading, setSourceLoading] = useState(false);
    const [sourceError, setSourceError] = useState<string | null>(null);

    async function fetchNext() {
        const excludeIds = queue.slice(-25).map((p) => p.id);
        const res = await getRandom({ count: 1, excludeIds, preferFailed });
        const p = res[0] as Puzzle | undefined;
        if (!p) return null;
        return p;
    }

    async function ensureOne() {
        if (queue.length > 0) return;
        const p = await fetchNext();
        if (p) setQueue([p]);
    }

    useEffect(() => {
        void ensureOne();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    useEffect(() => {
        return () => {
            engineRef.current?.terminate();
            engineRef.current = null;
        };
    }, []);

    // Always load the source game for the current puzzle (so "Game" tab is available).
    useEffect(() => {
        let cancelled = false;
        async function run() {
            if (!currentPuzzle?.sourceGameId) {
                setSourceGame(null);
                setSourceParsed(null);
                setSourceError(null);
                setSourceLoading(false);
                return;
            }
            setSourceLoading(true);
            setSourceError(null);
            try {
                const res = await fetch(`/api/games/${currentPuzzle.sourceGameId}`);
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
                setSourceError(e instanceof Error ? e.message : 'Failed to load source game');
            } finally {
                if (!cancelled) setSourceLoading(false);
            }
        }
        void run();
        return () => {
            cancelled = true;
        };
    }, [currentPuzzle?.sourceGameId]);

    const engineMoveTimeMs = '200';

    const header = useMemo(() => {
        return mode === 'reviewFailed' ? 'Review Failed' : 'Quick Play';
    }, [mode]);

    const orientation = useMemo(() => {
        if (!currentPuzzle) return 'white' as const;
        const stm = sideToMoveFromFen(currentPuzzle.fen);
        return stm === 'b' ? ('black' as const) : ('white' as const);
    }, [currentPuzzle]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 800 }}>
                    {header}
                    <span style={{ fontWeight: 600, opacity: 0.7, marginLeft: 10 }}>
                        {queue.length > 0 ? `Puzzle ${idx + 1}` : ''}
                    </span>
                </div>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <Link href="/puzzles/library" style={{ textDecoration: 'underline', fontWeight: 650 }}>
                        Browse library
                    </Link>
                    <button
                        type="button"
                        onClick={async () => {
                            const toastId = toast.loading('Loading next puzzle…');
                            try {
                                const next = await fetchNext();
                                if (!next) {
                                    toast.message('No puzzles available', { id: toastId });
                                    return;
                                }
                                setQueue((prev) => [...prev, next]);
                                setIdx((prev) => prev + 1);
                                toast.success('Ready', { id: toastId });
                            } catch (e) {
                                toast.error(e instanceof Error ? e.message : 'Failed to load', { id: toastId });
                            }
                        }}
                        style={{
                            height: 34,
                            padding: '0 12px',
                            borderRadius: 10,
                            border: '1px solid var(--border, #e6e6e6)',
                            background: 'transparent',
                            fontWeight: 700,
                            cursor: 'pointer',
                        }}
                        disabled={loading}
                    >
                        Next puzzle →
                    </button>
                </div>
            </div>

            {error ? <div style={{ color: '#b42318' }}>{error}</div> : null}
            {sourceError ? <div style={{ color: '#b42318' }}>{sourceError}</div> : null}
            {!currentPuzzle ? (
                <div style={{ opacity: 0.75 }}>Loading a puzzle…</div>
            ) : sourceLoading || !sourceGame || !sourceParsed ? (
                <div style={{ opacity: 0.75 }}>Loading source game…</div>
            ) : (
                <PuzzlePanel
                    puzzles={queue}
                    puzzleIdx={idx}
                    setPuzzleIdx={setIdx}
                    currentPuzzle={currentPuzzle}
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
                    engineMoveTimeMs={engineMoveTimeMs}
                    gameAnalysis={null}
                    allPuzzles={queue}
                />
            )}
        </div>
    );
}

