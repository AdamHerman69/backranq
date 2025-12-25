'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chess, type Move, type Square } from 'chess.js';
import { ChevronLeft, ChevronRight, Eye, EyeOff, Filter, RotateCcw } from 'lucide-react';
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
    sideToMoveFromFen,
} from '@/lib/chess/utils';
import { ecoName } from '@/lib/chess/eco';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PuzzlesFilter, { type PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

type TrainerViewMode = 'solve' | 'analyze';

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

function describeFilters(f: PuzzlesFilters): string {
    const parts: string[] = [];

    const labelType: Record<PuzzlesFilters['type'], string> = {
        '': '',
        avoidBlunder: 'Avoid blunder',
        punishBlunder: 'Punish blunder',
    };
    const labelKind: Record<PuzzlesFilters['kind'], string> = {
        '': '',
        blunder: 'Blunder',
        missedWin: 'Missed win',
        missedTactic: 'Missed tactic',
    };
    const labelPhase: Record<PuzzlesFilters['phase'], string> = {
        '': '',
        opening: 'Opening',
        middlegame: 'Middlegame',
        endgame: 'Endgame',
    };
    const labelMulti: Record<PuzzlesFilters['multiSolution'], string> = {
        '': '',
        any: 'Any',
        single: 'Single-solution',
        multi: 'Multi-solution',
    };
    const labelStatus: Record<PuzzlesFilters['status'], string> = {
        '': '',
        solved: 'Solved',
        failed: 'Failed',
        attempted: 'Attempted',
    };

    if (f.type) parts.push(`Type: ${labelType[f.type]}`);
    if (f.kind) parts.push(`Kind: ${labelKind[f.kind]}`);
    if (f.phase) parts.push(`Phase: ${labelPhase[f.phase]}`);
    if (f.multiSolution && f.multiSolution !== 'any')
        parts.push(`Solutions: ${labelMulti[f.multiSolution]}`);
    if (f.status) parts.push(`Status: ${labelStatus[f.status]}`);

    if (f.openingEco?.length) {
        const codes = f.openingEco.map((s) => s.toUpperCase());
        const first = codes.slice(0, 2).join(', ');
        parts.push(
            `Openings: ${first}${codes.length > 2 ? ` +${codes.length - 2}` : ''}`
        );
    }
    if (f.tags?.length) {
        const first = f.tags.slice(0, 2).join(', ');
        parts.push(`Tags: ${first}${f.tags.length > 2 ? ` +${f.tags.length - 2}` : ''}`);
    }
    if (f.gameId) parts.push(`Game: ${f.gameId}`);

    return parts.length ? parts.join(' · ') : 'all';
}

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

    const {
        startAttempt,
        recordAttempt,
        flushQueue,
        saving: attemptSaving,
        queued: attemptQueued,
        lastError: attemptLastError,
    } = usePuzzleAttempt();

    const [viewMode, setViewMode] = useState<TrainerViewMode>(initialViewMode);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [tagsRevealed, setTagsRevealed] = useState(false);

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

    // Source-game reveal (the move that was actually played in the source game)
    const [showRealMove, setShowRealMove] = useState(false);

    // Solve mode: wrong-move refutation playback + overlay
    const [refutationLineUci, setRefutationLineUci] = useState<string[] | null>(null);
    const [refutationStep, setRefutationStep] = useState(0);
    const [showWrongOverlay, setShowWrongOverlay] = useState(false);

    // Solve mode: context (pre-puzzle) navigation
    const [showContext, setShowContext] = useState(false);
    const [contextPly, setContextPly] = useState(0);

    const puzzlePly = useMemo(() => {
        if (!currentPuzzle) return 0;
        const raw = typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0;
        const max = sourceParsed?.moves.length ?? raw;
        return clamp(raw, 0, max);
    }, [currentPuzzle, sourceParsed?.moves.length]);

    const sourceFensToPuzzle = useMemo(() => {
        if (!sourceParsed) return null as string[] | null;
        const c = new Chess(sourceParsed.startFen);
        const out: string[] = [c.fen()];
        const plies = clamp(puzzlePly, 0, sourceParsed.moves.length);
        for (let i = 0; i < plies; i++) {
            const m = sourceParsed.moves[i];
            try {
                c.move({ from: m.from, to: m.to, promotion: m.promotion });
            } catch {
                break;
            }
            out.push(c.fen());
        }
        return out;
    }, [sourceParsed, puzzlePly]);

    const puzzleFenFromSource = useMemo(() => {
        if (sourceFensToPuzzle && sourceFensToPuzzle.length > 0) {
            const idx = clamp(puzzlePly, 0, sourceFensToPuzzle.length - 1);
            return sourceFensToPuzzle[idx] ?? null;
        }
        return currentPuzzle?.fen ?? null;
    }, [sourceFensToPuzzle, puzzlePly, currentPuzzle?.fen]);

    // PV browsing (Solve + Analyze)
    const [pvStep, setPvStep] = useState(0);

    // Analyze mode
    const [analysisHistory, setAnalysisHistory] = useState<string[]>([]);
    const [analysisHistoryIdx, setAnalysisHistoryIdx] = useState(0);
    const analysisHistoryRef = useRef<string[]>([]);
    const analysisHistoryIdxRef = useRef(0);
    useEffect(() => {
        analysisHistoryRef.current = analysisHistory;
    }, [analysisHistory]);
    useEffect(() => {
        analysisHistoryIdxRef.current = analysisHistoryIdx;
    }, [analysisHistoryIdx]);
    const [analysisRootFen, setAnalysisRootFen] = useState<string | null>(null);
    const [analysisEnabled, setAnalysisEnabled] = useState(true);
    const [analysisMultiPv, setAnalysisMultiPv] = useState(3);
    const [analysisSelectedIdx, setAnalysisSelectedIdx] = useState(0);
    const [analysisSelectedKey, setAnalysisSelectedKey] = useState<string | null>(null);
    const [analyzeTrack, setAnalyzeTrack] = useState<'game' | 'pv'>('game');
    const [analyzeGamePly, setAnalyzeGamePly] = useState(0);

    // (Solve mode eval reveal & context navigation were intentionally removed to match the trainer wireframes.)

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
        setShowRealMove(false);
        setShowContext(false);
        setContextPly(typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0);

        startAttempt(currentPuzzle.id);
        setAnalyzeTrack('game');
        setAnalyzeGamePly(typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0);
        setAnalysisRootFen(currentPuzzle.fen);
        setAnalysisHistory([currentPuzzle.fen]);
        setAnalysisHistoryIdx(0);
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

    const solveExplorerLine = useMemo(() => {
        if (!currentPuzzle) return [] as string[];
        return currentPuzzle.bestLineUci;
    }, [currentPuzzle]);

    const solveLineApplied = useMemo(() => {
        if (!currentPuzzle) return [];
        return applyUciLine(currentPuzzle.fen, solveExplorerLine, 16);
    }, [currentPuzzle, solveExplorerLine]);

    const refutationApplied = useMemo(() => {
        if (viewMode !== 'solve') return [];
        if (attemptResult !== 'incorrect') return [];
        return applyUciLine(attemptFen, refutationLineUci ?? [], 12);
    }, [viewMode, attemptResult, attemptFen, refutationLineUci]);

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

    const analyzeMaxStep = useMemo(() => {
        return Math.max(0, analyzeApplied.length - 1);
    }, [analyzeApplied.length]);

    const canAnalyzePrev = useMemo(() => {
        if (viewMode !== 'analyze') return false;
        if (analyzeTrack === 'pv') return pvStep > 0 || puzzlePly > 0;
        return analyzeGamePly > 0;
    }, [viewMode, analyzeTrack, pvStep, puzzlePly, analyzeGamePly]);

    const canAnalyzeNext = useMemo(() => {
        if (viewMode !== 'analyze') return false;
        if (analyzeTrack === 'pv') return pvStep < analyzeMaxStep;
        if (analyzeGamePly < puzzlePly) return true;
        // at puzzle position: can step into PV if any moves exist
        return analyzeMaxStep > 0;
    }, [viewMode, analyzeTrack, pvStep, analyzeMaxStep, analyzeGamePly, puzzlePly]);

    const goToAnalyzePvStep = useCallback(
        (step: number) => {
            if (viewMode !== 'analyze') return;
            if (puzzleFenFromSource) {
                setAnalysisRootFen(puzzleFenFromSource);
                setAnalysisHistory([puzzleFenFromSource]);
                setAnalysisHistoryIdx(0);
            }
            setAnalyzeTrack('pv');
            setAnalyzeGamePly(puzzlePly);
            setPvStep(clamp(step, 0, analyzeMaxStep));
        },
        [viewMode, puzzleFenFromSource, puzzlePly, analyzeMaxStep]
    );

    const analyzePrev = useCallback(() => {
        if (viewMode !== 'analyze') return;
        if (analyzeTrack === 'pv') {
            if (pvStep > 0) {
                setPvStep((s) => Math.max(0, s - 1));
                return;
            }
            // PV root is the puzzle position; stepping "back" from root goes back into the real game.
            setAnalyzeTrack('game');
            setAnalyzeGamePly(Math.max(0, puzzlePly - 1));
            return;
        }
        setAnalyzeGamePly((p) => Math.max(0, p - 1));
    }, [viewMode, analyzeTrack, pvStep, puzzlePly]);

    const analyzeNext = useCallback(() => {
        if (viewMode !== 'analyze') return;
        if (analyzeTrack === 'game') {
            // If we're at the puzzle point, "next" steps into the selected PV line.
            if (analyzeGamePly >= puzzlePly && analyzeMaxStep > 0) {
                goToAnalyzePvStep(1);
                return;
            }
            // Move forward through the real game until we hit the puzzle point.
            setAnalyzeGamePly((p) => {
                if (p < puzzlePly) return p + 1;
                return p;
            });
            return;
        }
        setPvStep((s) => Math.min(analyzeMaxStep, s + 1));
    }, [viewMode, analyzeTrack, analyzeGamePly, puzzlePly, analyzeMaxStep, goToAnalyzePvStep]);

    // In analyze mode, keep the engine root synced to the currently selected *game* ply.
    // PV stepping uses a fixed root (the puzzle position).
    useEffect(() => {
        if (viewMode !== 'analyze') return;
        if (analyzeTrack !== 'game') return;
        if (!puzzleFenFromSource) return;
        if (!sourceFensToPuzzle || sourceFensToPuzzle.length === 0) {
            // Fallback: if we can't reconstruct the game, at least analyze the puzzle position.
            if (analysisRootFen !== puzzleFenFromSource) {
                setAnalysisRootFen(puzzleFenFromSource);
                setAnalysisHistory([puzzleFenFromSource]);
                setAnalysisHistoryIdx(0);
                setPvStep(0);
            }
            return;
        }
        const idx = clamp(analyzeGamePly, 0, sourceFensToPuzzle.length - 1);
        const fen = sourceFensToPuzzle[idx];
        if (fen && fen !== analysisRootFen) {
            setAnalysisRootFen(fen);
            setAnalysisHistory([fen]);
            setAnalysisHistoryIdx(0);
            setPvStep(0);
        }
    }, [
        viewMode,
        analyzeTrack,
        analyzeGamePly,
        sourceFensToPuzzle,
        puzzleFenFromSource,
        analysisRootFen,
    ]);

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
        if (analyzeTrack === 'game') {
            if (sourceFensToPuzzle && sourceFensToPuzzle.length > 0) {
                const idx = clamp(analyzeGamePly, 0, sourceFensToPuzzle.length - 1);
                return sourceFensToPuzzle[idx] ?? currentPuzzle.fen;
            }
            return puzzleFenFromSource ?? currentPuzzle.fen;
        }
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
        analyzeTrack,
        analyzeGamePly,
        sourceFensToPuzzle,
        puzzleFenFromSource,
    ]);

    const allowMove = useMemo(() => {
        if (!currentPuzzle) return false;
        if (viewMode === 'solve') return !showContext && !attemptResult && !showSolution;
        return true;
    }, [currentPuzzle, viewMode, showContext, attemptResult, showSolution]);

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
        if (rootEvalFen && rootEvalScore) {
            return { score: rootEvalScore, fenForSign: rootEvalFen };
        }
        return { score: null as Score | null, fenForSign: displayFen };
    }, [displayFen, rootEvalFen, rootEvalScore]);

    const evalText = useMemo(() => {
        return formatEval(displayEval.score, displayEval.fenForSign);
    }, [displayEval]);

    const evalUnit = useMemo(() => {
        return scoreToUnit(displayEval.score, displayEval.fenForSign);
    }, [displayEval]);

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
            const atStartFen = !!currentPuzzle && displayFen === currentPuzzle.fen;
            if (puzzleLastMove && atStartFen) {
                put({
                    startSquare: puzzleLastMove.from,
                    endSquare: puzzleLastMove.to,
                    color: 'rgba(124,58,237,0.65)',
                });
            }
            if (
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
                atStartFen &&
                showRealMove &&
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
        const atStartFen = viewMode === 'solve' && !!currentPuzzle && displayFen === currentPuzzle.fen;
        if (puzzleLastMove && atStartFen) {
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
        viewMode,
        currentPuzzle,
        displayFen,
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
        if (viewMode === 'solve') {
            // Any move exits context scrubbing.
            setShowContext(false);
        }

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
            // If it's a safe-but-not-best move, reveal best line for learning.
            if (correct && u !== best) setShowSolution(true);
            if (!correct) {
                // Trigger refutation autoplay effect.
                setRefutationLineUci(null);
                setRefutationStep(0);
                setShowWrongOverlay(false);
            }
            return;
        }

        // analyze sandbox: update root and re-run analysis
        setAnalyzeTrack('pv');
        setAnalyzeGamePly(puzzlePly);
        const prev = analysisHistoryRef.current;
        const idx = analysisHistoryIdxRef.current;
        const base = prev.slice(0, Math.max(0, Math.min(idx, prev.length - 1)) + 1);
        const next = [...base, res.fen];
        setAnalysisHistory(next);
        setAnalysisHistoryIdx(next.length - 1);
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
        setSolvedKind(null);
        setShowSolution(false);
        setShowRealMove(false);
        setShowContext(false);
        setContextPly(puzzlePly);
        setRefutationLineUci(null);
        setRefutationStep(0);
        setShowWrongOverlay(false);
        setPvStep(0);
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

    // (Refutation playback + keyboard shortcuts were intentionally removed to match the trainer wireframes.)

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
        if (openingText) parts.push(openingText);
        return parts.join(' • ');
    }, [currentPuzzle, openingText]);

    const uiFilters = useMemo<PuzzlesFilters>(() => {
        const status: PuzzlesFilters['status'] =
            trainerFilters.solved === true && trainerFilters.failed === true
                ? 'attempted'
                : trainerFilters.solved === true
                  ? 'solved'
                  : trainerFilters.failed === true
                    ? 'failed'
                    : '';
        return {
            type: trainerFilters.type,
            kind: trainerFilters.kind,
            phase: trainerFilters.phase,
            multiSolution: trainerFilters.multiSolution,
            openingEco: trainerFilters.openingEco,
            tags: trainerFilters.tags,
            status,
            gameId: trainerFilters.gameId,
        };
    }, [trainerFilters]);

    const filtersSummary = useMemo(() => describeFilters(uiFilters), [uiFilters]);

    const startFen = useMemo(() => {
        if (!currentPuzzle) return null;
        return viewMode === 'solve'
            ? currentPuzzle.fen
            : puzzleFenFromSource ?? currentPuzzle.fen;
    }, [currentPuzzle, viewMode, puzzleFenFromSource]);

    const isOffStartFen = useMemo(() => {
        if (!startFen) return false;
        return displayFen !== startFen;
    }, [displayFen, startFen]);

    const canReset = !!currentPuzzle && (isOffStartFen || showSolution || showRealMove);

    const canStepPrev = useMemo(() => {
        if (!currentPuzzle) return false;
        if (viewMode === 'analyze') return canAnalyzePrev;
        if (showContext) return contextPly > 0;
        if (isReviewState) return pvStep > 0;
        return !!sourceParsed && puzzlePly > 0;
    }, [currentPuzzle, viewMode, canAnalyzePrev, showContext, contextPly, isReviewState, pvStep, sourceParsed, puzzlePly]);

    const canStepNext = useMemo(() => {
        if (!currentPuzzle) return false;
        if (viewMode === 'analyze') return canAnalyzeNext;
        if (showContext) return contextPly < puzzlePly;
        if (isReviewState) return pvStep < Math.max(0, solveLineApplied.length - 1);
        return false;
    }, [currentPuzzle, viewMode, canAnalyzeNext, showContext, contextPly, puzzlePly, isReviewState, pvStep, solveLineApplied.length]);

    function resetAnalyzeToStart() {
        if (!currentPuzzle) return;
        const fen = puzzleFenFromSource ?? currentPuzzle.fen;
        setAnalyzeTrack('game');
        setAnalyzeGamePly(puzzlePly);
        setPvStep(0);
        setAnalysisEnabled(true);
        setAnalysisRootFen(fen);
        setAnalysisHistory([fen]);
        setAnalysisHistoryIdx(0);
    }

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
            } catch {
                if (!cancelled) {
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

    // keyboard shortcuts / navigation
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isEditableTarget(e.target)) return;
            if (!currentPuzzle) return;

            // Keep existing shortcuts
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
                if (viewMode === 'analyze') resetAnalyzeToStart();
                return;
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (viewMode === 'analyze') return analyzePrev();

                // solve
                if (showContext && sourceParsed) {
                    setContextPly((p) => Math.max(0, p - 1));
                    return;
                }
                if (!attemptResult && !isReviewState && sourceParsed && puzzlePly > 0) {
                    setShowContext(true);
                    setContextPly(Math.max(0, puzzlePly - 1));
                    return;
                }
                setPvStep((s) => Math.max(0, s - 1));
                return;
            }

            if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (viewMode === 'analyze') return analyzeNext();

                // solve
                if (showContext && sourceParsed) {
                    setContextPly((p) => {
                        const next = Math.min(puzzlePly, p + 1);
                        if (next >= puzzlePly) setShowContext(false);
                        return next;
                    });
                    return;
                }
                const max = Math.max(0, solveLineApplied.length - 1);
                setPvStep((s) => Math.min(max, s + 1));
                return;
            }

            if (e.key === 'Home') {
                if (viewMode !== 'analyze') return;
                e.preventDefault();
                setAnalyzeTrack('game');
                setAnalyzeGamePly(0);
                setPvStep(0);
                return;
            }

            if (e.key === 'End') {
                if (viewMode !== 'analyze') return;
                e.preventDefault();
                if (analyzeMaxStep > 0) {
                    setAnalyzeTrack('pv');
                    setAnalyzeGamePly(puzzlePly);
                    setPvStep(analyzeMaxStep);
                } else {
                    setAnalyzeTrack('game');
                    setAnalyzeGamePly(puzzlePly);
                    setPvStep(0);
                }
                return;
            }
        }

        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [
        currentPuzzle,
        viewMode,
        showContext,
        sourceParsed,
        puzzlePly,
        attemptResult,
        isReviewState,
        solveLineApplied.length,
        analyzePrev,
        analyzeNext,
        analyzeMaxStep,
    ]);

    const header = (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Tabs
                    value={viewMode}
                    className="flex-1"
                    onValueChange={(v) => {
                        if (v !== 'solve' && v !== 'analyze') return;
                        setViewMode(v);
                        setPvStep(0);
                        if (v === 'analyze') {
                            setAnalysisEnabled(true);
                            resetAnalyzeToStart();
                        }
                    }}
                >
                    <TabsList className="w-full">
                        <TabsTrigger className="flex-1" value="solve">
                            solve
                        </TabsTrigger>
                        <TabsTrigger className="flex-1" value="analyze">
                            analyze
                        </TabsTrigger>
                    </TabsList>
                </Tabs>

                <Button
                    type="button"
                    variant="outline"
                    className="h-10 shrink-0 gap-2 px-3"
                    onClick={() => setFiltersOpen((v) => !v)}
                    aria-expanded={filtersOpen}
                    aria-label="Filters"
                    title="Filters"
                >
                    <Filter className="h-4 w-4" />
                    <span className="max-w-[10rem] truncate text-xs text-muted-foreground">
                        {filtersSummary}
                    </span>
                </Button>
            </div>

            {filtersOpen ? (
                <div className="w-full rounded-lg border bg-card p-3">
                    <PuzzlesFilter initial={uiFilters} preserveKeys={['view']} autoApply />
                </div>
            ) : null}

            {viewMode === 'analyze' ? (
                <div className="flex items-center gap-2">
                    <div className="h-2 w-full flex-1 rounded-full bg-muted overflow-hidden">
                        <div
                            className="h-2 bg-foreground/70"
                            style={{ width: `${Math.round(evalUnit * 100)}%` }}
                        />
                    </div>
                    <div className="min-w-[3.5rem] text-right font-mono text-sm text-muted-foreground">
                        {evalText}
                    </div>
                </div>
            ) : null}
        </div>
    );

    const analysisTools =
        viewMode === 'analyze' ? (
            <div className="mt-3 space-y-2">
                <div className="space-y-2">
                    {(analysis?.lines ?? []).slice(0, Math.max(1, Math.min(5, analysisMultiPv))).map((l, i) => (
                        <button
                            key={i}
                            type="button"
                            onClick={() => {
                                setAnalysisSelectedIdx(i);
                                setAnalysisSelectedKey((l.pvUci ?? []).join(' '));
                                goToAnalyzePvStep(0);
                            }}
                            className={
                                'w-full rounded-md border bg-card px-3 py-3 text-left text-sm transition-colors ' +
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
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="w-[140px]">
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
                                        Lines {n}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <Button
                        type="button"
                        variant="outline"
                        className="h-9"
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
                        {analysisEnabled ? 'pause' : 'resume'}
                    </Button>
                </div>
            </div>
        ) : null;

    const details = currentPuzzle ? (
        <div className="mt-3 space-y-2">
            <Link
                href={`/puzzles/${currentPuzzle.id}`}
                className="block rounded-lg border bg-card p-4"
            >
                <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-[10px] font-medium uppercase text-muted-foreground">
                        {sourceGame?.provider === 'chesscom' ? 'c.com' : 'lich'}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                            {sourceGame
                                ? `${sourceGame.white.name} vs ${sourceGame.black.name}`
                                : 'Source game'}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                            {openingText ? openingText : null}
                            {openingText && sourceGame?.playedAt ? ' · ' : null}
                            {sourceGame?.playedAt
                                ? new Date(sourceGame.playedAt).toLocaleDateString()
                                : null}
                        </div>
                    </div>
                </div>
            </Link>

            <div className="flex items-center justify-between gap-3">
                <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2"
                    onClick={() => setTagsRevealed((v) => !v)}
                    aria-pressed={tagsRevealed}
                    title={tagsRevealed ? 'Hide tags' : 'Show tags'}
                >
                    {tagsRevealed ? (
                        <EyeOff className="h-4 w-4" />
                    ) : (
                        <Eye className="h-4 w-4" />
                    )}
                    <span className="ml-2 text-sm">tags</span>
                </Button>

                <Button
                    type="button"
                    variant="outline"
                    className="h-9 px-4"
                    onClick={() => void nextPuzzle()}
                    disabled={loadingNext}
                >
                    skip
                </Button>
            </div>

            {tagsRevealed ? (
                <div className="flex flex-wrap gap-1">
                    {(currentPuzzle.tags ?? []).map((t) => (
                        <Badge key={t} variant="secondary">
                            {t}
                        </Badge>
                    ))}
                </div>
            ) : null}
        </div>
    ) : null;

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
                    <div className="w-full sm:max-w-[560px]">
                    <div
                        className={
                            'relative isolate rounded-xl border bg-card p-1 sm:p-2 ' +
                            (canReset ? 'border-zinc-400' : '')
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
                                          const promotion =
                                              isPawn && promotionRank ? 'q' : undefined;

                                          const res = tryMakeMove({ from, to, promotion });
                                          if (!res) return false;
                                          applyMoveResult(res);
                                          return true;
                                      }
                                    : undefined,
                            }}
                        />

                        {viewMode === 'solve' && attemptResult === 'incorrect' && showWrongOverlay ? (
                            <div className="absolute inset-0 z-[100] flex items-center justify-center rounded-xl bg-background/70 backdrop-blur-sm">
                                <div className="mx-4 w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg">
                                    <div className="text-sm font-medium">Not best</div>
                                    <div className="mt-1 text-sm text-muted-foreground">
                                        Want to analyze this position or try again?
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        <Button
                                            onClick={() => {
                                                setShowWrongOverlay(false);
                                                setPvStep(0);
                                                setAnalysisRootFen(attemptFen);
                                                setAnalysisHistory([attemptFen]);
                                                setAnalysisHistoryIdx(0);
                                                setAnalyzeTrack('pv');
                                                setAnalyzeGamePly(puzzlePly);
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
                    </div>

                    <div className="mt-2 grid w-full grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11"
                            onClick={() => {
                                if (viewMode === 'analyze') return analyzePrev();
                                if (showContext && sourceParsed) {
                                    setContextPly((p) => Math.max(0, p - 1));
                                    return;
                                }
                                if (!attemptResult && !isReviewState && sourceParsed && puzzlePly > 0) {
                                    setShowContext(true);
                                    setContextPly(Math.max(0, puzzlePly - 1));
                                    return;
                                }
                                setPvStep((s) => Math.max(0, s - 1));
                            }}
                            disabled={!canStepPrev}
                            aria-label="Previous"
                            title="Previous"
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </Button>

                        <div className="flex min-w-0 items-center justify-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                                onClick={() => setShowRealMove((v) => !v)}
                                disabled={!realSourceMove}
                            >
                                show mistake
                            </Button>
                            {viewMode === 'solve' ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                                    onClick={() => setShowSolution(true)}
                                    disabled={!currentPuzzle}
                                >
                                    solution
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                variant="outline"
                                className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                                onClick={() => {
                                    setShowSolution(false);
                                    setShowRealMove(false);
                                    if (viewMode === 'solve') return resetSolve();
                                    resetAnalyzeToStart();
                                }}
                                disabled={!canReset}
                                aria-label="Reset"
                                title="Reset"
                            >
                                <RotateCcw className="h-4 w-4 sm:mr-2" />
                                <span className="hidden sm:inline">reset</span>
                            </Button>
                        </div>

                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11"
                            onClick={() => {
                                if (viewMode === 'analyze') return analyzeNext();
                                if (showContext && sourceParsed) {
                                    setContextPly((p) => {
                                        const next = Math.min(puzzlePly, p + 1);
                                        if (next >= puzzlePly) setShowContext(false);
                                        return next;
                                    });
                                    return;
                                }
                                const max = Math.max(0, solveLineApplied.length - 1);
                                setPvStep((s) => Math.min(max, s + 1));
                            }}
                            disabled={!canStepNext}
                            aria-label="Next"
                            title="Next"
                        >
                            <ChevronRight className="h-5 w-5" />
                        </Button>
                    </div>

                    <div className="lg:hidden">
                        {viewMode === 'analyze' ? analysisTools : null}
                        {details}
                    </div>
                </div>
            </div>

                <div className="hidden lg:block">
                    {viewMode === 'analyze' ? analysisTools : null}
                    {details}
                </div>
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
