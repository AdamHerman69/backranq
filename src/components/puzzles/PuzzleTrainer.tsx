'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chess, type Square } from 'chess.js';
import { Loader2 } from 'lucide-react';
import { Chessboard } from 'react-chessboard';

import type { NormalizedGame } from '@/lib/types/game';
import type { Puzzle } from '@/lib/analysis/puzzles';
import type { PuzzleAttemptStats } from '@/lib/api/puzzles';
import {
    StockfishClient,
    type Score,
} from '@/lib/analysis/stockfishClient';
import { useStockfishLiveMultiPvAnalysis } from '@/lib/hooks/useStockfishLiveMultiPvAnalysis';
import { useRandomPuzzles } from '@/lib/api/usePuzzles';
import { usePuzzleAttempt } from '@/lib/hooks/usePuzzleAttempt';
import {
    applyUciLine,
    moveToUci,
    parseUci,
    sideToMoveFromFen,
    uciToSan,
} from '@/lib/chess/utils';
import { ecoName } from '@/lib/chess/eco';

import { Button } from '@/components/ui/button';
import type { PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';
import type { PreferencesSchema } from '@/lib/preferences';
import {
    classifyPuzzleMove,
    isStateForPuzzle,
    legalPromotionChoices,
    appendAnalysisBranch,
    analysisHistoryStepLabel,
} from '@/lib/puzzles/trainerUx';
import type { PuzzleNonMoveOutcome } from '@/lib/puzzles/attemptOutcomes';
import { PuzzleTrainerAnalysisTools } from '@/components/puzzles/PuzzleTrainerAnalysisTools';
import {
    PuzzleTrainerBoardControls,
    PuzzleTrainerBoardFeedback,
    PuzzleTrainerDialogs,
    PuzzleTrainerWrongMoveOverlay,
} from '@/components/puzzles/PuzzleTrainerBoardUi';
import { PuzzleTrainerDetails } from '@/components/puzzles/PuzzleTrainerDetails';
import { PuzzleTrainerHeader } from '@/components/puzzles/PuzzleTrainerHeader';
import {
    clamp,
    dbGameToNormalizedLoose,
    describeFilters,
    findPuzzleLastMove,
    formatEval,
    isEditableTarget,
    parseCsv,
    parsePuzzleAttempts,
    parsePuzzleAttemptStats,
    parseSourceGame,
    scoreToUnit,
    uciToArrow,
    type PuzzleAttemptRow,
    type SourceParsed,
    type TrainerFilters,
    type VerboseMove,
    toRecord,
} from '@/components/puzzles/puzzleTrainerUtils';

type TrainerViewMode = 'solve' | 'analyze';

export function PuzzleTrainer({
    initialViewMode,
}: {
    initialViewMode: TrainerViewMode;
}) {
    const pathname = usePathname();
    const sp = useSearchParams();
    const trainerRootRef = useRef<HTMLDivElement | null>(null);

    const { getRandom, loading: loadingNext, error: randomError } = useRandomPuzzles();

    const engineRef = useRef<StockfishClient | null>(null);
    const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);

    const {
        startAttempt,
        recordAttempt,
        recordOutcome,
        flushQueue,
        queued: queuedAttempts,
        lastError: attemptSyncError,
        online: attemptOnline,
        syncState: attemptSyncState,
    } = usePuzzleAttempt();

    const initialAnalyzeRequestedRef = useRef(initialViewMode === 'analyze');
    const [viewState, setViewState] = useState<{
        puzzleId: string | null;
        mode: TrainerViewMode;
    }>({ puzzleId: null, mode: 'solve' });
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [tagsRevealedForId, setTagsRevealedForId] = useState<string | null>(
        null
    );
    const [statsVisibleForId, setStatsVisibleForId] = useState<string | null>(
        null
    );
    const [contextHintsEnabled, setContextHintsEnabled] = useState(false);
    const [preferencesLoading, setPreferencesLoading] = useState(true);
    const [boardFlipped, setBoardFlipped] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [disclosureState, setDisclosureState] = useState<{
        puzzleId: string;
        type: 'solution' | 'analyze';
    } | null>(null);
    const showPuzzleStatsRef = useRef(false);

    const [queue, setQueue] = useState<Puzzle[]>([]);
    const [idx, setIdx] = useState(0);

    const currentPuzzle = queue[idx] ?? null;
    const currentPuzzleId = currentPuzzle?.id ?? null;
    const viewMode =
        viewState.puzzleId === currentPuzzleId ? viewState.mode : 'solve';
    const setViewMode = useCallback(
        (mode: TrainerViewMode) => {
            setViewState({ puzzleId: currentPuzzleId, mode });
        },
        [currentPuzzleId]
    );
    const disclosurePrompt =
        disclosureState?.puzzleId === currentPuzzleId
            ? disclosureState.type
            : null;
    const tagsRevealed = isStateForPuzzle(
        tagsRevealedForId,
        currentPuzzleId
    );
    const showPuzzleStats = isStateForPuzzle(
        statsVisibleForId,
        currentPuzzleId
    );
    const [directLoadError, setDirectLoadError] = useState<string | null>(null);
    const [sessionComplete, setSessionComplete] = useState(false);
    const [sessionCounts, setSessionCounts] = useState({
        solved: 0,
        missed: 0,
        revealed: 0,
        skipped: 0,
    });
    const countedPuzzleRef = useRef<Set<string>>(new Set());
    const persistentOutcomeByPuzzleRef = useRef<
        Map<string, PuzzleNonMoveOutcome>
    >(new Map());

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
    useEffect(() => {
        showPuzzleStatsRef.current = showPuzzleStats;
    }, [showPuzzleStats]);

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
    const trainerOpeningEcoKey = trainerFilters.openingEco.join(',');
    const trainerTagsKey = trainerFilters.tags.join(',');
    const trainerSolvedKey = String(trainerFilters.solved);
    const trainerFailedKey = String(trainerFilters.failed);

    const sourceRequestIdRef = useRef(0);
    const [sourceStateForId, setSourceStateForId] = useState<string | null>(null);
    const [sourceGameRaw, setSourceGame] = useState<NormalizedGame | null>(null);
    const [sourceParsedRaw, setSourceParsed] = useState<SourceParsed | null>(null);
    const [sourceLoadingRaw, setSourceLoading] = useState(false);
    const [sourceErrorRaw, setSourceError] = useState<string | null>(null);
    const [sourceRetryNonce, setSourceRetryNonce] = useState(0);
    const currentSourceGameId = currentPuzzle?.sourceGameId ?? null;
    const currentSourceGameIdRef = useRef<string | null>(currentSourceGameId);
    currentSourceGameIdRef.current = currentSourceGameId;
    const sourceStateIsCurrent = sourceStateForId === currentSourceGameId;
    const sourceGame = sourceStateIsCurrent ? sourceGameRaw : null;
    const sourceParsed = sourceStateIsCurrent ? sourceParsedRaw : null;
    const sourceLoading = sourceStateIsCurrent ? sourceLoadingRaw : true;
    const sourceError = sourceStateIsCurrent ? sourceErrorRaw : null;

    const [attemptStateForId, setAttemptStateForId] = useState<string | null>(
        null
    );
    const [attemptFenRaw, setAttemptFen] = useState<string>(new Chess().fen());
    const [attemptLastMoveRaw, setAttemptLastMove] = useState<{ from: Square; to: Square } | null>(null);
    const [attemptUciRaw, setAttemptUci] = useState<string | null>(null);
    const [attemptResultRaw, setAttemptResult] = useState<'correct' | 'incorrect' | null>(null);
    const [attemptFeedbackRaw, setAttemptFeedback] = useState<
        'best' | 'accepted' | 'wrong' | null
    >(null);
    const [localOutcomeRaw, setLocalOutcome] = useState<
        'solved' | 'failed' | 'revealed' | 'skipped' | null
    >(null);
    const [hintForId, setHintForId] = useState<string | null>(null);
    const [solutionVisibleForId, setSolutionVisibleForId] = useState<
        string | null
    >(null);

    // Source-game reveal (the move that was actually played in the source game)
    const [sourceMoveVisibleForId, setSourceMoveVisibleForId] = useState<
        string | null
    >(null);
    const attemptStateIsCurrent = isStateForPuzzle(
        attemptStateForId,
        currentPuzzleId
    );
    const attemptFen = attemptStateIsCurrent
        ? attemptFenRaw
        : currentPuzzle?.fen ?? attemptFenRaw;
    const attemptLastMove = attemptStateIsCurrent ? attemptLastMoveRaw : null;
    const attemptUci = attemptStateIsCurrent ? attemptUciRaw : null;
    const attemptResult = attemptStateIsCurrent ? attemptResultRaw : null;
    const attemptFeedback = attemptStateIsCurrent ? attemptFeedbackRaw : null;
    const localOutcome = attemptStateIsCurrent ? localOutcomeRaw : null;
    const hintLevel = hintForId === currentPuzzleId ? 1 : 0;
    const showSolution = isStateForPuzzle(
        solutionVisibleForId,
        currentPuzzleId
    );
    const showRealMove = isStateForPuzzle(
        sourceMoveVisibleForId,
        currentPuzzleId
    );

    const statsCacheRef = useRef<
        Map<string, { stats: PuzzleAttemptStats; attempts: PuzzleAttemptRow[] }>
    >(new Map());
    const [puzzleStatsLoading, setPuzzleStatsLoading] = useState(false);
    const [puzzleStatsError, setPuzzleStatsError] = useState<string | null>(null);
    const [puzzleStats, setPuzzleStats] = useState<PuzzleAttemptStats | null>(null);
    const [puzzleAttempts, setPuzzleAttempts] = useState<PuzzleAttemptRow[]>([]);
    const [statsRefreshNonce, setStatsRefreshNonce] = useState(0);

    // Solve mode: wrong-move refutation playback + overlay
    const [refutationLineUci, setRefutationLineUci] = useState<string[] | null>(null);
    const [refutationStep, setRefutationStep] = useState(0);
    const [showWrongOverlay, setShowWrongOverlay] = useState(false);
    const [refutationLoading, setRefutationLoading] = useState(false);
    const [refutationError, setRefutationError] = useState<string | null>(null);

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
    const [pendingPromotionState, setPendingPromotion] = useState<{
        puzzleId: string;
        from: Square;
        to: Square;
        choices: Array<'q' | 'r' | 'b' | 'n'>;
    } | null>(null);
    const pendingPromotion =
        pendingPromotionState?.puzzleId === currentPuzzleId
            ? pendingPromotionState
            : null;

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

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        let cancelled = false;
        async function loadPreferences() {
            setPreferencesLoading(true);
            try {
                const response = await fetch('/api/user/preferences', {
                    cache: 'no-store',
                });
                const body = (await response.json().catch(() => ({}))) as {
                    preferences?: PreferencesSchema;
                };
                if (!response.ok) throw new Error('Failed to load preferences');
                if (!cancelled) {
                    setContextHintsEnabled(
                        body.preferences?.trainerContextHintsEnabled === true
                    );
                }
            } catch {
                if (!cancelled) setContextHintsEnabled(false);
            } finally {
                if (!cancelled) setPreferencesLoading(false);
            }
        }
        void loadPreferences();
        return () => {
            cancelled = true;
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

    const fetchNextPuzzle = useCallback(async () => {
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
    }, [
        getRandom,
        queue,
        trainerFilters.type,
        trainerFilters.kind,
        trainerFilters.phase,
        trainerFilters.multiSolution,
        trainerFilters.openingEco,
        trainerFilters.tags,
        trainerFilters.solved,
        trainerFilters.failed,
        trainerFilters.gameId,
    ]);

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
        setSessionComplete(false);
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
                setDirectLoadError(null);
                setQueue([p]);
                setIdx(0);
            } else if (ensureOneRequestIdRef.current === requestId) {
                setSessionComplete(true);
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
        trainerOpeningEcoKey,
        trainerTagsKey,
        trainerSolvedKey,
        trainerFailedKey,
        trainerFilters.gameId,
    ]);

    // reset per-puzzle state
    useEffect(() => {
        if (!currentPuzzle) return;
        setViewMode('solve');
        setAttemptStateForId(currentPuzzle.id);
        setAttemptFen(currentPuzzle.fen);
        setAttemptLastMove(null);
        setAttemptUci(null);
        setAttemptResult(null);
        setAttemptFeedback(null);
        const persistedOutcome =
            persistentOutcomeByPuzzleRef.current.get(currentPuzzle.id) ??
            (
            currentPuzzle as Puzzle & {
                attemptStats?: PuzzleAttemptStats;
            }
        ).attemptStats?.outcome;
        if (
            persistedOutcome === 'revealed' ||
            persistedOutcome === 'skipped'
        ) {
            persistentOutcomeByPuzzleRef.current.set(
                currentPuzzle.id,
                persistedOutcome
            );
        }
        setLocalOutcome(
            persistedOutcome === 'revealed' || persistedOutcome === 'skipped'
                ? persistedOutcome
                : null
        );
        setHintForId(null);
        setSolutionVisibleForId(null);
        setTagsRevealedForId(null);
        setStatsVisibleForId(null);
        setRefutationLineUci(null);
        setRefutationStep(0);
        setShowWrongOverlay(false);
        setRefutationLoading(false);
        setRefutationError(null);
        setPendingPromotion(null);
        setDisclosureState(null);
        if (initialAnalyzeRequestedRef.current) {
            initialAnalyzeRequestedRef.current = false;
            setDisclosureState({
                puzzleId: currentPuzzle.id,
                type: 'analyze',
            });
        }
        setPvStep(0);
        setAnalysisSelectedIdx(0);
        setAnalysisSelectedKey(null);
        setAnalysisEnabled(true);
        setSelectedSquare(null);
        setLegalTargets(new Set());
        setSourceMoveVisibleForId(null);
        setShowContext(false);
        setBoardFlipped(false);
        setContextPly(typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0);

        startAttempt(currentPuzzle.id);
        setAnalyzeTrack('game');
        setAnalyzeGamePly(typeof currentPuzzle.sourcePly === 'number' ? currentPuzzle.sourcePly : 0);
        setAnalysisRootFen(currentPuzzle.fen);
        setAnalysisHistory([currentPuzzle.fen]);
        setAnalysisHistoryIdx(0);
    }, [currentPuzzle, setViewMode, startAttempt]);

    // Always load source game
    useEffect(() => {
        const sourceGameId = currentPuzzle?.sourceGameId ?? null;
        const requestId = ++sourceRequestIdRef.current;
        async function run() {
            setSourceStateForId(sourceGameId);
            setSourceGame(null);
            setSourceParsed(null);
            setSourceError(null);
            if (!sourceGameId) {
                setSourceGame(null);
                setSourceParsed(null);
                setSourceError(null);
                setSourceLoading(false);
                return;
            }
            setSourceLoading(true);
            try {
                const res = await fetch(`/api/games/${sourceGameId}`);
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
                if (
                    sourceRequestIdRef.current !== requestId ||
                    currentSourceGameIdRef.current !== sourceGameId
                )
                    return;
                setSourceGame(ng);
                setSourceParsed(parsed);
            } catch (e) {
                if (
                    sourceRequestIdRef.current !== requestId ||
                    currentSourceGameIdRef.current !== sourceGameId
                )
                    return;
                setSourceGame(null);
                setSourceParsed(null);
                setSourceError(
                    e instanceof Error ? e.message : 'Failed to load source game'
                );
            } finally {
                if (
                    sourceRequestIdRef.current === requestId &&
                    currentSourceGameIdRef.current === sourceGameId
                ) {
                    setSourceLoading(false);
                }
            }
        }
        void run();
        return () => {
            if (sourceRequestIdRef.current === requestId) {
                sourceRequestIdRef.current += 1;
            }
        };
    }, [currentPuzzle?.sourceGameId, sourceRetryNonce]);

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
        if (!currentPuzzle) return '';
        return acceptedMoves
            .slice(0, 8)
            .map((uci) => uciToSan(currentPuzzle.fen, uci) ?? uci)
            .join(' ');
    }, [acceptedMoves, currentPuzzle]);

    const bestMoveSan = useMemo(() => {
        if (!currentPuzzle) return '';
        return uciToSan(currentPuzzle.fen, currentPuzzle.bestMoveUci) ?? currentPuzzle.bestMoveUci;
    }, [currentPuzzle]);

    const autoOrientation = useMemo(() => {
        if (!currentPuzzle) return 'white' as const;
        const stm = sideToMoveFromFen(currentPuzzle.fen);
        return stm === 'b' ? ('black' as const) : ('white' as const);
    }, [currentPuzzle]);
    const orientation =
        boardFlipped
            ? autoOrientation === 'white'
                ? ('black' as const)
                : ('white' as const)
            : autoOrientation;
    const sideToMoveLabel =
        currentPuzzle && sideToMoveFromFen(currentPuzzle.fen) === 'b'
            ? 'Black'
            : 'White';

    const puzzleLastMove = useMemo(() => {
        if (!currentPuzzle || !sourceParsed) return null;
        return findPuzzleLastMove({ puzzle: currentPuzzle, source: sourceParsed });
    }, [currentPuzzle, sourceParsed]);

    const isReviewState = attemptResult === 'correct' || showSolution;
    const reviewUnlocked =
        attemptResult !== null ||
        showSolution ||
        localOutcome === 'revealed' ||
        localOutcome === 'skipped';

    const sourcePlyRaw = useMemo(() => {
        const v = currentPuzzle?.sourcePly;
        if (typeof v !== 'number') return null;
        if (!Number.isFinite(v)) return null;
        return Math.trunc(v);
    }, [currentPuzzle?.sourcePly]);

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

    const fenAfterMistake = useMemo(() => {
        if (!currentPuzzle?.fen || !realSourceMove) return null;
        const c = new Chess(currentPuzzle.fen);
        try {
            c.move({ from: realSourceMove.from, to: realSourceMove.to, promotion: realSourceMove.promotion });
            return c.fen();
        } catch {
            return null;
        }
    }, [currentPuzzle?.fen, realSourceMove]);

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

    const analysis =
        liveAnalyze.update?.fen === analysisRootFen ? liveAnalyze.update : null;
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
        puzzlePly,
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
    const currentAnalysis =
        analysisRootFen !== null && displayFen === analysisRootFen
            ? analysis
            : null;

    const allowMove = useMemo(() => {
        if (!currentPuzzle) return false;
        if (viewMode === 'solve') return !showContext && !attemptResult && !showSolution;
        return true;
    }, [currentPuzzle, viewMode, showContext, attemptResult, showSolution]);

    const rootEvalFen = useMemo(() => {
        if (viewMode === 'solve') return currentPuzzle?.fen ?? null;
        return currentAnalysis?.fen ?? analysisRootFen ?? null;
    }, [viewMode, currentPuzzle?.fen, currentAnalysis?.fen, analysisRootFen]);

    const rootEvalScore = useMemo(() => {
        if (viewMode === 'solve') return currentPuzzle?.score ?? null;
        const line =
            currentAnalysis?.lines[selectedLine] ?? currentAnalysis?.lines[0];
        return line?.score ?? null;
    }, [viewMode, currentPuzzle?.score, currentAnalysis, selectedLine]);

    const displayEval = useMemo(() => {
        if (
            viewMode === 'analyze' &&
            (!rootEvalFen || rootEvalFen !== displayFen)
        ) {
            return { score: null as Score | null, fenForSign: displayFen };
        }
        if (rootEvalFen && rootEvalScore) {
            return { score: rootEvalScore, fenForSign: rootEvalFen };
        }
        return { score: null as Score | null, fenForSign: displayFen };
    }, [displayFen, rootEvalFen, rootEvalScore, viewMode]);

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
            if (
                attemptLastMove &&
                (attemptResult !== 'incorrect' || displayFen === attemptFen)
            ) {
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

        const atAnalysisRoot =
            Boolean(analysisRootFen) && displayFen === analysisRootFen;
        if (!atAnalysisRoot) return [];

        // analyze: one arrow per line's first move
        const lines = currentAnalysis?.lines ?? [];
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
        currentAnalysis,
        selectedLine,
        analysisRootFen,
        attemptFen,
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
        if (hintLevel > 0 && currentPuzzle) {
            const hintMove = parseUci(currentPuzzle.bestMoveUci);
            if (hintMove) {
                s[hintMove.from] = {
                    ...(s[hintMove.from] ?? {}),
                    boxShadow: 'inset 0 0 0 4px rgba(245,158,11,0.78)',
                };
            }
        }
        const dot =
            'radial-gradient(circle at center, rgba(124,58,237,0.55) 0 18%, rgba(0,0,0,0) 20%)';
        const captureRing =
            'radial-gradient(circle at center, transparent 0 54%, rgba(124,58,237,0.72) 56% 68%, transparent 70%)';
        const board = new Chess(displayFen);
        for (const t of legalTargets) {
            if (!s[t]) s[t] = {};
            const prev = s[t].backgroundImage as string | undefined;
            const marker = board.get(t) ? captureRing : dot;
            s[t].backgroundImage = prev ? `${marker}, ${prev}` : marker;
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
        hintLevel,
    ]);

    const recordLocalOutcome = useCallback((outcome: 'solved' | 'failed' | 'revealed' | 'skipped') => {
        if (currentPuzzle?.id) setAttemptStateForId(currentPuzzle.id);
        if (
            currentPuzzle?.id &&
            (outcome === 'revealed' || outcome === 'skipped')
        ) {
            persistentOutcomeByPuzzleRef.current.set(
                currentPuzzle.id,
                outcome
            );
        }
        setLocalOutcome(outcome);
        const puzzleId = currentPuzzle?.id;
        if (!puzzleId || countedPuzzleRef.current.has(puzzleId)) return;
        countedPuzzleRef.current.add(puzzleId);
        setSessionCounts((current) => ({
            ...current,
            [outcome === 'solved'
                ? 'solved'
                : outcome === 'failed'
                  ? 'missed'
                  : outcome]:
                current[
                    outcome === 'solved'
                        ? 'solved'
                        : outcome === 'failed'
                          ? 'missed'
                          : outcome
                ] + 1,
        }));
    }, [currentPuzzle?.id]);

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
            if (currentPuzzle?.id) setAttemptStateForId(currentPuzzle.id);
            setAttemptFen(res.fen);
            setAttemptLastMove(res.lastMove);
            setAttemptUci(res.uci);
            const u = res.uci.trim().toLowerCase();
            const best = (currentPuzzle?.bestMoveUci ?? '').trim().toLowerCase();
            const accepted = new Set(acceptedMoves);
            const feedback = classifyPuzzleMove({
                move: u,
                bestMove: best,
                acceptedMoves: Array.from(accepted),
            });
            const correct = feedback !== 'wrong';
            setAttemptResult(correct ? 'correct' : 'incorrect');
            setAttemptFeedback(feedback);
            const isPersistentOutcome =
                localOutcome === 'revealed' || localOutcome === 'skipped';
            if (!isPersistentOutcome) {
                recordLocalOutcome(correct ? 'solved' : 'failed');
            }
            setPvStep(0);
            if (correct && currentPuzzle?.id) {
                setSolutionVisibleForId(currentPuzzle.id);
            }
            if (!correct) {
                setRefutationLineUci(null);
                setRefutationStep(0);
                setShowWrongOverlay(true);
                setRefutationError(null);
            }
            return;
        }

        // analyze sandbox: update root and re-run analysis
        setAnalyzeTrack('pv');
        setAnalyzeGamePly(puzzlePly);
        const prev = analysisHistoryRef.current;
        const idx = analysisHistoryIdxRef.current;
        const next = appendAnalysisBranch({
            history: prev,
            historyIndex: idx,
            displayedFen: displayFen,
            nextFen: res.fen,
        });
        setAnalysisHistory(next);
        setAnalysisHistoryIdx(next.length - 1);
        setAnalysisRootFen(res.fen);
        setPvStep(0);
    }

    const clearHints = useCallback(() => {
        setSelectedSquare(null);
        setLegalTargets(new Set());
    }, []);

    function computeHints(square: Square) {
        if (!allowMove) return;
        const c = new Chess(displayFen);
        const piece = c.get(square);
        if (!piece || piece.color !== c.turn()) {
            clearHints();
            return;
        }
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

    function getPromotionChoices(from: Square, to: Square) {
        const chess = new Chess(displayFen);
        const moves = chess.moves({
            square: from,
            verbose: true,
        }) as unknown as VerboseMove[];
        return legalPromotionChoices(
            moves.map((move) => ({
                from: move.from,
                to: move.to,
                promotion: move.promotion,
            })),
            from,
            to
        );
    }

    function playOrChoosePromotion(from: Square, to: Square) {
        const choices = getPromotionChoices(from, to);
        if (choices.length > 0 && currentPuzzleId) {
            setPendingPromotion({ puzzleId: currentPuzzleId, from, to, choices });
            return false;
        }
        const result = tryMakeMove({ from, to });
        if (!result) return false;
        applyMoveResult(result);
        return true;
    }

    function choosePromotion(promotion: 'q' | 'r' | 'b' | 'n') {
        if (!pendingPromotion) return;
        if (!pendingPromotion.choices.includes(promotion)) return;
        const result = tryMakeMove({
            from: pendingPromotion.from,
            to: pendingPromotion.to,
            promotion,
        });
        setPendingPromotion(null);
        if (result) applyMoveResult(result);
    }

    const nextPuzzle = useCallback(async () => {
        if (currentPuzzleId && !localOutcome && !attemptResult) {
            recordLocalOutcome('skipped');
            void recordOutcome({
                puzzleId: currentPuzzleId,
                outcome: 'skipped',
            });
        }
        if (idx < queue.length - 1) {
            setIdx((value) => Math.min(queue.length - 1, value + 1));
            setSessionComplete(false);
            return;
        }
        const next = await fetchNextPuzzle();
        if (!next) {
            setSessionComplete(true);
            return;
        }
        setSessionComplete(false);
        setQueue((prev) => [...prev, next]);
        setIdx((prev) => prev + 1);
    }, [
        attemptResult,
        currentPuzzleId,
        fetchNextPuzzle,
        idx,
        localOutcome,
        queue.length,
        recordLocalOutcome,
        recordOutcome,
    ]);

    const resetSolve = useCallback(() => {
        if (!currentPuzzle) return;
        setAttemptStateForId(currentPuzzle.id);
        setAttemptFen(currentPuzzle.fen);
        setAttemptLastMove(null);
        setAttemptUci(null);
        setAttemptResult(null);
        setAttemptFeedback(null);
        setLocalOutcome(null);
        setHintForId(null);
        setSolutionVisibleForId(null);
        setSourceMoveVisibleForId(null);
        setShowContext(false);
        setContextPly(puzzlePly);
        setRefutationLineUci(null);
        setRefutationStep(0);
        setShowWrongOverlay(false);
        setRefutationLoading(false);
        setRefutationError(null);
        setPendingPromotion(null);
        setPvStep(0);
        clearHints();
        startAttempt(currentPuzzle.id);
    }, [clearHints, currentPuzzle, puzzlePly, startAttempt]);

    // record attempt after a solve move
    useEffect(() => {
        if (!currentPuzzleId || !attemptUci || !attemptResult) return;
        const pid = currentPuzzleId;
        void (async () => {
            await recordAttempt({
                puzzleId: pid,
                move: attemptUci,
                correct: attemptResult === 'correct',
            });
            // Stats are derived from attempts; bust cache and refresh if visible.
            statsCacheRef.current.delete(pid);
            if (showPuzzleStatsRef.current) {
                setStatsRefreshNonce((nonce) => nonce + 1);
            }
        })();
    }, [currentPuzzleId, attemptUci, attemptResult, recordAttempt]);

    // Load puzzle stats on demand (toggle).
    useEffect(() => {
        let cancelled = false;
        async function run() {
            if (!showPuzzleStats) return;
            if (!currentPuzzle?.id) return;
            const pid = currentPuzzle.id;

            const cached = statsCacheRef.current.get(pid);
            if (cached) {
                setPuzzleStats(cached.stats);
                setPuzzleAttempts(cached.attempts);
                setPuzzleStatsError(null);
                return;
            }

            setPuzzleStatsLoading(true);
            setPuzzleStatsError(null);
            try {
                const res = await fetch(`/api/puzzles/${encodeURIComponent(pid)}`);
                const json = toRecord(await res.json().catch(() => ({})));
                if (!res.ok)
                    throw new Error(
                        typeof json.error === 'string'
                            ? json.error
                            : 'Failed to load puzzle stats'
                    );
                const stats = parsePuzzleAttemptStats(
                    toRecord(json.puzzle).attemptStats
                );
                const attempts = parsePuzzleAttempts(json.attempts);
                if (cancelled) return;
                if (stats) {
                    statsCacheRef.current.set(pid, { stats, attempts });
                    setPuzzleStats(stats);
                    setPuzzleAttempts(attempts);
                } else {
                    setPuzzleStats(null);
                    setPuzzleAttempts([]);
                }
            } catch (e) {
                if (cancelled) return;
                setPuzzleStatsError(
                    e instanceof Error ? e.message : 'Failed to load puzzle stats'
                );
            } finally {
                if (!cancelled) setPuzzleStatsLoading(false);
            }
        }
        void run();
        return () => {
            cancelled = true;
        };
    }, [showPuzzleStats, currentPuzzle?.id, statsRefreshNonce]);

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

    const resetAnalyzeToStart = useCallback(() => {
        if (!currentPuzzle) return;
        const fen = puzzleFenFromSource ?? currentPuzzle.fen;
        setAnalyzeTrack('game');
        setAnalyzeGamePly(puzzlePly);
        setPvStep(0);
        setAnalysisEnabled(true);
        setAnalysisRootFen(fen);
        setAnalysisHistory([fen]);
        setAnalysisHistoryIdx(0);
    }, [currentPuzzle, puzzleFenFromSource, puzzlePly]);

    const revealSolution = useCallback(() => {
        if (currentPuzzleId) setSolutionVisibleForId(currentPuzzleId);
        setDisclosureState(null);
        if (!attemptResult && currentPuzzleId && localOutcome !== 'revealed') {
            recordLocalOutcome('revealed');
            void recordOutcome({
                puzzleId: currentPuzzleId,
                outcome: 'revealed',
            });
        }
    }, [
        attemptResult,
        currentPuzzleId,
        localOutcome,
        recordLocalOutcome,
        recordOutcome,
    ]);

    function enterAnalyzeMode() {
        setDisclosureState(null);
        if (!attemptResult && currentPuzzleId && localOutcome !== 'revealed') {
            recordLocalOutcome('revealed');
            void recordOutcome({
                puzzleId: currentPuzzleId,
                outcome: 'revealed',
            });
        }
        setViewMode('analyze');
        setPvStep(0);
        setAnalysisEnabled(true);
        resetAnalyzeToStart();
    }

    function requestAnalyzeMode() {
        if (reviewUnlocked) {
            enterAnalyzeMode();
            return;
        }
        if (currentPuzzleId) {
            setDisclosureState({
                puzzleId: currentPuzzleId,
                type: 'analyze',
            });
        }
    }

    function toggleSourceMove() {
        if (viewMode === 'solve') {
            setSourceMoveVisibleForId(showRealMove ? null : currentPuzzleId);
            return;
        }
        if (showRealMove) {
            setSourceMoveVisibleForId(null);
            resetAnalyzeToStart();
            return;
        }
        if (!fenAfterMistake) return;
        setSourceMoveVisibleForId(currentPuzzleId);
        setAnalyzeTrack('pv');
        setAnalyzeGamePly(puzzlePly);
        setAnalysisRootFen(fenAfterMistake);
        setAnalysisHistory([fenAfterMistake]);
        setAnalysisHistoryIdx(0);
        setPvStep(0);
    }

    async function loadRefutation() {
        if (attemptResult !== 'incorrect' || refutationLoading) return;
        setRefutationLoading(true);
        setRefutationError(null);
        try {
            let client = engineClient;
            if (!client) {
                client = new StockfishClient();
                engineRef.current = client;
                setEngineClient(client);
            }
            const result = await client.analyzeMultiPv({
                fen: attemptFen,
                movetimeMs: 300,
                multiPv: 1,
            });
            const line = result.lines?.[0]?.pvUci?.slice(0, 10) ?? [];
            setRefutationLineUci(line);
            setRefutationStep(line.length > 0 ? 1 : 0);
            setShowWrongOverlay(false);
            if (line.length === 0) {
                setRefutationError('No refutation line was returned.');
            }
        } catch (error) {
            setRefutationError(
                error instanceof Error
                    ? error.message
                    : 'Could not calculate a refutation'
            );
        } finally {
            setRefutationLoading(false);
        }
    }

    // keyboard shortcuts / navigation
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isEditableTarget(e.target)) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (pendingPromotion || disclosurePrompt || showWrongOverlay) return;
            if (!currentPuzzle) return;

            // Keep existing shortcuts
            if (e.key === 'n') {
                e.preventDefault();
                void nextPuzzle();
                return;
            }
            if (e.key === 's') {
                e.preventDefault();
                if (viewMode === 'solve') {
                    if (reviewUnlocked) revealSolution();
                    else if (currentPuzzleId) {
                        setDisclosureState({
                            puzzleId: currentPuzzleId,
                            type: 'solution',
                        });
                    }
                }
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

        const root = trainerRootRef.current;
        root?.addEventListener('keydown', onKeyDown);
        return () => root?.removeEventListener('keydown', onKeyDown);
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
        nextPuzzle,
        resetAnalyzeToStart,
        resetSolve,
        reviewUnlocked,
        revealSolution,
        pendingPromotion,
        disclosurePrompt,
        showWrongOverlay,
        currentPuzzleId,
    ]);

    const analysisTrackLabel =
        showRealMove && analyzeTrack === 'pv'
            ? 'Source move position'
            : analyzeTrack === 'game'
              ? `Source game · ply ${analyzeGamePly}`
              : analysisHistory.length > 1
                ? analysisHistoryStepLabel({
                      historyLength: analysisHistory.length,
                      historyIndex: analysisHistoryIdx,
                  })
                : `Engine line · step ${pvStep}`;
    const engineStatus = !analysisEnabled
        ? 'Engine paused'
        : liveAnalyze.error
          ? `Engine error: ${liveAnalyze.error}`
          : liveAnalyze.running
            ? `Engine analyzing${
                  typeof liveAnalyze.depth === 'number'
                      ? ` · depth ${liveAnalyze.depth}`
                      : ''
              }`
            : engineClient
              ? 'Engine ready'
              : 'Engine loading…';
    const header = (
        <PuzzleTrainerHeader
            viewMode={viewMode}
            onViewModeChange={(mode) => {
                if (mode === 'analyze') {
                    requestAnalyzeMode();
                } else {
                    setViewMode('solve');
                    setPvStep(0);
                }
            }}
            filtersOpen={filtersOpen}
            onToggleFilters={() => setFiltersOpen((value) => !value)}
            filtersSummary={filtersSummary}
            uiFilters={uiFilters}
            currentPuzzle={currentPuzzle}
            sideToMoveLabel={sideToMoveLabel}
            contextHintsEnabled={contextHintsEnabled}
            reviewUnlocked={reviewUnlocked}
            preferencesLoading={preferencesLoading}
            localOutcome={localOutcome}
            analysisTrackLabel={analysisTrackLabel}
            engineStatus={engineStatus}
            evalUnit={evalUnit}
            evalText={evalText}
        />
    );

    const analysisTools =
        viewMode === 'analyze' ? (
            <PuzzleTrainerAnalysisTools
                error={liveAnalyze.error}
                analysisEnabled={analysisEnabled}
                engineReady={engineClient !== null}
                currentAnalysis={currentAnalysis}
                analysisMultiPv={analysisMultiPv}
                selectedLine={selectedLine}
                depth={liveAnalyze.depth ?? null}
                fallbackFen={analysisRootFen ?? displayFen}
                onSelectLine={(index, key) => {
                    setAnalysisSelectedIdx(index);
                    setAnalysisSelectedKey(key);
                    setAnalyzeTrack('pv');
                    setPvStep(0);
                }}
                onMultiPvChange={setAnalysisMultiPv}
                onToggleEngine={() => {
                    if (!analysisRootFen) return;
                    setAnalysisEnabled((value) => {
                        const next = !value;
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
                canToggleEngine={analysisRootFen !== null}
            />
        ) : null;

    const details = currentPuzzle ? (
        <PuzzleTrainerDetails
            currentPuzzle={currentPuzzle}
            puzzlePly={puzzlePly}
            idx={idx}
            loadingNext={loadingNext}
            onPreviousPuzzle={() => setIdx((value) => Math.max(0, value - 1))}
            onNextPuzzle={() => void nextPuzzle()}
            sourceGame={sourceGame}
            contextHintsEnabled={contextHintsEnabled}
            reviewUnlocked={reviewUnlocked}
            openingText={openingText}
            sourceLoading={sourceLoading}
            sourceError={sourceError}
            onRetrySource={() => setSourceRetryNonce((value) => value + 1)}
            tagsRevealed={tagsRevealed}
            onToggleTags={() =>
                setTagsRevealedForId(tagsRevealed ? null : currentPuzzleId)
            }
            showPuzzleStats={showPuzzleStats}
            onToggleStats={() =>
                setStatsVisibleForId(showPuzzleStats ? null : currentPuzzleId)
            }
            attemptSyncState={attemptSyncState}
            queuedAttempts={queuedAttempts}
            attemptOnline={attemptOnline}
            attemptSyncError={attemptSyncError}
            attemptResult={attemptResult}
            onRetrySync={() => void flushQueue()}
            puzzleStatsLoading={puzzleStatsLoading}
            puzzleStatsError={puzzleStatsError}
            puzzleStats={puzzleStats}
            isMultiSolutionPuzzle={isMultiSolutionPuzzle}
            bestMoveSan={bestMoveSan}
            acceptedMovesText={acceptedMovesText}
            puzzleAttempts={puzzleAttempts}
        />
    ) : null;

    if (!currentPuzzle) {
        return (
            <div
                ref={trainerRootRef}
                tabIndex={-1}
                className="space-y-4"
            >
                {header}
                {loadingNext ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading a puzzle…
                    </div>
                ) : randomError || directLoadError ? (
                    <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                        <p className="text-sm font-medium text-red-700 dark:text-red-300" role="alert">
                            {directLoadError ?? randomError}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                            <Button type="button" size="sm" onClick={() => void ensureOne({ force: true })}>
                                Retry
                            </Button>
                            <Button asChild type="button" variant="outline" size="sm">
                                <Link href="/puzzles">Clear filters</Link>
                            </Button>
                        </div>
                    </div>
                ) : sessionComplete ? (
                    <div className="rounded-lg border bg-card p-5">
                        <h2 className="font-medium">Session complete</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            No more puzzles match these filters.
                        </p>
                        <div className="mt-3 flex flex-wrap gap-3 text-sm">
                            <span>{sessionCounts.solved} solved</span>
                            <span>{sessionCounts.missed} missed</span>
                            <span>{sessionCounts.revealed} revealed</span>
                            <span>{sessionCounts.skipped} skipped</span>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-2">
                            <Button type="button" size="sm" onClick={() => void ensureOne({ force: true })}>
                                Try again
                            </Button>
                            <Button asChild type="button" variant="outline" size="sm">
                                <Link href="/puzzles">Clear filters</Link>
                            </Button>
                        </div>
                    </div>
                ) : (
                    <div className="text-sm text-muted-foreground">Preparing session…</div>
                )}
            </div>
        );
    }

    return (
        <div
            ref={trainerRootRef}
            tabIndex={0}
            className="space-y-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Puzzle trainer. Keyboard shortcuts are active while this trainer is focused."
        >
            {header}
            {sessionComplete ? (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4">
                    <div>
                        <div className="font-medium">Session complete</div>
                        <div className="text-sm text-muted-foreground">
                            {sessionCounts.solved} solved · {sessionCounts.missed} missed ·{' '}
                            {sessionCounts.revealed} revealed
                            {' · '}
                            {sessionCounts.skipped} skipped
                        </div>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            size="sm"
                            onClick={() => {
                                setQueue([]);
                                setIdx(0);
                                void ensureOne({ force: true });
                            }}
                        >
                            Start another session
                        </Button>
                        <Button asChild type="button" variant="outline" size="sm">
                            <Link href="/puzzles">Clear filters</Link>
                        </Button>
                    </div>
                </div>
            ) : null}

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
                                showAnimations: !reducedMotion,
                                animationDurationInMs: reducedMotion ? 0 : 180,
                                allowDrawingArrows: false,
                                arrows,
                                squareStyles,
                                canDragPiece: ({ square }) => {
                                    if (!allowMove || !square) return false;
                                    const chess = new Chess(displayFen);
                                    const piece = chess.get(square as Square);
                                    return Boolean(piece && piece.color === chess.turn());
                                },
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
                                        playOrChoosePromotion(from, to);
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
                                    ? ({ sourceSquare, targetSquare }) => {
                                          clearHints();
                                          if (!targetSquare) return false;
                                          const from = sourceSquare as Square;
                                          const to = targetSquare as Square;
                                          return playOrChoosePromotion(from, to);
                                      }
                                    : undefined,
                            }}
                        />

                        <PuzzleTrainerWrongMoveOverlay
                            visible={
                                viewMode === 'solve' &&
                                attemptResult === 'incorrect' &&
                                showWrongOverlay
                            }
                            refutationLoading={refutationLoading}
                            onHint={() => setHintForId(currentPuzzleId)}
                            onLoadRefutation={() => void loadRefutation()}
                            onAnalyze={() => {
                                setShowWrongOverlay(false);
                                setPvStep(0);
                                setAnalysisRootFen(attemptFen);
                                setAnalysisHistory([attemptFen]);
                                setAnalysisHistoryIdx(0);
                                setAnalyzeTrack('pv');
                                setAnalyzeGamePly(puzzlePly);
                                setViewMode('analyze');
                            }}
                            onTryAgain={() => {
                                setShowWrongOverlay(false);
                                resetSolve();
                            }}
                        />
                    </div>

                    <PuzzleTrainerDialogs
                        promotionChoices={pendingPromotion?.choices ?? null}
                        disclosurePrompt={disclosurePrompt}
                        onClosePromotion={() => setPendingPromotion(null)}
                        onChoosePromotion={choosePromotion}
                        onCloseDisclosure={() => setDisclosureState(null)}
                        onConfirmDisclosure={
                            disclosurePrompt === 'analyze'
                                ? enterAnalyzeMode
                                : revealSolution
                        }
                    />

                    <PuzzleTrainerBoardFeedback
                        localOutcome={localOutcome}
                        attemptFeedback={attemptFeedback}
                        hintLevel={hintLevel}
                        viewMode={viewMode}
                        attemptResult={attemptResult}
                        showSolution={showSolution}
                        showRealMove={showRealMove}
                        refutationLength={
                            refutationLineUci ? refutationApplied.length : 0
                        }
                        refutationStep={refutationStep}
                        refutationError={refutationError}
                        onRefutationStepChange={setRefutationStep}
                    />

                    <PuzzleTrainerBoardControls
                        viewMode={viewMode}
                        canStepPrev={canStepPrev}
                        canStepNext={canStepNext}
                        onStepPrev={() => {
                            if (viewMode === 'analyze') return analyzePrev();
                            if (showContext && sourceParsed) {
                                setContextPly((value) => Math.max(0, value - 1));
                                return;
                            }
                            if (
                                !attemptResult &&
                                !isReviewState &&
                                sourceParsed &&
                                puzzlePly > 0
                            ) {
                                setShowContext(true);
                                setContextPly(Math.max(0, puzzlePly - 1));
                                return;
                            }
                            setPvStep((value) => Math.max(0, value - 1));
                        }}
                        onStepNext={() => {
                            if (viewMode === 'analyze') return analyzeNext();
                            if (showContext && sourceParsed) {
                                setContextPly((value) => {
                                    const next = Math.min(puzzlePly, value + 1);
                                    if (next >= puzzlePly) setShowContext(false);
                                    return next;
                                });
                                return;
                            }
                            const max = Math.max(0, solveLineApplied.length - 1);
                            setPvStep((value) => Math.min(max, value + 1));
                        }}
                        hasRealSourceMove={realSourceMove !== null}
                        reviewUnlocked={reviewUnlocked}
                        contextHintsEnabled={contextHintsEnabled}
                        showRealMove={showRealMove}
                        onToggleSourceMove={toggleSourceMove}
                        onRevealSolution={() => {
                            if (reviewUnlocked) revealSolution();
                            else if (currentPuzzleId) {
                                setDisclosureState({
                                    puzzleId: currentPuzzleId,
                                    type: 'solution',
                                });
                            }
                        }}
                        canReset={canReset}
                        onReset={() => {
                            setSolutionVisibleForId(null);
                            setSourceMoveVisibleForId(null);
                            if (viewMode === 'solve') return resetSolve();
                            resetAnalyzeToStart();
                        }}
                        analysisHistoryIdx={analysisHistoryIdx}
                        analysisHistoryLength={analysisHistory.length}
                        onUndo={() =>
                            setAnalysisHistoryIdx((value) =>
                                Math.max(0, value - 1)
                            )
                        }
                        onRedo={() =>
                            setAnalysisHistoryIdx((value) =>
                                Math.min(analysisHistory.length - 1, value + 1)
                            )
                        }
                        boardFlipped={boardFlipped}
                        onFlipBoard={() => setBoardFlipped((value) => !value)}
                        idx={idx}
                        loadingNext={loadingNext}
                        onPreviousPuzzle={() =>
                            setIdx((value) => Math.max(0, value - 1))
                        }
                        onNextPuzzle={() => void nextPuzzle()}
                    />

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
