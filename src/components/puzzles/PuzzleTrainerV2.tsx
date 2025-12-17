'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Chess, type Move, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';

import type { NormalizedGame } from '@/lib/types/game';
import type { Puzzle } from '@/lib/analysis/puzzles';
import {
    StockfishClient,
    type MultiPvResult,
    type Score,
} from '@/lib/analysis/stockfishClient';
import { useRandomPuzzles } from '@/lib/api/usePuzzles';
import { usePuzzleAttempt } from '@/lib/hooks/usePuzzleAttempt';
import {
    applyUciLine,
    extractStartFenFromPgn,
    moveToUci,
    parseUci,
    prettyTurnFromFen,
    sideToMoveFromFen,
} from '@/lib/chess/utils';
import { ecoName } from '@/lib/chess/eco';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

type TrainerQueueMode = 'quick' | 'reviewFailed';
type TrainerViewMode = 'solve' | 'analyze';

type VerboseMove = Move;

type SourceParsed = { startFen: string; moves: VerboseMove[] };

type DbGameLoose = any;

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

function dbGameToNormalizedLoose(game: DbGameLoose): NormalizedGame {
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
                typeof game.whiteRating === 'number'
                    ? game.whiteRating
                    : undefined,
        },
        black: {
            name: String(game.blackName ?? ''),
            rating:
                typeof game.blackRating === 'number'
                    ? game.blackRating
                    : undefined,
        },
        result: typeof game.result === 'string' ? game.result : undefined,
        termination:
            typeof game.termination === 'string' ? game.termination : undefined,
        pgn: String(game.pgn ?? ''),
    };
}

