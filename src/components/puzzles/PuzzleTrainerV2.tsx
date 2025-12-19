'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chess, type Move, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';

import type { NormalizedGame } from '@/lib/types/game';
import type { Puzzle } from '@/lib/analysis/puzzles';
import {
    StockfishClient,
    type Score,
} from '@/lib/analysis/stockfishClient';
import { useStockfishLiveMultiPvAnalysis } from '@/lib/hooks/useStockfishLiveMultiPvAnalysis';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

type TrainerViewMode = 'solve' | 'analyze';
type ContinuationMode = 'off' | 'short' | 'full';

type VerboseMove = Move & { promotion?: string };

type SourceParsed = { startFen: string; moves: VerboseMove[] };
type TrainerFilters = {
    type: '' | 'avoidBlunder' | 'punishBlunder';
    kind: '' | 'blunder' | 'missedWin' | 'missedTactic';
    phase: '' | 'opening' | 'middlegame' | 'endgame';
    multiSolution: '' | 'single' | 'multi';
    openingEco: string[];
    tags: string[];
    solved: boolean | undefined;
    failed: boolean | undefined;
    gameId: string;
};

type DbGameLoose = Record<string, unknown>;

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
        id: String(game['id']),
        provider: providerToUi(String(game['provider'] ?? '')),
        url: typeof game['url'] === 'string' ? game['url'] : undefined,
        playedAt:
            typeof game['playedAt'] === 'string'
                ? String(game['playedAt'])
                : new Date(String(game['playedAt'] ?? Date.now())).toISOString(),
        timeClass: timeClassToUi(String(game['timeClass'] ?? '')),
        rated: typeof game['rated'] === 'boolean' ? game['rated'] : undefined,
        white: {
            name: String(game['whiteName'] ?? ''),
            rating:
                typeof game['whiteRating'] === 'number'
                    ? game['whiteRating']
                    : undefined,
        },
        black: {
            name: String(game['blackName'] ?? ''),
            rating:
                typeof game['blackRating'] === 'number'
                    ? game['blackRating']
                    : undefined,
        },
        result: typeof game['result'] === 'string' ? game['result'] : undefined,
        termination:
            typeof game['termination'] === 'string' ? game['termination'] : undefined,
        pgn: String(game['pgn'] ?? ''),
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
            const mv = c.move({ from: m.from, to: m.to, promotion: m.promotion });
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

function parseCsv(v: string | null, max: number): string[] {
    const s = (v ?? '').trim();
    if (!s) return [];
    return s
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, max);
}