function parseSourceGame(pgn: string): SourceParsed | null {
    if (!pgn) return null;
    const chess = new Chess();
    try {
        chess.loadPgn(pgn, { strict: false });
    } catch {
        return null;
    }
    const moves = chess.history({ verbose: true }) as VerboseMove[];
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

function formatEval(score: Score | null, fen: string): string {
    if (!score) return '—';
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const sign = turn === 'w' ? 1 : -1; // convert to White POV
    if (score.type === 'cp') {
        const v = (score.value / 100) * sign;
        const s = v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
        return s;
    }
    const mv = score.value * sign;
    return `#${mv}`;
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

function scoreToUnit(score: Score | null, fen: string): number {
    if (!score) return 0.5;
    const turn = fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const sign = turn === 'w' ? 1 : -1; // to White POV

    if (score.type === 'mate') {
        const mv = score.value * sign;
        return mv > 0 ? 1 : 0;
    }
    const cp = score.value * sign;
    const x = cp / 600;
    const t = Math.tanh(x);
    return 0.5 + 0.5 * t;
}

function isEditableTarget(el: EventTarget | null) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function findPuzzleLastMove(args: {
    puzzle: Puzzle;
    source: SourceParsed;
}): { from: Square; to: Square } | null {
    const { puzzle, source } = args;
    const c = new Chess(source.startFen);

    const max = Math.min(source.moves.length, Math.max(0, puzzle.sourcePly));
    let last: { from: Square; to: Square } | null = null;

    for (let i = 0; i < max; i++) {
        const m = source.moves[i];
        try {
            const mv = c.move({ from: m.from, to: m.to, promotion: (m as any).promotion });
            if (!mv) break;
            last = { from: mv.from as Square, to: mv.to as Square };
        } catch {
            break;
        }
    }

    // If we didn't land on the puzzle FEN, still return our best guess (last move before puzzle starts).
    return last;
}

function uciToArrow(uci: string): { from: Square; to: Square } | null {
    const p = parseUci(uci);
    if (!p) return null;
    return { from: p.from as Square, to: p.to as Square };
}

export function PuzzleTrainerV2({
    initialQueueMode,
    initialViewMode,
}: {
    initialQueueMode: TrainerQueueMode;
    initialViewMode: TrainerViewMode;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const sp = useSearchParams();

    const { getRandom, loading: loadingNext, error: randomError } = useRandomPuzzles();

    const engineRef = useRef<StockfishClient | null>(null);
    const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);

    const { startAttempt, recordAttempt, saving: attemptSaving, queued: attemptQueued } =
        usePuzzleAttempt();

    const [queueMode, setQueueMode] = useState<TrainerQueueMode>(initialQueueMode);
    const [viewMode, setViewMode] = useState<TrainerViewMode>(initialViewMode);

    const [queue, setQueue] = useState<Puzzle[]>([]);
    const [idx, setIdx] = useState(0);

    const currentPuzzle = queue[idx] ?? null;
    const preferFailed = queueMode === 'reviewFailed';

    const [sourceGame, setSourceGame] = useState<NormalizedGame | null>(null);
    const [sourceParsed, setSourceParsed] = useState<SourceParsed | null>(null);
    const [sourceLoading, setSourceLoading] = useState(false);
    const [sourceError, setSourceError] = useState<string | null>(null);

    const [attemptFen, setAttemptFen] = useState<string>(new Chess().fen());
    const [attemptLastMove, setAttemptLastMove] = useState<{ from: Square; to: Square } | null>(null);
    const [attemptUci, setAttemptUci] = useState<string | null>(null);
    const [attemptResult, setAttemptResult] = useState<'correct' | 'incorrect' | null>(null);
    const [showSolution, setShowSolution] = useState(false);

    // Context (pre-puzzle) navigation
    const [showContext, setShowContext] = useState(false);
    const [contextPly, setContextPly] = useState(0);

    const puzzlePly = useMemo(() => {
        if (!currentPuzzle) return 0;
        const raw = typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0;
        const max = sourceParsed?.moves.length ?? raw;
        return clamp(raw, 0, max);
    }, [currentPuzzle, sourceParsed?.moves.length]);

    const isOffPuzzlePosition =
        viewMode === 'solve' && showContext && contextPly !== puzzlePly;

    // PV browsing (Solve + Analyze)
    const [pvStep, setPvStep] = useState(0);

    // Analyze mode
    const [analysisRootFen, setAnalysisRootFen] = useState<string | null>(null);
    const [analysis, setAnalysis] = useState<MultiPvResult | null>(null);
    const [analysisBusy, setAnalysisBusy] = useState(false);
    const [analysisErr, setAnalysisErr] = useState<string | null>(null);
    const [selectedLine, setSelectedLine] = useState(0);
    const [refutationToast, setRefutationToast] = useState<string | null>(null);

    // Click-to-move hints
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [legalTargets, setLegalTargets] = useState<Set<Square>>(new Set());

    const engineMoveTimeMsSolve = 200;
    const engineMoveTimeMsAnalyze = 600;

    useEffect(() => {
        return () => {
            engineRef.current?.terminate();
            engineRef.current = null;
        };
    }, []);

    // keep URL in sync (view + queue)
    useEffect(() => {
        const next = new URLSearchParams(sp?.toString() ?? '');
        next.set('view', viewMode);
        next.set('mode', queueMode === 'reviewFailed' ? 'review' : 'quick');
        router.replace(`${pathname}?${next.toString()}`);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, queueMode]);

    async function fetchNextPuzzle() {
        const excludeIds = queue.slice(-25).map((p) => p.id);
        const res = await getRandom({ count: 1, excludeIds, preferFailed });
        const p = res[0] as Puzzle | undefined;
        return p ?? null;
    }

    async function ensureOne() {
        if (queue.length > 0) return;
        const p = await fetchNextPuzzle();
        if (p) {
            setQueue([p]);
            setIdx(0);
        }
    }

    // initial load + queueMode change
    useEffect(() => {
        void ensureOne();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [queueMode]);

    // reset per-puzzle state
    useEffect(() => {
        if (!currentPuzzle) return;
        setAttemptFen(currentPuzzle.fen);
        setAttemptLastMove(null);
        setAttemptUci(null);
        setAttemptResult(null);
        setShowSolution(false);
        setPvStep(0);
        setSelectedLine(0);
        setAnalysis(null);
        setAnalysisErr(null);
        setAnalysisBusy(false);
        setSelectedSquare(null);
        setLegalTargets(new Set());
        setShowContext(false);
        setContextPly(typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0);

        startAttempt(currentPuzzle.id);
        setAnalysisRootFen(currentPuzzle.fen);
    }, [currentPuzzle?.id, startAttempt]);

    // Always load source game
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
                if (!res.ok)
                    throw new Error(json?.error ?? 'Failed to load source game');
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
                setSourceError(
                    e instanceof Error ? e.message : 'Failed to load source game'
                );
            } finally {
                if (!cancelled) setSourceLoading(false);
            }
        }
        void run();
        return () => {
            cancelled = true;
        };
    }, [currentPuzzle?.sourceGameId]);

    const openingText = useMemo(() => {
        if (!currentPuzzle?.opening) return '';
        return ecoName(currentPuzzle.opening);
    }, [currentPuzzle?.opening]);

    const orientation = useMemo(() => {
        if (!currentPuzzle) return 'white' as const;
        const stm = sideToMoveFromFen(currentPuzzle.fen);
        return stm === 'b' ? ('black' as const) : ('white' as const);
    }, [currentPuzzle]);

    const puzzleLastMove = useMemo(() => {
        if (!currentPuzzle || !sourceParsed) return null;
        return findPuzzleLastMove({ puzzle: currentPuzzle, source: sourceParsed });
    }, [currentPuzzle, sourceParsed]);

    const isReviewState = !!attemptResult || showSolution;

    const solveExplorerLine = useMemo(() => {
        if (!currentPuzzle) return [] as string[];
        return currentPuzzle.bestLineUci;
    }, [currentPuzzle]);

    const solveLineApplied = useMemo(() => {
        if (!currentPuzzle) return [];
        return applyUciLine(currentPuzzle.fen, solveExplorerLine, 16);
    }, [currentPuzzle, solveExplorerLine]);

    const analyzeLineUci = useMemo(() => {
        const lines = analysis?.lines ?? [];
        const selected = lines[selectedLine] ?? lines[0];
        return selected?.pvUci ?? [];
    }, [analysis, selectedLine]);

    const analyzeApplied = useMemo(() => {
        if (!analysisRootFen) return [];
        return applyUciLine(analysisRootFen, analyzeLineUci, 24);
    }, [analysisRootFen, analyzeLineUci]);

    const displayFen = useMemo(() => {
        if (!currentPuzzle) return new Chess().fen();

        if (viewMode === 'solve') {
            if (showContext && sourceParsed) {
                const c = new Chess(sourceParsed.startFen);
                const plies = clamp(contextPly, 0, puzzlePly);
                for (let i = 0; i < plies; i++) {
                    const m = sourceParsed.moves[i];
                    try {
                        c.move({ from: m.from, to: m.to, promotion: (m as any).promotion });
                    } catch {
                        break;
                    }
                }
                return c.fen();
            }

            if (isReviewState) {
                const step = clamp(pvStep, 0, Math.max(0, solveLineApplied.length - 1));
                return solveLineApplied[step]?.fen ?? currentPuzzle.fen;
            }

            return attemptResult ? attemptFen : currentPuzzle.fen;
        }

        // analyze
        if (!analysisRootFen) return currentPuzzle.fen;
        const step = clamp(pvStep, 0, Math.max(0, analyzeApplied.length - 1));
        return analyzeApplied[step]?.fen ?? analysisRootFen;
    }, [
        currentPuzzle,
        viewMode,
        showContext,
        sourceParsed,
        contextPly,
        isReviewState,
        pvStep,
        solveLineApplied,
        attemptResult,
        attemptFen,
        analysisRootFen,
        analyzeApplied,
    ]);

    const allowMove = useMemo(() => {
        if (!currentPuzzle) return false;
        if (viewMode === 'solve') return !showContext && !isReviewState && !attemptResult;
        return true;
    }, [currentPuzzle, viewMode, showContext, isReviewState, attemptResult]);

    const evalScore = useMemo(() => {
        if (viewMode === 'solve') return currentPuzzle?.score ?? null;
        const line = analysis?.lines[selectedLine] ?? analysis?.lines[0];
        return line?.score ?? null;
    }, [viewMode, currentPuzzle?.score, analysis, selectedLine]);

    const evalText = useMemo(() => {
        return formatEval(evalScore, displayFen);
    }, [evalScore, displayFen]);

    const evalUnit = useMemo(() => {
        return scoreToUnit(evalScore, displayFen);
    }, [evalScore, displayFen]);

    const arrows = useMemo(() => {
        const byKey = new Map<
            string,
            { startSquare: Square; endSquare: Square; color: string }
        >();
        const put = (a: { startSquare: Square; endSquare: Square; color: string }) => {
            // react-chessboard internally keys arrows by `${from}-${to}`; dedupe to avoid React key collisions.
            byKey.set(`${a.startSquare}-${a.endSquare}`, a);
        };

        if (viewMode === 'solve') {
            const atPuzzlePosition = !showContext || contextPly === puzzlePly;
            if (puzzleLastMove && atPuzzlePosition) {
                put({
                    startSquare: puzzleLastMove.from,
                    endSquare: puzzleLastMove.to,
                    color: 'rgba(124,58,237,0.65)',
                });
            }
            if ((showSolution || attemptResult === 'correct') && currentPuzzle) {
                const a = uciToArrow(currentPuzzle.bestMoveUci);
                if (a) {
                    put({
                        startSquare: a.from,
                        endSquare: a.to,
                        color: 'rgba(16,185,129,0.75)',
                    });
                }
            }
            // Attempt arrow last so it wins if it matches bestMove/lastMove
            if (attemptLastMove) {
                put({
                    startSquare: attemptLastMove.from,
                    endSquare: attemptLastMove.to,
                    color:
                        attemptResult === 'incorrect'
                            ? 'rgba(220,38,38,0.85)'
                            : 'rgba(16,185,129,0.85)',
                });
            }
            return Array.from(byKey.values());
        }

        // analyze: one arrow per line's first move
        const lines = analysis?.lines ?? [];
        const colors = [
            'rgba(59,130,246,0.80)',
            'rgba(16,185,129,0.75)',
            'rgba(245,158,11,0.75)',
        ];
        // Add non-selected first, then selected last so it wins on duplicates.
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            if (i === selectedLine) continue;
            const first = lines[i]?.pvUci?.[0];
            const a = first ? uciToArrow(first) : null;
            if (!a) continue;
            put({
                startSquare: a.from,
                endSquare: a.to,
                color: colors[i]
                    .replace('0.80', '0.35')
                    .replace('0.75', '0.35'),
            });
        }
        if (selectedLine >= 0 && selectedLine < Math.min(3, lines.length)) {
            const first = lines[selectedLine]?.pvUci?.[0];
            const a = first ? uciToArrow(first) : null;
            if (a) {
                put({
                    startSquare: a.from,
                    endSquare: a.to,
                    color: colors[selectedLine] ?? 'rgba(59,130,246,0.80)',
                });
            }
        }
        return Array.from(byKey.values());
    }, [
        viewMode,
        showContext,
        contextPly,
        puzzlePly,
        puzzleLastMove,
        attemptLastMove,
        attemptResult,
        showSolution,
        currentPuzzle,
        analysis,
        selectedLine,
    ]);

    const squareStyles = useMemo(() => {
        const s: Record<string, React.CSSProperties> = {};
        const atPuzzlePosition = !showContext || contextPly === puzzlePly;
        if (puzzleLastMove && atPuzzlePosition) {
            s[puzzleLastMove.from] = { background: 'rgba(124,58,237,0.22)' };
            s[puzzleLastMove.to] = { background: 'rgba(124,58,237,0.30)' };
        }
        if (attemptLastMove) {
            const bad = attemptResult === 'incorrect';
            s[attemptLastMove.from] = {
                background: bad ? 'rgba(220,38,38,0.18)' : 'rgba(16,185,129,0.18)',
            };
            s[attemptLastMove.to] = {
                background: bad ? 'rgba(220,38,38,0.26)' : 'rgba(16,185,129,0.26)',
            };
        }
        if (selectedSquare) {
            s[selectedSquare] = { outline: '2px solid hsl(var(--ring))' };
        }
        for (const t of legalTargets) {
            if (!s[t]) s[t] = {};
            s[t] = {
                ...s[t],
                boxShadow: 'inset 0 0 0 2px rgba(124,58,237,0.35)',
            };
        }
        return s;
    }, [
        showContext,
        contextPly,
        puzzlePly,
        puzzleLastMove,
        attemptLastMove,
        attemptResult,
        selectedSquare,
        legalTargets,
    ]);

    function getMoveControllerFen() {
        if (viewMode === 'solve') return currentPuzzle?.fen ?? new Chess().fen();
        return analysisRootFen ?? currentPuzzle?.fen ?? new Chess().fen();
    }

    function clearHints() {
        setSelectedSquare(null);
        setLegalTargets(new Set());
    }

    function computeHints(square: Square) {
        if (!allowMove) return;
        const c = new Chess(displayFen);
        const moves = c.moves({ square, verbose: true }) as any[];
        const targets = new Set<Square>();
        for (const m of moves) targets.add(m.to as Square);
        setSelectedSquare(square);
        setLegalTargets(targets);
    }

    function tryMakeMove(args: { from: Square; to: Square; promotion?: string }) {
        const c = new Chess(displayFen);
        try {
            const mv = c.move({ from: args.from, to: args.to, promotion: args.promotion });
            if (!mv) return null;
        } catch {
            return null;
        }
        return { fen: c.fen(), uci: moveToUci(args), lastMove: { from: args.from, to: args.to } };
    }

    async function nextPuzzle() {
        const next = await fetchNextPuzzle();
        if (!next) return;
        setQueue((prev) => [...prev, next]);
        setIdx((prev) => prev + 1);
    }

    function resetSolve() {
        if (!currentPuzzle) return;
        setAttemptFen(currentPuzzle.fen);
        setAttemptLastMove(null);
        setAttemptUci(null);
        setAttemptResult(null);
        setShowSolution(false);
        setPvStep(0);
        clearHints();
        startAttempt(currentPuzzle.id);
    }

    async function runAnalyze(fen: string) {
        setAnalysisBusy(true);
        setAnalysisErr(null);
        try {
            const client = engineClient ?? new StockfishClient();
            if (!engineClient) {
                engineRef.current = client;
                setEngineClient(client);
            }
            const res = await client.analyzeMultiPv({
                fen,
                movetimeMs: engineMoveTimeMsAnalyze,
                multiPv: 3,
            });
            setAnalysis(res);
        } catch (e) {
            setAnalysisErr(e instanceof Error ? e.message : 'Engine error');
        } finally {
            setAnalysisBusy(false);
        }
    }

    // auto-run analysis when switching to analyze or when root changes
    useEffect(() => {
        if (viewMode !== 'analyze') return;
        if (!analysisRootFen) return;
        void runAnalyze(analysisRootFen);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [viewMode, analysisRootFen]);

    // record attempt after a solve move
    useEffect(() => {
        if (!currentPuzzle || !attemptUci || !attemptResult) return;
        void recordAttempt({
            puzzleId: currentPuzzle.id,
            move: attemptUci,
            correct: attemptResult === 'correct',
        });
    }, [currentPuzzle?.id, attemptUci, attemptResult, recordAttempt]);

    // Solve mode: on wrong move, briefly show Stockfish refutation PV.
    useEffect(() => {
        let cancelled = false;
        let t: number | null = null;
        async function run() {
            if (viewMode !== 'solve') return;
            if (!currentPuzzle) return;
            if (attemptResult !== 'incorrect') return;

            try {
                const client = engineClient ?? new StockfishClient();
                if (!engineClient) {
                    engineRef.current = client;
                    setEngineClient(client);
                }
                const res = await client.analyzeMultiPv({
                    fen: attemptFen,
                    movetimeMs: 250,
                    multiPv: 1,
                });
                const pv = res.lines?.[0]?.pvUci?.slice(0, 6) ?? [];
                if (cancelled) return;
                if (pv.length > 0) {
                    setRefutationToast(`Refutation: ${pv.join(' ')}`);
                    t = window.setTimeout(() => setRefutationToast(null), 1800);
                }
            } catch {
                // ignore
            }
        }
        void run();
        return () => {
            cancelled = true;
            if (t) window.clearTimeout(t);
        };
    }, [viewMode, currentPuzzle?.id, attemptResult, attemptFen, engineClient]);

    // keyboard shortcuts
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isEditableTarget(e.target)) return;
            if (!currentPuzzle) return;

            if (e.key === 'n') {
                e.preventDefault();
                void nextPuzzle();
                return;
            }
            if (e.key === 's') {
                e.preventDefault();
                if (viewMode === 'solve') setShowSolution(true);
                return;
            }
            if (e.key === 'r') {
                e.preventDefault();
                if (viewMode === 'solve') resetSolve();
                if (viewMode === 'analyze') {
                    setPvStep(0);
                    if (analysisRootFen) void runAnalyze(analysisRootFen);
                }
                return;
            }
            if (e.key === 'u') {
                // optional: undo in analyze sandbox (not full history yet)
                if (viewMode !== 'analyze') return;
                e.preventDefault();
                setPvStep((s) => Math.max(0, s - 1));
                return;
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (viewMode === 'solve') {
                    // In solve mode, arrow keys navigate context (prelude) when enabled.
                    // If context is not currently shown, ArrowLeft enters context one ply before the puzzle.
                    if (showContext && sourceParsed) {
                        setContextPly((p) => Math.max(0, p - 1));
                        return;
                    }
                    if (!isReviewState && sourceParsed) {
                        const start = Math.max(0, puzzlePly - 1);
                        setShowContext(true);
                        setContextPly(start);
                        return;
                    }
                    // Otherwise fall through to PV review navigation.
                }

                setPvStep((s) => Math.max(0, s - 1));
                return;
            }
            if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (viewMode === 'solve' && showContext && sourceParsed) {
                    setContextPly((p) => {
                        const next = Math.min(puzzlePly, p + 1);
                        if (next >= puzzlePly) {
                            // Arrived at puzzle position: snap back out of context.
                            setShowContext(false);
                        }
                        return next;
                    });
                    return;
                }
                const max =
                    viewMode === 'solve'
                        ? Math.max(0, solveLineApplied.length - 1)
                        : Math.max(0, analyzeApplied.length - 1);
                setPvStep((s) => Math.min(max, s + 1));
            }
        }

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [
        currentPuzzle,
        viewMode,
        isReviewState,
        showContext,
        puzzlePly,
        sourceParsed,
        solveLineApplied.length,
        analyzeApplied.length,
        analysisRootFen,
    ]);

    const topMeta = useMemo(() => {
        if (!currentPuzzle) return null;
        const parts: string[] = [];
        parts.push(currentPuzzle.type);
        if (openingText) parts.push(openingText);
        return parts.join(' • ');
    }, [currentPuzzle, openingText]);

    const rightPanel = (
        <div className="space-y-4">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Controls</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <Button onClick={() => void nextPuzzle()} disabled={loadingNext}>
                            Next (n)
                        </Button>
                        <Button variant="outline" onClick={() => void nextPuzzle()} disabled={loadingNext}>
                            Skip
                        </Button>
                    </div>

                    {viewMode === 'solve' ? (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button variant="outline" onClick={resetSolve}>
                                Reset (r)
                            </Button>
                            <Button variant="outline" onClick={() => setShowSolution(true)}>
                                Show solution (s)
                            </Button>
                            {attemptResult === 'incorrect' ? (
                                <Button onClick={resetSolve}>Try again</Button>
                            ) : null}
                        </div>
                    ) : (
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                variant="outline"
                                onClick={() => {
                                    setPvStep(0);
                                    if (analysisRootFen) void runAnalyze(analysisRootFen);
                                }}
                                disabled={analysisBusy || !analysisRootFen}
                            >
                                Re-evaluate
                            </Button>
                            <Button
                                variant="outline"
                                onClick={() => {
                                    if (!analysisRootFen) return;
                                    setAnalysisRootFen(displayFen);
                                    setPvStep(0);
                                }}
                            >
                                Set as root
                            </Button>
                        </div>
                    )}

                    <Separator />

                    <div className="space-y-1">
                        <div className="text-sm font-medium">Status</div>
                        <div className="text-sm text-muted-foreground">
                            {viewMode === 'solve' ? (
                                attemptResult ? (
                                    attemptResult === 'correct' ? (
                                        'Correct — review the line (←/→)'
                                    ) : (
                                        'Not best — try again'
                                    )
                                ) : (
                                    'Solve the best move'
                                )
                            ) : analysisBusy ? (
                                'Engine…'
                            ) : analysisErr ? (
                                analysisErr
                            ) : (
                                'Analyze with Stockfish'
                            )}
                        </div>
                        {attemptSaving || attemptQueued > 0 ? (
                            <div className="text-xs text-muted-foreground">
                                {attemptSaving ? 'Saving attempt…' : null}
                                {!attemptSaving && attemptQueued > 0
                                    ? `Attempts queued: ${attemptQueued}`
                                    : null}
                            </div>
                        ) : null}
                    </div>
                </CardContent>
            </Card>

            {viewMode === 'solve' ? (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Context</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                variant={showContext ? 'default' : 'outline'}
                                onClick={() => {
                                    setShowContext((v) => {
                                        const next = !v;
                                        if (next) setContextPly(puzzlePly);
                                        return next;
                                    });
                                }}
                                disabled={!sourceParsed}
                            >
                                {showContext ? 'Hide context' : 'Review context'}
                            </Button>
                            <Button asChild variant="outline">
                                <Link href="/puzzles/library">Library</Link>
                            </Button>
                        </div>

                        {showContext && sourceParsed ? (
                            <div className="space-y-3">
                                <div className="text-sm text-muted-foreground">
                                    Use ←/→ (or the buttons) to step back through the game.
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly(0)}
                                        disabled={contextPly === 0}
                                    >
                                        Start
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly((p) => Math.max(0, p - 1))}
                                        disabled={contextPly === 0}
                                    >
                                        Back
                                    </Button>
                                    <div className="text-sm text-muted-foreground">
                                        Ply {contextPly}/{puzzlePly}
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            setContextPly((p) =>
                                                Math.min(puzzlePly, p + 1)
                                            )
                                        }
                                        disabled={contextPly >= puzzlePly}
                                    >
                                        Next
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly(puzzlePly)}
                                        disabled={contextPly >= puzzlePly}
                                    >
                                        Puzzle
                                    </Button>
                                </div>
                            </div>
                        ) : null}
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Lines</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        {(analysis?.lines ?? []).slice(0, 3).map((l, i) => (
                            <button
                                key={i}
                                type="button"
                                onClick={() => {
                                    setSelectedLine(i);
                                    setPvStep(0);
                                }}
                                className={
                                    'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ' +
                                    (i === selectedLine
                                        ? 'bg-muted'
                                        : 'hover:bg-muted/50')
                                }
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <div className="font-medium">#{i + 1}</div>
                                    <div className="font-mono text-xs text-muted-foreground">
                                        {formatEval(l.score, analysis?.fen ?? displayFen)}
                                        {typeof l.depth === 'number' ? ` d${l.depth}` : ''}
                                    </div>
                                </div>
                                <div className="mt-1 font-mono text-xs text-muted-foreground">
                                    {(l.pvUci ?? []).slice(0, 6).join(' ')}
                                </div>
                            </button>
                        ))}

                        <Separator />

                        <div className="flex flex-wrap items-center gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPvStep(0)}
                                disabled={pvStep === 0}
                            >
                                Start
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPvStep((s) => Math.max(0, s - 1))}
                                disabled={pvStep === 0}
                            >
                                Back
                            </Button>
                            <div className="text-sm text-muted-foreground">
                                Step {pvStep}/{Math.max(0, analyzeApplied.length - 1)}
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    setPvStep((s) =>
                                        Math.min(analyzeApplied.length - 1, s + 1)
                                    )
                                }
                                disabled={pvStep >= analyzeApplied.length - 1}
                            >
                                Next
                            </Button>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setPvStep(analyzeApplied.length - 1)}
                                disabled={pvStep >= analyzeApplied.length - 1}
                            >
                                End
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Puzzle</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    <div className="text-sm text-muted-foreground">
                        {currentPuzzle ? topMeta : 'Loading…'}
                    </div>
                    {sourceGame ? (
                        <div className="text-xs text-muted-foreground">
                            {sourceGame.provider} • {sourceGame.white.name} vs {sourceGame.black.name}
                        </div>
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );

    if (randomError) {
        // Keep non-blocking (still usable if already loaded)
    }

    const header = (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                    <Tabs
                        value={viewMode}
                        onValueChange={(v) => {
                            if (v === 'solve' || v === 'analyze') {
                                setViewMode(v);
                                setPvStep(0);
                            }
                        }}
                    >
                        <TabsList>
                            <TabsTrigger value="solve">Solve</TabsTrigger>
                            <TabsTrigger value="analyze">Analyze</TabsTrigger>
                        </TabsList>
                    </Tabs>

                    <div className="hidden sm:flex items-center gap-2">
                        <Badge variant="secondary">
                            {queueMode === 'reviewFailed' ? 'Review Failed' : 'Quick'}
                        </Badge>
                        {currentPuzzle ? <Badge variant="outline">{currentPuzzle.type}</Badge> : null}
                        {openingText ? <Badge variant="outline">{openingText}</Badge> : null}
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <div className="text-sm text-muted-foreground">
                        {queue.length > 0 ? `Puzzle ${idx + 1}` : ''}
                    </div>
                    <Button
                        variant="outline"
                        onClick={() => setQueueMode((m) => (m === 'quick' ? 'reviewFailed' : 'quick'))}
                    >
                        Switch queue
                    </Button>
                </div>
            </div>

            <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                    <span className="font-mono">{prettyTurnFromFen(displayFen)}</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="hidden sm:block text-sm font-mono text-muted-foreground">{evalText}</div>
                    <div className="h-2 w-40 rounded-full bg-muted overflow-hidden">
                        <div
                            className="h-2 bg-foreground/70"
                            style={{ width: `${Math.round(evalUnit * 100)}%` }}
                        />
                    </div>
                </div>
            </div>
        </div>
    );

    if (!currentPuzzle) {
        return (
            <div className="space-y-4">
                {header}
                <div className="text-sm text-muted-foreground">Loading a puzzle…</div>
            </div>
        );
    }

    if (sourceLoading || !sourceGame || !sourceParsed) {
        return (
            <div className="space-y-4">
                {header}
                {sourceError ? (
                    <div className="text-sm text-red-600">{sourceError}</div>
                ) : (
                    <div className="text-sm text-muted-foreground">Loading source game…</div>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {header}

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="flex justify-center">
                    <div className="w-full max-w-[560px]">
                        {isOffPuzzlePosition ? (
                            <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-zinc-400 bg-muted/40 px-3 py-2">
                                <div className="text-sm text-muted-foreground">
                                    Reviewing context (not at puzzle position)
                                </div>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                        setContextPly(puzzlePly);
                                        setShowContext(false);
                                    }}
                                >
                                    Back to puzzle position
                                </Button>
                            </div>
                        ) : null}
                        <div
                            className={
                                'rounded-xl border bg-card p-3 ' +
                                (isOffPuzzlePosition ? 'border-zinc-400' : '')
                            }
                        >
                            <Chessboard
                                options={{
                                    position: displayFen,
                                    boardOrientation: orientation,
                                    allowDragging: allowMove,
                                    allowDrawingArrows: false,
                                    arrows,
                                    squareStyles,
                                    onPieceClick: ({ square }) => {
                                        if (!square) return;
                                        computeHints(square as Square);
                                    },
                                    onSquareClick: ({ piece, square }) => {
                                        if (!piece) return clearHints();
                                        computeHints(square as Square);
                                    },
                                    onPieceDrop: allowMove
                                        ? ({ sourceSquare, targetSquare, piece }) => {
                                              clearHints();
                                              if (!targetSquare) return false;
                                              const from = sourceSquare as Square;
                                              const to = targetSquare as Square;
                                              const pt = (piece?.pieceType ?? '').toLowerCase();
                                              const isPawn = pt.endsWith('p');
                                              const promotionRank = to[1] === '8' || to[1] === '1';
                                              const promotion = isPawn && promotionRank ? 'q' : undefined;

                                              const res = tryMakeMove({ from, to, promotion });
                                              if (!res) return false;

                                              if (viewMode === 'solve') {
                                                  setAttemptFen(res.fen);
                                                  setAttemptLastMove(res.lastMove);
                                                  setAttemptUci(res.uci);
                                                  setAttemptResult(
                                                      res.uci === currentPuzzle.bestMoveUci
                                                          ? 'correct'
                                                          : 'incorrect'
                                                  );
                                                  if (res.uci === currentPuzzle.bestMoveUci) {
                                                      setPvStep(0);
                                                  }
                                                  return true;
                                              }

                                              // analyze sandbox: update root and re-run analysis
                                              setAnalysisRootFen(res.fen);
                                              setPvStep(0);
                                              void runAnalyze(res.fen);
                                              return true;
                                          }
                                        : undefined,
                                }}
                            />
                        </div>

                        {viewMode === 'solve' ? (
                            <div className="mt-3 text-sm text-muted-foreground">
                                {currentPuzzle.label}
                            </div>
                        ) : null}

                        {refutationToast ? (
                            <div className="mt-3 rounded-md border bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                                {refutationToast}
                            </div>
                        ) : null}

                        {viewMode === 'solve' && attemptResult ? (
                            <div className={
                                'mt-3 rounded-md border px-3 py-2 text-sm ' +
                                (attemptResult === 'correct'
                                    ? 'border-emerald-500/30 bg-emerald-500/10'
                                    : 'border-red-500/30 bg-red-500/10')
                            }>
                                {attemptResult === 'correct'
                                    ? `Correct (${attemptUci ?? ''}) — step through the line (←/→).`
                                    : `Not best (${attemptUci ?? ''}).`}
                            </div>
                        ) : null}

                        {viewMode === 'solve' && (showSolution || attemptResult === 'correct') ? (
                            <div className="mt-3 rounded-md border px-3 py-2 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setPvStep(0)}
                                        disabled={pvStep === 0}
                                    >
                                        Start
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setPvStep((s) => Math.max(0, s - 1))}
                                        disabled={pvStep === 0}
                                    >
                                        Back
                                    </Button>
                                    <div className="text-sm text-muted-foreground">
                                        Step {pvStep}/{Math.max(0, solveLineApplied.length - 1)}
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            setPvStep((s) =>
                                                Math.min(solveLineApplied.length - 1, s + 1)
                                            )
                                        }
                                        disabled={pvStep >= solveLineApplied.length - 1}
                                    >
                                        Next
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setPvStep(solveLineApplied.length - 1)}
                                        disabled={pvStep >= solveLineApplied.length - 1}
                                    >
                                        End
                                    </Button>
                                </div>
                                <div className="mt-2 font-mono text-xs text-muted-foreground">
                                    {solveExplorerLine.slice(0, 10).join(' ')}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>

                <div className="hidden lg:block">{rightPanel}</div>
            </div>

            <div className="lg:hidden">
                <Sheet>
                    <SheetTrigger asChild>
                        <Button variant="outline" className="w-full">
                            Open controls
                        </Button>
                    </SheetTrigger>
                    <SheetContent side="right" className="w-full sm:max-w-md">
                        <SheetHeader>
                            <SheetTitle>Trainer</SheetTitle>
                        </SheetHeader>
                        <div className="mt-4">{rightPanel}</div>
                    </SheetContent>
                </Sheet>
            </div>

            {randomError ? (
                <div className="text-sm text-red-600">{randomError}</div>
            ) : null}
            {sourceError ? (
                <div className="text-sm text-red-600">{sourceError}</div>
            ) : null}
        </div>
    );
}