export function PuzzleTrainerV2({
    initialViewMode,
}: {
    initialViewMode: TrainerViewMode;
}) {
    const pathname = usePathname();
    const sp = useSearchParams();

    const { getRandom, loading: loadingNext, error: randomError } = useRandomPuzzles();

    const engineRef = useRef<StockfishClient | null>(null);
    const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);

    const { startAttempt, recordAttempt, saving: attemptSaving, queued: attemptQueued } =
        usePuzzleAttempt();

    const [viewMode, setViewMode] = useState<TrainerViewMode>(initialViewMode);

    const [queue, setQueue] = useState<Puzzle[]>([]);
    const [idx, setIdx] = useState(0);

    const currentPuzzle = queue[idx] ?? null;
    const [directLoadError, setDirectLoadError] = useState<string | null>(null);

    // Keep refs to avoid URL<->state feedback loops.
    // We intentionally do NOT want "URL puzzleId changed" logic to re-run just because queue/idx changed
    // (e.g. when the user presses Next). It should only react to actual puzzleId changes.
    const queueRef = useRef<Puzzle[]>([]);
    const idxRef = useRef(0);
    const ensureOneInFlightRef = useRef(false);
    const ensureOneRequestIdRef = useRef(0);
    useEffect(() => {
        queueRef.current = queue;
    }, [queue]);
    useEffect(() => {
        idxRef.current = idx;
    }, [idx]);

    const trainerFilters = useMemo<TrainerFilters>(() => {
        const type = (sp?.get('type') ?? '').trim();
        const kind = (sp?.get('kind') ?? '').trim();
        const phase = (sp?.get('phase') ?? '').trim();
        const multiSolution = (sp?.get('multiSolution') ?? '').trim();
        const openingEco = parseCsv(sp?.get('openingEco') ?? '', 32).map((s) =>
            s.toUpperCase()
        );
        const tags = parseCsv(sp?.get('tags') ?? '', 16);
        const solved = sp?.get('solved');
        const failed = sp?.get('failed');
        const gameId = (sp?.get('gameId') ?? '').trim();
        return {
            type:
                type === 'avoidBlunder' || type === 'punishBlunder'
                    ? (type as 'avoidBlunder' | 'punishBlunder')
                    : '',
            kind:
                kind === 'blunder' || kind === 'missedWin' || kind === 'missedTactic'
                    ? (kind as 'blunder' | 'missedWin' | 'missedTactic')
                    : '',
            phase:
                phase === 'opening' || phase === 'middlegame' || phase === 'endgame'
                    ? (phase as 'opening' | 'middlegame' | 'endgame')
                    : '',
            multiSolution:
                multiSolution === 'single' || multiSolution === 'multi'
                    ? (multiSolution as 'single' | 'multi')
                    : '',
            openingEco,
            tags,
            solved: solved === 'true' ? true : solved === 'false' ? false : undefined,
            failed: failed === 'true' ? true : failed === 'false' ? false : undefined,
            gameId,
        };
    }, [sp]);

    const directPuzzleId = useMemo(() => {
        const raw = sp?.get('puzzleId');
        return typeof raw === 'string' ? raw.trim() : '';
    }, [sp]);

    const [sourceGame, setSourceGame] = useState<NormalizedGame | null>(null);
    const [sourceParsed, setSourceParsed] = useState<SourceParsed | null>(null);
    const [sourceLoading, setSourceLoading] = useState(false);
    const [sourceError, setSourceError] = useState<string | null>(null);

    const [attemptFen, setAttemptFen] = useState<string>(new Chess().fen());
    const [attemptLastMove, setAttemptLastMove] = useState<{ from: Square; to: Square } | null>(null);
    const [attemptUci, setAttemptUci] = useState<string | null>(null);
    const [attemptResult, setAttemptResult] = useState<'correct' | 'incorrect' | null>(null);
    const [solvedKind, setSolvedKind] = useState<'best' | 'safe' | null>(null);
    const [showSolution, setShowSolution] = useState(false);

    // Solve mode: wrong-move refutation playback + overlay
    const [refutationLineUci, setRefutationLineUci] = useState<string[] | null>(null);
    const [refutationStep, setRefutationStep] = useState(0);
    const [showWrongOverlay, setShowWrongOverlay] = useState(false);

    // Context (pre-puzzle) navigation
    const [showContext, setShowContext] = useState(false);
    const [contextPly, setContextPly] = useState(0);

    // Source-game reveal (post-solve)
    const [showRealMove, setShowRealMove] = useState(false);
    const [continuationMode, setContinuationMode] = useState<ContinuationMode>('off');

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
    const [analysisHistory, setAnalysisHistory] = useState<string[]>([]);
    const [analysisHistoryIdx, setAnalysisHistoryIdx] = useState(0);
    const [analysisRootFen, setAnalysisRootFen] = useState<string | null>(null);
    const [analysisEnabled, setAnalysisEnabled] = useState(true);
    const [analysisMultiPv, setAnalysisMultiPv] = useState(3);
    const [analysisSelectedIdx, setAnalysisSelectedIdx] = useState(0);
    const [analysisSelectedKey, setAnalysisSelectedKey] = useState<string | null>(null);

    const [panelTab, setPanelTab] = useState<'puzzle' | 'context' | 'lines'>('puzzle');

    // Eval reveal (solve mode)
    const [evalRevealed, setEvalRevealed] = useState(false);
    const [positionEvalFen, setPositionEvalFen] = useState<string>('');
    const [positionEvalScore, setPositionEvalScore] = useState<Score | null>(null);
    const [positionEvalBusy, setPositionEvalBusy] = useState(false);

    // Click-to-move hints
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [legalTargets, setLegalTargets] = useState<Set<Square>>(new Set());

    const engineMoveTimeMsSolve = 200;

    const replaceUrlSearch = useCallback(
        (next: URLSearchParams) => {
            if (typeof window === 'undefined') return;
            const qs = next.toString();
            const url = qs ? `${pathname}?${qs}` : pathname;
            // Important: use the History API to avoid triggering Next.js navigation /
            // server component re-renders on every puzzle change.
            window.history.replaceState(null, '', url);
        },
        [pathname]
    );

    useEffect(() => {
        return () => {
            engineRef.current?.terminate();
            engineRef.current = null;
        };
    }, []);

    // keep URL in sync (view)
    useEffect(() => {
        if (typeof window === 'undefined') return;
        const cur = window.location.search.replace(/^\?/, '');
        const next = new URLSearchParams(cur);
        next.set('view', viewMode);
        const nextStr = next.toString();
        if (nextStr === cur) return;
        replaceUrlSearch(next);
    }, [viewMode, replaceUrlSearch]);

    // keep URL in sync (current puzzle)
    useEffect(() => {
        if (!currentPuzzle?.id) return;
        if (typeof window === 'undefined') return;
        const cur = window.location.search.replace(/^\?/, '');
        const next = new URLSearchParams(cur);
        if (next.get('puzzleId') === currentPuzzle.id) return;
        next.set('puzzleId', currentPuzzle.id);
        const nextStr = next.toString();
        if (nextStr === cur) return;
        replaceUrlSearch(next);
    }, [currentPuzzle?.id, replaceUrlSearch]);

    async function fetchPuzzleById(id: string) {
        const pid = (id ?? '').trim();
        if (!pid) return null;
        try {
            const res = await fetch(`/api/puzzles/${encodeURIComponent(pid)}`);
            const json: unknown = await res.json().catch(() => ({}));
            const obj =
                json && typeof json === 'object'
                    ? (json as Record<string, unknown>)
                    : ({} as Record<string, unknown>);
            const err =
                'error' in obj && typeof obj.error === 'string'
                    ? obj.error
                    : 'Failed to load puzzle';
            if (!res.ok) throw new Error(err);
            const puzzle = 'puzzle' in obj ? (obj.puzzle as Puzzle | null) : null;
            return puzzle ?? null;
        } catch (e) {
            setDirectLoadError(e instanceof Error ? e.message : 'Failed to load puzzle');
            return null;
        }
    }

    async function fetchNextPuzzle() {
        const excludeIds = queue.slice(-25).map((p) => p.id);
        const res = await getRandom({
            count: 1,
            excludeIds,
            type: trainerFilters.type,
            kind: trainerFilters.kind,
            phase: trainerFilters.phase,
            multiSolution: trainerFilters.multiSolution,
            openingEco: trainerFilters.openingEco,
            tags: trainerFilters.tags,
            solved: trainerFilters.solved,
            failed: trainerFilters.failed,
            gameId: trainerFilters.gameId,
        });
        const p = res[0] as Puzzle | undefined;
        return p ?? null;
    }

    function cancelEnsureOneInFlight() {
        // Bump the request id so any in-flight completion becomes a no-op.
        ensureOneRequestIdRef.current += 1;
        ensureOneInFlightRef.current = false;
    }

    async function ensureOne(opts?: { force?: boolean }) {
        const force = opts?.force === true;

        // Guard against concurrent initial loads (we can get multiple effects calling ensureOne on mount).
        // Without this, we can fetch multiple random puzzles and rapidly update URL a few times.
        if (!force) {
            if (queueRef.current.length > 0) return;
            if (ensureOneInFlightRef.current) return;
        } else {
            cancelEnsureOneInFlight();
            // If we're forcing a refetch, make sure we don't consult stale refs.
            queueRef.current = [];
            idxRef.current = 0;
        }

        ensureOneInFlightRef.current = true;
        const requestId = ++ensureOneRequestIdRef.current;

        try {
            // If a puzzleId is provided in the URL, load that puzzle into the trainer.
            if (directPuzzleId) {
                setDirectLoadError(null);
                const p = await fetchPuzzleById(directPuzzleId);
                if (ensureOneRequestIdRef.current !== requestId) return;
                if (p) {
                    setQueue([p]);
                    setIdx(0);
                    return;
                }
                // fall through to random puzzle if direct load fails
            }

            const p = await fetchNextPuzzle();
            if (ensureOneRequestIdRef.current !== requestId) return;
            if (p) {
                setQueue([p]);
                setIdx(0);
            }
        } finally {
            if (ensureOneRequestIdRef.current === requestId) {
                ensureOneInFlightRef.current = false;
            }
        }
    }

    // If the URL puzzleId changes while the trainer is mounted, switch the queue to that puzzle.
    useEffect(() => {
        let cancelled = false;
        async function run() {
            if (!directPuzzleId) return;
            const existingIdx = queueRef.current.findIndex((p) => p.id === directPuzzleId);
            if (existingIdx >= 0) {
                if (existingIdx !== idxRef.current) setIdx(existingIdx);
                return;
            }
            setDirectLoadError(null);
            const p = await fetchPuzzleById(directPuzzleId);
            if (cancelled) return;
            if (p) {
                setQueue([p]);
                setIdx(0);
            }
        }
        void run();
        return () => {
            cancelled = true;
        };
    }, [directPuzzleId]);

    // initial load
    useEffect(() => {
        void ensureOne();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // If filters change, clear the queue and refetch a matching puzzle.
    useEffect(() => {
        // Don't clobber a direct puzzle load (explicit puzzleId takes precedence).
        if (directPuzzleId) return;
        setQueue([]);
        setIdx(0);
        // Force ensures we don't get stuck due to stale queueRef before React flushes state updates.
        void ensureOne({ force: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        trainerFilters.type,
        trainerFilters.kind,
        trainerFilters.phase,
        trainerFilters.multiSolution,
        trainerFilters.openingEco.join(','),
        trainerFilters.tags.join(','),
        String(trainerFilters.solved),
        String(trainerFilters.failed),
        trainerFilters.gameId,
    ]);

    // reset per-puzzle state
    useEffect(() => {
        if (!currentPuzzle) return;
        setAttemptFen(currentPuzzle.fen);
        setAttemptLastMove(null);
        setAttemptUci(null);
        setAttemptResult(null);
        setSolvedKind(null);
        setShowSolution(false);
        setRefutationLineUci(null);
        setRefutationStep(0);
        setShowWrongOverlay(false);
        setPvStep(0);
        setAnalysisSelectedIdx(0);
        setAnalysisSelectedKey(null);
        setAnalysisEnabled(true);
        setSelectedSquare(null);
        setLegalTargets(new Set());
        setShowContext(false);
        setContextPly(typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0);
        setShowRealMove(false);
        setContinuationMode('off');

        setEvalRevealed(false);
        setPositionEvalFen('');
        setPositionEvalScore(null);
        setPositionEvalBusy(false);

        startAttempt(currentPuzzle.id);
        setAnalysisRootFen(currentPuzzle.fen);
        setAnalysisHistory([currentPuzzle.fen]);
        setAnalysisHistoryIdx(0);
    }, [currentPuzzle?.id, startAttempt]);

    // Blur by default when entering solve mode.
    useEffect(() => {
        if (viewMode !== 'solve') return;
        setEvalRevealed(false);
    }, [viewMode]);

    // If user hides eval mid-request, clear the spinner.
    useEffect(() => {
        if (evalRevealed) return;
        setPositionEvalBusy(false);
    }, [evalRevealed]);

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
                const json = (await res.json().catch(() => ({}))) as {
                    game?: unknown;
                    error?: string;
                };
                if (!res.ok)
                    throw new Error(json?.error ?? 'Failed to load source game');
                const ng = dbGameToNormalizedLoose(
                    (json?.game && typeof json.game === 'object'
                        ? (json.game as Record<string, unknown>)
                        : {}) as Record<string, unknown>
                );
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

    const acceptedMoves = useMemo(() => {
        if (!currentPuzzle) return [] as string[];
        const best = (currentPuzzle.bestMoveUci ?? '').trim().toLowerCase();
        const rest = (currentPuzzle.acceptedMovesUci ?? []).map((s) =>
            (s ?? '').trim().toLowerCase()
        );
        return Array.from(new Set([best, ...rest].filter(Boolean)));
    }, [currentPuzzle]);

    const isMultiSolutionPuzzle = useMemo(() => {
        return acceptedMoves.length > 1;
    }, [acceptedMoves.length]);

    const acceptedMovesText = useMemo(() => {
        return acceptedMoves.slice(0, 8).join(' ');
    }, [acceptedMoves]);

    const multiSolutionTagPresent = useMemo(() => {
        return (currentPuzzle?.tags ?? []).includes('multiSolution');
    }, [currentPuzzle?.tags]);

    const orientation = useMemo(() => {
        if (!currentPuzzle) return 'white' as const;
        const stm = sideToMoveFromFen(currentPuzzle.fen);
        return stm === 'b' ? ('black' as const) : ('white' as const);
    }, [currentPuzzle]);

    const puzzleLastMove = useMemo(() => {
        if (!currentPuzzle || !sourceParsed) return null;
        return findPuzzleLastMove({ puzzle: currentPuzzle, source: sourceParsed });
    }, [currentPuzzle, sourceParsed]);

    const isReviewState = attemptResult === 'correct' || showSolution;

    const sourcePlyRaw = useMemo(() => {
        const v = currentPuzzle?.sourcePly;
        if (typeof v !== 'number') return null;
        if (!Number.isFinite(v)) return null;
        return Math.trunc(v);
    }, [currentPuzzle?.id, currentPuzzle?.sourcePly]);

    const realSourceMove = useMemo(() => {
        if (!sourceParsed) return null;
        if (sourcePlyRaw === null) return null;
        if (sourcePlyRaw < 0 || sourcePlyRaw >= sourceParsed.moves.length) return null;
        return sourceParsed.moves[sourcePlyRaw] ?? null;
    }, [sourceParsed, sourcePlyRaw]);

    const realSourceMoveUci = useMemo(() => {
        if (!realSourceMove) return '';
        const promo = (realSourceMove.promotion ?? '').toString().toLowerCase();
        return `${realSourceMove.from}${realSourceMove.to}${promo}`;
    }, [realSourceMove]);

    const continuationText = useMemo(() => {
        if (continuationMode === 'off') return '';
        if (!sourceParsed) return '';
        if (sourcePlyRaw === null) return '';
        if (sourcePlyRaw < 0 || sourcePlyRaw >= sourceParsed.moves.length) return '';

        const fenParts = (sourceParsed.startFen ?? '').split(' ');
        const startTurn = fenParts[1] === 'b' ? 'b' : 'w';
        const baseFullmove = Math.max(1, Math.trunc(Number(fenParts[5]) || 1));
        const startIsWhite = startTurn === 'w';

        const endExclusive =
            continuationMode === 'short'
                ? Math.min(sourceParsed.moves.length, sourcePlyRaw + 8)
                : sourceParsed.moves.length;
        const slice = sourceParsed.moves.slice(sourcePlyRaw, endExclusive);
        if (slice.length === 0) return '';

        const tokens: string[] = [];
        for (let k = 0; k < slice.length; k++) {
            const m = slice[k];
            const ply = sourcePlyRaw + k;
            const side =
                startIsWhite
                    ? ply % 2 === 0
                        ? 'w'
                        : 'b'
                    : ply % 2 === 0
                      ? 'b'
                      : 'w';
            const moveNo =
                baseFullmove + Math.floor((ply + (startIsWhite ? 0 : 1)) / 2);

            if (side === 'w') tokens.push(`${moveNo}. ${m.san}`);
            else if (k === 0) tokens.push(`${moveNo}... ${m.san}`);
            else tokens.push(m.san);
        }

        return tokens.join(' ');
    }, [continuationMode, sourceParsed, sourcePlyRaw]);

    const solveExplorerLine = useMemo(() => {
        if (!currentPuzzle) return [] as string[];
        return currentPuzzle.bestLineUci;
    }, [currentPuzzle]);

    const solveLineApplied = useMemo(() => {
        if (!currentPuzzle) return [];
        return applyUciLine(currentPuzzle.fen, solveExplorerLine, 16);
    }, [currentPuzzle, solveExplorerLine]);

    // Live analysis (Analyze mode)
    useEffect(() => {
        if (viewMode !== 'analyze') return;
        if (!analysisEnabled) return;
        if (!analysisRootFen) return;
        if (engineClient) return;
        const client = new StockfishClient();
        engineRef.current = client;
        setEngineClient(client);
    }, [viewMode, analysisEnabled, analysisRootFen, engineClient]);

    const analyzeStreamingEnabled =
        viewMode === 'analyze' && analysisEnabled && !!analysisRootFen;
    const liveAnalyze = useStockfishLiveMultiPvAnalysis({
        client: engineClient,
        fen: analyzeStreamingEnabled ? analysisRootFen : null,
        multiPv: analysisMultiPv,
        enabled: analyzeStreamingEnabled,
        emitIntervalMs: 150,
    });

    const analysis = liveAnalyze.update;
    const analysisErr = liveAnalyze.error;
    const analysisBusy =
        liveAnalyze.running ||
        (analyzeStreamingEnabled && !analysis && !analysisErr);

    useEffect(() => {
        if (viewMode !== 'analyze') return;
        setAnalysisSelectedIdx(0);
        setAnalysisSelectedKey(null);
    }, [viewMode, analysisRootFen]);

    const selectedLine = useMemo(() => {
        const lines = analysis?.lines ?? [];
        if (analysisSelectedKey) {
            const idx = lines.findIndex(
                (l) => (l.pvUci ?? []).join(' ') === analysisSelectedKey
            );
            if (idx >= 0) return idx;
        }
        return Math.max(0, Math.min(analysisSelectedIdx, lines.length - 1));
    }, [analysis?.lines, analysisSelectedIdx, analysisSelectedKey]);

    const analyzeLineUci = useMemo(() => {
        const lines = analysis?.lines ?? [];
        const selected = lines[selectedLine] ?? lines[0];
        return selected?.pvUci ?? [];
    }, [analysis, selectedLine]);

    const analyzeApplied = useMemo(() => {
        if (!analysisRootFen) return [];
        return applyUciLine(analysisRootFen, analyzeLineUci, 24);
    }, [analysisRootFen, analyzeLineUci]);

    const refutationApplied = useMemo(() => {
        if (viewMode !== 'solve') return [];
        if (attemptResult !== 'incorrect') return [];
        return applyUciLine(attemptFen, refutationLineUci ?? [], 12);
    }, [viewMode, attemptResult, attemptFen, refutationLineUci]);

    const displayFen = useMemo(() => {
        if (!currentPuzzle) return new Chess().fen();

        if (viewMode === 'solve') {
            if (showContext && sourceParsed) {
                const c = new Chess(sourceParsed.startFen);
                const plies = clamp(contextPly, 0, puzzlePly);
                for (let i = 0; i < plies; i++) {
                    const m = sourceParsed.moves[i];
                    try {
                        c.move({ from: m.from, to: m.to, promotion: m.promotion });
                    } catch {
                        break;
                    }
                }
                return c.fen();
            }

            if (attemptResult === 'incorrect') {
                const step = clamp(refutationStep, 0, Math.max(0, refutationApplied.length - 1));
                return refutationApplied[step]?.fen ?? attemptFen;
            }

            if (isReviewState) {
                const step = clamp(pvStep, 0, Math.max(0, solveLineApplied.length - 1));
                return solveLineApplied[step]?.fen ?? currentPuzzle.fen;
            }

            return currentPuzzle.fen;
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
        refutationApplied,
        refutationStep,
        analysisRootFen,
        analyzeApplied,
    ]);

    const allowMove = useMemo(() => {
        if (!currentPuzzle) return false;
        if (viewMode === 'solve') return !showContext && !attemptResult;
        return true;
    }, [currentPuzzle, viewMode, showContext, attemptResult]);

    const rootEvalFen = useMemo(() => {
        if (viewMode === 'solve') return currentPuzzle?.fen ?? null;
        return analysis?.fen ?? analysisRootFen ?? null;
    }, [viewMode, currentPuzzle?.fen, analysis?.fen, analysisRootFen]);

    const rootEvalScore = useMemo(() => {
        if (viewMode === 'solve') return currentPuzzle?.score ?? null;
        const line = analysis?.lines[selectedLine] ?? analysis?.lines[0];
        return line?.score ?? null;
    }, [viewMode, currentPuzzle?.score, analysis, selectedLine]);

    const displayEval = useMemo(() => {
        // If we've evaluated the currently displayed position, prefer that (true "current position" eval).
        if (positionEvalFen && positionEvalFen === displayFen) {
            return { score: positionEvalScore, fenForSign: displayFen };
        }

        // Otherwise, fall back to the root score (puzzle start / analysis root) and use its own FEN for sign.
        if (rootEvalFen && rootEvalScore) {
            return { score: rootEvalScore, fenForSign: rootEvalFen };
        }

        return { score: null as Score | null, fenForSign: displayFen };
    }, [positionEvalFen, positionEvalScore, displayFen, rootEvalFen, rootEvalScore]);

    const evalText = useMemo(() => {
        return formatEval(displayEval.score, displayEval.fenForSign);
    }, [displayEval]);

    const evalUnit = useMemo(() => {
        return scoreToUnit(displayEval.score, displayEval.fenForSign);
    }, [displayEval]);

    const solveEvalPending = useMemo(() => {
        if (viewMode !== 'solve') return false;
        if (!evalRevealed) return false;
        if (!displayFen) return true;
        if (currentPuzzle?.fen === displayFen && currentPuzzle?.score) return false;
        return positionEvalFen !== displayFen;
    }, [
        viewMode,
        evalRevealed,
        displayFen,
        currentPuzzle?.fen,
        currentPuzzle?.score,
        positionEvalFen,
    ]);

    // When eval is revealed in solve mode, keep it in sync with the currently displayed position.
    useEffect(() => {
        if (viewMode !== 'solve') return;
        if (!evalRevealed) return;
        if (!displayFen) return;
        if (positionEvalFen === displayFen) return;

        // If we're exactly at the puzzle start and have a precomputed score, use it immediately.
        if (currentPuzzle?.fen === displayFen && currentPuzzle?.score) {
            setPositionEvalFen(displayFen);
            setPositionEvalScore(currentPuzzle.score);
            setPositionEvalBusy(false);
            return;
        }

        let cancelled = false;
        const t = window.setTimeout(async () => {
            setPositionEvalBusy(true);
            try {
                const client = engineClient ?? new StockfishClient();
                if (!engineClient) {
                    engineRef.current = client;
                    setEngineClient(client);
                }
                const res = await client.evalPosition({
                    fen: displayFen,
                    movetimeMs: engineMoveTimeMsSolve,
                });
                if (cancelled) return;
                setPositionEvalFen(displayFen);
                setPositionEvalScore(res.score ?? null);
            } catch {
                if (!cancelled) {
                    setPositionEvalFen(displayFen);
                    setPositionEvalScore(null);
                }
            } finally {
                if (!cancelled) setPositionEvalBusy(false);
            }
        }, 120);

        return () => {
            cancelled = true;
            window.clearTimeout(t);
        };
    }, [
        viewMode,
        evalRevealed,
        displayFen,
        positionEvalFen,
        currentPuzzle?.fen,
        currentPuzzle?.score,
        engineClient,
        engineMoveTimeMsSolve,
    ]);

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
            const atStartFen = !!currentPuzzle && displayFen === currentPuzzle.fen;
            if (
                atPuzzlePosition &&
                atStartFen &&
                (showSolution || attemptResult === 'correct') &&
                currentPuzzle
            ) {
                // If multi-solution, show all accepted moves as green arrows.
                if (isMultiSolutionPuzzle && acceptedMoves.length > 1) {
                    const best = (currentPuzzle.bestMoveUci ?? '')
                        .trim()
                        .toLowerCase();
                    for (const uci of acceptedMoves) {
                        const a = uciToArrow(uci);
                        if (!a) continue;
                        const isBest = uci === best;
                        put({
                            startSquare: a.from,
                            endSquare: a.to,
                            color: isBest
                                ? 'rgba(16,185,129,0.80)'
                                : 'rgba(16,185,129,0.40)',
                        });
                    }
                } else {
                    const a = uciToArrow(currentPuzzle.bestMoveUci);
                    if (a) {
                        put({
                            startSquare: a.from,
                            endSquare: a.to,
                            color: 'rgba(16,185,129,0.75)',
                        });
                    }
                }
            }

            // When reviewing a solved/revealed puzzle, optionally show the *real* move played in the source game.
            // Only show at the puzzle start position to avoid misleading arrows while scrubbing.
            if (
                atPuzzlePosition &&
                atStartFen &&
                showRealMove &&
                (showSolution || attemptResult === 'correct') &&
                currentPuzzle &&
                realSourceMove
            ) {
                const best = (currentPuzzle.bestMoveUci ?? '').trim().toLowerCase();
                const real = (realSourceMoveUci ?? '').trim().toLowerCase();
                // Avoid overwriting the solution arrow when the real move equals the best move.
                if (real && real !== best) {
                    put({
                        startSquare: realSourceMove.from as Square,
                        endSquare: realSourceMove.to as Square,
                        color: 'rgba(245,158,11,0.85)', // amber: distinct from solution green
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
        displayFen,
        attemptLastMove,
        attemptResult,
        showSolution,
        showRealMove,
        realSourceMove,
        realSourceMoveUci,
        currentPuzzle,
        isMultiSolutionPuzzle,
        acceptedMoves,
        analysis,
        selectedLine,
    ]);

    const squareStyles = useMemo(() => {
        const s: Record<string, React.CSSProperties> = {};
        const atPuzzlePosition = !showContext || contextPly === puzzlePly;
        if (puzzleLastMove && atPuzzlePosition) {
            s[puzzleLastMove.from] = { backgroundColor: 'rgba(124,58,237,0.22)' };
            s[puzzleLastMove.to] = { backgroundColor: 'rgba(124,58,237,0.30)' };
        }
        if (attemptLastMove) {
            const bad = attemptResult === 'incorrect';
            s[attemptLastMove.from] = {
                backgroundColor: bad ? 'rgba(220,38,38,0.18)' : 'rgba(16,185,129,0.18)',
            };
            s[attemptLastMove.to] = {
                backgroundColor: bad ? 'rgba(220,38,38,0.26)' : 'rgba(16,185,129,0.26)',
            };
        }
        if (selectedSquare) {
            s[selectedSquare] = { outline: '2px solid hsl(var(--ring))' };
        }
        const dot =
            'radial-gradient(circle at center, rgba(124,58,237,0.55) 0 18%, rgba(0,0,0,0) 20%)';
        for (const t of legalTargets) {
            if (!s[t]) s[t] = {};
            const prev = s[t].backgroundImage as string | undefined;
            s[t].backgroundImage = prev ? `${dot}, ${prev}` : dot;
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

    function applyMoveResult(res: {
        fen: string;
        uci: string;
        lastMove: { from: Square; to: Square };
    }) {
        clearHints();
        setShowContext(false);

        if (viewMode === 'solve') {
            setAttemptFen(res.fen);
            setAttemptLastMove(res.lastMove);
            setAttemptUci(res.uci);
            const u = res.uci.trim().toLowerCase();
            const best = (currentPuzzle?.bestMoveUci ?? '').trim().toLowerCase();
            const accepted = new Set(acceptedMoves);
            const correct = accepted.has(u);
            setAttemptResult(correct ? 'correct' : 'incorrect');
            setSolvedKind(correct ? (u === best ? 'best' : 'safe') : null);
            setPvStep(0);

            if (!correct) {
                setRefutationLineUci(null);
                setRefutationStep(0);
                setShowWrongOverlay(false);
            } else {
                // If it's a safe-but-not-best move, reveal best line for learning.
                if (u !== best) setShowSolution(true);
            }
            return;
        }

        // analyze sandbox: update root and re-run analysis
        setAnalysisHistory((prev) => {
            const base = prev.slice(0, Math.max(0, analysisHistoryIdx) + 1);
            base.push(res.fen);
            return base;
        });
        setAnalysisHistoryIdx((i) => i + 1);
        setAnalysisRootFen(res.fen);
        setPvStep(0);
    }

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
        const moves = c.moves({ square, verbose: true }) as unknown as VerboseMove[];
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
        setRefutationLineUci(null);
        setRefutationStep(0);
        setShowWrongOverlay(false);
        clearHints();
        startAttempt(currentPuzzle.id);
    }

    // record attempt after a solve move
    useEffect(() => {
        if (!currentPuzzle || !attemptUci || !attemptResult) return;
        void recordAttempt({
            puzzleId: currentPuzzle.id,
            move: attemptUci,
            correct: attemptResult === 'correct',
        });
    }, [currentPuzzle?.id, attemptUci, attemptResult, recordAttempt]);

    // Solve mode: on wrong move, auto-play Stockfish refutation then show overlay.
    useEffect(() => {
        let cancelled = false;
        let interval: number | null = null;
        async function run() {
            if (viewMode !== 'solve') return;
            if (!currentPuzzle) return;
            if (attemptResult !== 'incorrect') return;

            // Avoid a race where we create/set the engineClient and *also* start a refutation
            // analysis in the same pass (which can get cancelled by the state update and leave
            // a hung/queued engine job behind).
            if (!engineClient) {
                const client = new StockfishClient();
                engineRef.current = client;
                setEngineClient(client);
                return;
            }

            try {
                const res = await engineClient.analyzeMultiPv({
                    fen: attemptFen,
                    movetimeMs: 250,
                    multiPv: 1,
                });
                const pv = res.lines?.[0]?.pvUci?.slice(0, 10) ?? [];
                if (cancelled) return;
                setRefutationLineUci(pv);
                setRefutationStep(0);
                setShowWrongOverlay(false);

                const applied = applyUciLine(attemptFen, pv, 12);
                const lastIdx = Math.max(0, applied.length - 1);
                if (lastIdx === 0) {
                    setShowWrongOverlay(true);
                    return;
                }
                interval = window.setInterval(() => {
                    setRefutationStep((s) => {
                        if (s >= lastIdx) {
                            if (interval) window.clearInterval(interval);
                            interval = null;
                            setShowWrongOverlay(true);
                            return s;
                        }
                        return s + 1;
                    });
                }, 450);
            } catch (e) {
                // If refutation analysis fails (engine busy/crashed/cancelled), still show the
                // "Not best" overlay so the user can choose Analyze / Try again.
                if (!cancelled) {
                    try {
                        if (window.localStorage?.getItem('debugStockfish') === '1') {
                            console.warn('[puzzles] refutation analysis failed', e);
                        }
                    } catch {
                        // ignore
                    }
                    setRefutationLineUci(null);
                    setRefutationStep(0);
                    setShowWrongOverlay(true);
                }
            }
        }
        void run();
        return () => {
            cancelled = true;
            if (interval) window.clearInterval(interval);
        };
    }, [viewMode, currentPuzzle?.id, attemptResult, attemptFen, engineClient]);

    // keyboard shortcuts
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isEditableTarget(e.target)) return;
            // Prevent Radix Tabs (and other focused UI) from stealing navigation keys.
            // We intentionally intercept in capture phase (see addEventListener below).
            if (
                e.key === 'ArrowLeft' ||
                e.key === 'ArrowRight' ||
                e.key === 'Home' ||
                e.key === 'End'
            ) {
                e.stopPropagation();
                e.stopImmediatePropagation?.();
            }

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
                    setAnalysisEnabled(true);
                    if (!engineClient) {
                        const client = new StockfishClient();
                        engineRef.current = client;
                        setEngineClient(client);
                    }
                    liveAnalyze.start();
                }
                return;
            }
            if (e.key === 'u') {
                if (viewMode !== 'analyze') return;
                e.preventDefault();
                // Undo in analyze sandbox (position history)
                setAnalysisHistoryIdx((i) => Math.max(0, i - 1));
                return;
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (viewMode === 'analyze' && !e.shiftKey) {
                    setAnalysisHistoryIdx((i) => Math.max(0, i - 1));
                    return;
                }
                if (viewMode === 'solve') {
                    // In solve mode, arrow keys navigate context (prelude) when enabled.
                    // If context is not currently shown, ArrowLeft enters context one ply before the puzzle.
                    if (showContext && sourceParsed) {
                        setContextPly((p) => Math.max(0, p - 1));
                        return;
                    }
                    if (!attemptResult && !isReviewState && sourceParsed) {
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
                if (viewMode === 'analyze' && !e.shiftKey) {
                    setAnalysisHistoryIdx((i) =>
                        Math.min(Math.max(0, analysisHistory.length - 1), i + 1)
                    );
                    return;
                }
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

            if (e.key === 'Home') {
                if (viewMode !== 'analyze') return;
                if (e.shiftKey) return;
                e.preventDefault();
                setAnalysisHistoryIdx(0);
                return;
            }

            if (e.key === 'End') {
                if (viewMode !== 'analyze') return;
                if (e.shiftKey) return;
                e.preventDefault();
                setAnalysisHistoryIdx(Math.max(0, analysisHistory.length - 1));
                return;
            }
        }

        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
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
        analysisHistory.length,
    ]);

    // When scrubbing analyze history, update root + restart PV browsing.
    useEffect(() => {
        if (viewMode !== 'analyze') return;
        const fen = analysisHistory[analysisHistoryIdx];
        if (!fen) return;
        if (fen === analysisRootFen) return;
        setAnalysisRootFen(fen);
        setPvStep(0);
        // live analysis restarts automatically when root changes
    }, [viewMode, analysisHistory, analysisHistoryIdx, analysisRootFen]);

    const topMeta = useMemo(() => {
        if (!currentPuzzle) return null;
        const parts: string[] = [];
        parts.push(currentPuzzle.type);
        if (openingText) parts.push(openingText);
        return parts.join(' • ');
    }, [currentPuzzle, openingText]);

    const statusText = useMemo(() => {
        if (viewMode === 'solve') {
            if (!attemptResult) return 'Solve the best move';
            if (attemptResult === 'incorrect') return 'Not best — try again';
            if (solvedKind === 'safe') {
                return currentPuzzle?.mode === 'avoidBlunder'
                    ? 'Good save — review the best line (←/→)'
                    : 'Correct (alternative) — review the best line (←/→)';
            }
            return 'Correct — review the line (←/→)';
        }
        if (analysisBusy) {
            return `Thinking…${
                typeof liveAnalyze.depth === 'number' ? ` d${liveAnalyze.depth}` : ''
            }${
                typeof liveAnalyze.timeMs === 'number'
                    ? ` ${(liveAnalyze.timeMs / 1000).toFixed(1)}s`
                    : ''
            }`;
        }
        if (analysisErr) return analysisErr;
        return 'Analyze with Stockfish';
    }, [
        viewMode,
        attemptResult,
        solvedKind,
        currentPuzzle?.mode,
        analysisBusy,
        analysisErr,
        liveAnalyze.depth,
        liveAnalyze.timeMs,
    ]);

    const actionBar = (
        <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => void nextPuzzle()} disabled={loadingNext} className="flex-1 sm:flex-none">
                Next (n)
            </Button>
            {viewMode === 'solve' ? (
                <>
                    <Button
                        variant="outline"
                        onClick={() => {
                            setShowContext((v) => {
                                const next = !v;
                                if (next) setContextPly(puzzlePly);
                                return next;
                            });
                        }}
                        disabled={!sourceParsed}
                    >
                        {showContext ? 'Hide context' : 'Context'}
                    </Button>
                    <Button variant="outline" onClick={resetSolve} disabled={!currentPuzzle}>
                        Reset (r)
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => setShowSolution(true)}
                        disabled={!currentPuzzle}
                    >
                        Solution (s)
                    </Button>
                    {attemptResult === 'incorrect' ? (
                        <Button onClick={resetSolve} disabled={!currentPuzzle}>
                            Try again
                        </Button>
                    ) : null}
                </>
            ) : (
                <>
                    <Button
                        variant="outline"
                        onClick={() => {
                            setPvStep(0);
                            if (!engineClient) {
                                const client = new StockfishClient();
                                engineRef.current = client;
                                setEngineClient(client);
                            }
                            setAnalysisEnabled(true);
                            liveAnalyze.start();
                        }}
                        disabled={!analysisRootFen}
                    >
                        Re-evaluate
                    </Button>
                    <Button
                        variant="outline"
                        onClick={() => {
                            if (!analysisRootFen) return;
                            setAnalysisEnabled((v) => {
                                const next = !v;
                                if (next) {
                                    if (!engineClient) {
                                        const client = new StockfishClient();
                                        engineRef.current = client;
                                        setEngineClient(client);
                                    }
                                    liveAnalyze.start();
                                } else {
                                    liveAnalyze.stop();
                                }
                                return next;
                            });
                        }}
                        disabled={!analysisRootFen}
                    >
                        {analysisEnabled ? 'Stop' : 'Start'}
                    </Button>
                    <div className="w-[120px]">
                        <Select
                            value={String(analysisMultiPv)}
                            onValueChange={(v) =>
                                setAnalysisMultiPv(
                                    Math.max(1, Math.min(5, Math.trunc(Number(v) || 1)))
                                )
                            }
                        >
                            <SelectTrigger className="h-9">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {[1, 2, 3, 4, 5].map((n) => (
                                    <SelectItem key={n} value={String(n)}>
                                        MultiPV {n}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <Button
                        variant="outline"
                        onClick={() => {
                            if (!analysisRootFen) return;
                            setAnalysisRootFen(displayFen);
                            setAnalysisHistory([displayFen]);
                            setAnalysisHistoryIdx(0);
                            setPvStep(0);
                        }}
                        disabled={!analysisRootFen}
                    >
                        Set as root
                    </Button>
                </>
            )}

            <Button asChild variant="outline" className="ml-auto">
                <Link href="/puzzles/library">Library</Link>
            </Button>
        </div>
    );

    const panel = (
        <Card className="rounded-xl">
            <CardHeader className="p-4 pb-2">
                <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
                <Tabs
                    value={panelTab}
                    onValueChange={(v) => {
                        if (v === 'puzzle' || v === 'context' || v === 'lines') setPanelTab(v);
                    }}
                >
                    <TabsList className="w-full justify-start overflow-x-auto">
                        <TabsTrigger value="puzzle">Puzzle</TabsTrigger>
                        <TabsTrigger value="context" disabled={viewMode !== 'solve'}>
                            Context
                        </TabsTrigger>
                        <TabsTrigger value="lines" disabled={viewMode !== 'analyze'}>
                            Lines
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="puzzle" className="mt-3">
                        <div className="space-y-2">
                            <div className="text-sm text-muted-foreground">
                                {currentPuzzle ? topMeta : 'Loading…'}
                            </div>
                            {currentPuzzle && isMultiSolutionPuzzle ? (
                                <div className="text-xs">
                                    <Badge variant="secondary">Multiple correct moves</Badge>
                                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                        Accepted: {acceptedMovesText || '—'}
                                    </div>
                                </div>
                            ) : null}
                            {currentPuzzle && !isMultiSolutionPuzzle && multiSolutionTagPresent ? (
                                <div className="text-xs">
                                    <Badge variant="secondary">Multiple correct moves</Badge>
                                    <div className="mt-1 text-[11px] text-red-600">
                                        Tagged multiSolution but accepted moves are missing.
                                    </div>
                                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">
                                        bestMoveUci={currentPuzzle.bestMoveUci}
                                    </div>
                                </div>
                            ) : null}
                            {sourceGame ? (
                                <div className="text-xs text-muted-foreground">
                                    {sourceGame.provider} • {sourceGame.white.name} vs{' '}
                                    {sourceGame.black.name}
                                </div>
                            ) : null}
                        </div>
                    </TabsContent>

                    <TabsContent value="context" className="mt-3">
                        {viewMode !== 'solve' ? (
                            <div className="text-sm text-muted-foreground">
                                Context is available in Solve mode.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <div className="text-sm text-muted-foreground">
                                    Use ←/→ to step through context and review lines.
                                </div>

                                <div className="flex flex-wrap items-center gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly(0)}
                                        disabled={!showContext || contextPly === 0}
                                    >
                                        Start
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly((p) => Math.max(0, p - 1))}
                                        disabled={!showContext || contextPly === 0}
                                    >
                                        Back
                                    </Button>
                                    <div className="text-sm text-muted-foreground">
                                        Ply {contextPly}/{puzzlePly}
                                    </div>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly((p) => Math.min(puzzlePly, p + 1))}
                                        disabled={!showContext || contextPly >= puzzlePly}
                                    >
                                        Next
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() => setContextPly(puzzlePly)}
                                        disabled={!showContext || contextPly >= puzzlePly}
                                    >
                                        Puzzle
                                    </Button>
                                </div>

                                {isReviewState && sourceParsed ? (
                                    <>
                                        <Separator />
                                        <div className="space-y-2">
                                            <div className="text-sm font-medium">Source game</div>
                                            <div className="flex flex-wrap items-center gap-2">
                                                <Button
                                                    size="sm"
                                                    variant={showRealMove ? 'default' : 'outline'}
                                                    onClick={() => setShowRealMove((v) => !v)}
                                                >
                                                    {showRealMove ? 'Hide real move' : 'Show real move'}
                                                </Button>
                                                <Button
                                                    size="sm"
                                                    variant={continuationMode !== 'off' ? 'default' : 'outline'}
                                                    onClick={() =>
                                                        setContinuationMode((m) =>
                                                            m === 'off'
                                                                ? 'short'
                                                                : m === 'short'
                                                                  ? 'full'
                                                                  : 'off'
                                                        )
                                                    }
                                                >
                                                    {continuationMode === 'off'
                                                        ? 'Show continuation'
                                                        : continuationMode === 'short'
                                                          ? 'Full continuation'
                                                          : 'Hide continuation'}
                                                </Button>
                                                {currentPuzzle?.sourceGameId ? (
                                                    <Button asChild size="sm" variant="outline">
                                                        <Link href={`/games/${currentPuzzle.sourceGameId}`}>
                                                            Open game
                                                        </Link>
                                                    </Button>
                                                ) : null}
                                            </div>

                                            {showRealMove ? (
                                                realSourceMove ? (
                                                    <div className="text-sm">
                                                        Real move:{' '}
                                                        <span className="font-mono">
                                                            {realSourceMove.san}
                                                        </span>{' '}
                                                        <span className="text-muted-foreground">
                                                            ({realSourceMoveUci || '—'})
                                                        </span>
                                                    </div>
                                                ) : (
                                                    <div className="text-sm text-muted-foreground">
                                                        Real move unavailable
                                                    </div>
                                                )
                                            ) : null}

                                            {continuationMode !== 'off' ? (
                                                continuationText ? (
                                                    <div className="font-mono text-xs leading-relaxed text-muted-foreground">
                                                        {continuationText}
                                                    </div>
                                                ) : (
                                                    <div className="text-sm text-muted-foreground">
                                                        Continuation unavailable
                                                    </div>
                                                )
                                            ) : null}
                                        </div>
                                    </>
                                ) : null}
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="lines" className="mt-3">
                        {viewMode !== 'analyze' ? (
                            <div className="text-sm text-muted-foreground">
                                Lines are available in Analyze mode.
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {(analysis?.lines ?? []).slice(0, analysisMultiPv).map((l, i) => (
                                    <button
                                        key={i}
                                        type="button"
                                        onClick={() => {
                                            setAnalysisSelectedIdx(i);
                                            setAnalysisSelectedKey((l.pvUci ?? []).join(' '));
                                            setPvStep(0);
                                        }}
                                        className={
                                            'w-full rounded-md border px-3 py-2 text-left text-sm transition-colors ' +
                                            (i === selectedLine ? 'bg-muted' : 'hover:bg-muted/50')
                                        }
                                    >
                                        <div className="flex items-center justify-between gap-2">
                                            <div className="font-medium">#{i + 1}</div>
                                            <div className="font-mono text-xs text-muted-foreground">
                                                {formatEval(l.score, analysis?.fen ?? displayFen)}
                                                {typeof liveAnalyze.depth === 'number'
                                                    ? ` d${liveAnalyze.depth}`
                                                    : ''}
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
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
            </CardContent>
        </Card>
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
                                if (v === 'analyze' && viewMode !== 'analyze') {
                                    // Entering Analyze should auto-start unless user explicitly stops again.
                                    setAnalysisEnabled(true);
                                }
                                setViewMode(v);
                                setPvStep(0);
                                if (v === 'analyze') {
                                    // When entering analyze, start a fresh history at the current board position.
                                    const fen = attemptFen || currentPuzzle?.fen;
                                    if (fen) {
                                        setAnalysisRootFen(fen);
                                        setAnalysisHistory([fen]);
                                        setAnalysisHistoryIdx(0);
                                    }
                                }
                            }
                        }}
                    >
                        <TabsList>
                            <TabsTrigger value="solve">Solve</TabsTrigger>
                            <TabsTrigger value="analyze">Analyze</TabsTrigger>
                        </TabsList>
                    </Tabs>

                    <div className="hidden sm:flex items-center gap-2">
                        {currentPuzzle ? <Badge variant="outline">{currentPuzzle.type}</Badge> : null}
                        {currentPuzzle && isMultiSolutionPuzzle ? (
                            <Badge variant="secondary">Multiple correct</Badge>
                        ) : null}
                        {openingText ? <Badge variant="outline">{openingText}</Badge> : null}
                    </div>
                    {/* Show multi-solution indicator on small screens too */}
                    {currentPuzzle && isMultiSolutionPuzzle ? (
                        <Badge variant="secondary" className="sm:hidden">
                            Multiple correct
                        </Badge>
                    ) : null}
                </div>
            </div>

            <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                    <span className="font-mono">{prettyTurnFromFen(displayFen)}</span>
                </div>
                <div className="flex items-center gap-2">
                    {viewMode === 'solve' ? (
                        <button
                            type="button"
                            className="group flex items-center gap-2"
                            onClick={() => setEvalRevealed((v) => !v)}
                            title={evalRevealed ? 'Hide eval' : 'Show eval'}
                            aria-pressed={evalRevealed}
                        >
                            <div className="hidden sm:block relative text-sm font-mono text-muted-foreground select-none">
                                <span className={!evalRevealed ? 'blur-md opacity-40' : ''}>
                                    {solveEvalPending || (positionEvalBusy && evalRevealed) ? '…' : evalText}
                                </span>
                                {!evalRevealed ? (
                                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-sans font-medium text-foreground/80 opacity-0 transition-opacity group-hover:opacity-100">
                                        Show eval
                                    </span>
                                ) : null}
                            </div>
                            <div className="relative h-2 w-40 rounded-full bg-muted overflow-hidden">
                                <div
                                    className={!evalRevealed ? 'h-2 bg-muted-foreground/25' : 'h-2 bg-foreground/70'}
                                    style={{
                                        width: `${!evalRevealed || solveEvalPending ? 50 : Math.round(evalUnit * 100)}%`,
                                    }}
                                />
                                {!evalRevealed ? (
                                    <div className="sm:hidden pointer-events-none absolute inset-0 flex items-center justify-center text-[10px] font-medium text-foreground/80 opacity-0 transition-opacity group-hover:opacity-100">
                                        Show eval
                                    </div>
                                ) : null}
                            </div>
                        </button>
                    ) : (
                        <>
                            <div className="hidden sm:block text-sm font-mono text-muted-foreground">
                                {evalText}
                            </div>
                            <div className="h-2 w-40 rounded-full bg-muted overflow-hidden">
                                <div
                                    className="h-2 bg-foreground/70"
                                    style={{ width: `${Math.round(evalUnit * 100)}%` }}
                                />
                            </div>
                        </>
                    )}
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
        <div className="space-y-4">
            {header}

            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="flex justify-center">
                    <div className="w-full max-w-[560px]">
                        <div
                            className={
                                'relative rounded-xl border bg-card p-2 ' +
                                (isOffPuzzlePosition ? 'border-zinc-400' : '')
                            }
                        >
                            {viewMode === 'solve' && attemptResult === 'incorrect' && showWrongOverlay ? (
                                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-sm">
                                    <div className="mx-4 w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg">
                                        <div className="text-sm font-medium">Not best</div>
                                        <div className="mt-1 text-sm text-muted-foreground">
                                            Want to analyze this position or try again?
                                        </div>
                                        <div className="mt-4 flex flex-wrap gap-2">
                                            <Button
                                                onClick={() => {
                                                    setShowWrongOverlay(false);
                                                    setRefutationLineUci(null);
                                                    setRefutationStep(0);
                                                    setPvStep(0);
                                                    setAnalysisRootFen(attemptFen);
                                                    setAnalysisHistory([attemptFen]);
                                                    setAnalysisHistoryIdx(0);
                                                    setViewMode('analyze');
                                                }}
                                            >
                                                Analyze
                                            </Button>
                                            <Button
                                                variant="outline"
                                                onClick={() => {
                                                    setShowWrongOverlay(false);
                                                    resetSolve();
                                                }}
                                            >
                                                Try again
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            ) : null}
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
                                        if (!square) return;
                                        const sq = square as Square;
                                        if (!allowMove) {
                                            clearHints();
                                            return;
                                        }

                                        // If a piece is selected, clicking a legal target plays the move.
                                        if (selectedSquare && legalTargets.has(sq)) {
                                            const from = selectedSquare;
                                            const to = sq;
                                            const c = new Chess(displayFen);
                                            const pc = c.get(from);
                                            const isPawn = pc?.type === 'p';
                                            const promotionRank = to[1] === '8' || to[1] === '1';
                                            const promotion = isPawn && promotionRank ? 'q' : undefined;
                                            const res = tryMakeMove({ from, to, promotion });
                                            if (res) applyMoveResult(res);
                                            return;
                                        }

                                        // Clicking the selected square toggles selection off.
                                        if (selectedSquare && selectedSquare === sq) {
                                            clearHints();
                                            return;
                                        }

                                        // Otherwise, select a piece (if any) or clear selection.
                                        if (!piece) return clearHints();
                                        computeHints(sq);
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
                                              applyMoveResult(res);
                                              return true;
                                          }
                                        : undefined,
                                }}
                            />
                        </div>
                        {isOffPuzzlePosition ? (
                            <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-zinc-400 bg-muted/40 px-3 py-2">
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

                        {actionBar}

                        <div className="mt-3 rounded-md border px-3 py-2">
                            <div className="text-sm font-medium">Status</div>
                            <div className="text-sm text-muted-foreground">{statusText}</div>
                            {attemptSaving || attemptQueued > 0 ? (
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {attemptSaving ? 'Saving attempt…' : null}
                                    {!attemptSaving && attemptQueued > 0
                                        ? `Attempts queued: ${attemptQueued}`
                                        : null}
                                </div>
                            ) : null}
                        </div>

                        {viewMode === 'solve' ? (
                            <div className="mt-3 text-sm text-muted-foreground">
                                {currentPuzzle.label}
                            </div>
                        ) : null}

                        {viewMode === 'solve' && attemptResult ? (
                            <div className={
                                'mt-3 rounded-md border px-3 py-2 text-sm ' +
                                (attemptResult === 'correct'
                                    ? 'border-emerald-500/30 bg-emerald-500/10'
                                    : 'border-red-500/30 bg-red-500/10')
                            }>
                                {attemptResult === 'correct' ? (
                                    solvedKind === 'safe' ? (
                                        currentPuzzle?.mode === 'avoidBlunder'
                                            ? `Good save (${attemptUci ?? ''}) — best was ${currentPuzzle.bestMoveUci}.`
                                            : `Correct (${attemptUci ?? ''}) — best was ${currentPuzzle.bestMoveUci}.`
                                    ) : (
                                        `Correct (${attemptUci ?? ''}) — step through the line (←/→).`
                                    )
                                ) : (
                                    `Not best (${attemptUci ?? ''}).`
                                )}
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

                        <div className="mt-3 lg:hidden">{panel}</div>
                    </div>
                </div>

                <div className="hidden lg:block">{panel}</div>
            </div>

            {randomError ? (
                <div className="text-sm text-red-600">{randomError}</div>
            ) : null}
            {directLoadError ? (
                <div className="text-sm text-red-600">{directLoadError}</div>
            ) : null}
            {sourceError ? (
                <div className="text-sm text-red-600">{sourceError}</div>
            ) : null}
        </div>
    );
}
