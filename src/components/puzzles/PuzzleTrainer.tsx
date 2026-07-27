'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Chess, type Move, type Square } from 'chess.js';
import {
    ChevronLeft,
    ChevronRight,
    Eye,
    EyeOff,
    Filter,
    FlipHorizontal2,
    Lightbulb,
    Loader2,
    Play,
    Redo2,
    RotateCcw,
    Undo2,
    WifiOff,
} from 'lucide-react';
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
    extractStartFenFromPgn,
    moveToUci,
    parseUci,
    sideToMoveFromFen,
    uciLineToSan,
    uciToSan,
} from '@/lib/chess/utils';
import { ecoName } from '@/lib/chess/eco';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import PuzzlesFilter, { type PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import type { PreferencesSchema } from '@/lib/preferences';
import {
    classifyPuzzleMove,
    isStateForPuzzle,
    legalPromotionChoices,
    appendAnalysisBranch,
    analysisHistoryStepLabel,
} from '@/lib/puzzles/trainerUx';
import { ModalDialog } from '@/components/ui/ModalDialog';
import {
    puzzleOutcomeFromMove,
    type PuzzleNonMoveOutcome,
} from '@/lib/puzzles/attemptOutcomes';

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

type PuzzleAttemptRow = {
    id: string;
    attemptedAt: string;
    userMoveUci: string;
    wasCorrect: boolean;
    timeSpentMs: number | null;
    outcome: PuzzleNonMoveOutcome | null;
};

function toRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parsePuzzleAttemptStats(value: unknown): PuzzleAttemptStats | null {
    const stats = toRecord(value);
    const {
        attempted,
        correct,
        successRate,
        solved,
        failed,
        lastAttemptedAt,
        averageTimeMs,
        outcome,
    } = stats;

    if (
        typeof attempted !== 'number' ||
        typeof correct !== 'number' ||
        !(typeof successRate === 'number' || successRate === null) ||
        typeof solved !== 'boolean' ||
        typeof failed !== 'boolean' ||
        !(typeof lastAttemptedAt === 'string' || lastAttemptedAt === null) ||
        !(typeof averageTimeMs === 'number' || averageTimeMs === null)
        || !(
            outcome === 'new' ||
            outcome === 'solved' ||
            outcome === 'failed' ||
            outcome === 'revealed' ||
            outcome === 'skipped'
        )
    ) {
        return null;
    }

    return {
        attempted,
        correct,
        successRate,
        solved,
        failed,
        lastAttemptedAt,
        averageTimeMs,
        outcome,
    };
}

function parsePuzzleAttemptRow(value: unknown): PuzzleAttemptRow | null {
    const row = toRecord(value);
    const { id, attemptedAt, userMoveUci, wasCorrect, timeSpentMs } = row;
    const outcome =
        row.outcome === 'revealed' || row.outcome === 'skipped'
            ? row.outcome
            : puzzleOutcomeFromMove(
                  typeof userMoveUci === 'string' ? userMoveUci : ''
              );

    if (
        typeof id !== 'string' ||
        typeof attemptedAt !== 'string' ||
        typeof userMoveUci !== 'string' ||
        typeof wasCorrect !== 'boolean' ||
        !(typeof timeSpentMs === 'number' || timeSpentMs == null)
    ) {
        return null;
    }

    return {
        id,
        attemptedAt,
        userMoveUci,
        wasCorrect,
        timeSpentMs: timeSpentMs ?? null,
        outcome,
    };
}

function parsePuzzleAttempts(value: unknown): PuzzleAttemptRow[] {
    if (!Array.isArray(value)) return [];
    return value
        .map((attempt) => parsePuzzleAttemptRow(attempt))
        .filter((attempt): attempt is PuzzleAttemptRow => attempt !== null);
}

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
    return Boolean(
        el.closest(
            'input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="option"], [role="dialog"]'
        )
    );
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

    const header = (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Tabs
                    value={viewMode}
                    className="flex-1"
                    onValueChange={(v) => {
                        if (v !== 'solve' && v !== 'analyze') return;
                        if (v === 'analyze') {
                            requestAnalyzeMode();
                        } else {
                            setViewMode('solve');
                            setPvStep(0);
                        }
                    }}
                >
                    <TabsList className="w-full">
                        <TabsTrigger className="flex-1" value="solve">
                            Solve
                        </TabsTrigger>
                        <TabsTrigger className="flex-1" value="analyze">
                            Analyze
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
                    <PuzzlesFilter
                        initial={uiFilters}
                        preserveKeys={['view']}
                        autoApply={false}
                    />
                </div>
            ) : null}

            {currentPuzzle ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2">
                    <p className="text-sm font-medium">
                        {sideToMoveLabel} to move — find the best move
                    </p>
                    {contextHintsEnabled || reviewUnlocked ? (
                        <div className="flex flex-wrap gap-1.5">
                            <Badge variant="secondary">
                                {currentPuzzle.mode === 'punishBlunder'
                                    ? 'Punish a mistake'
                                    : 'Avoid a mistake'}
                            </Badge>
                            {currentPuzzle.type ? (
                                <Badge variant="outline">{currentPuzzle.type}</Badge>
                            ) : null}
                        </div>
                    ) : preferencesLoading ? (
                        <span className="text-xs text-muted-foreground">
                            Loading preferences…
                        </span>
                    ) : (
                        <span className="text-xs text-muted-foreground">
                            Spoiler-free
                        </span>
                    )}
                    {localOutcome === 'revealed' || localOutcome === 'skipped' ? (
                        <Badge
                            variant="outline"
                            className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                        >
                            {localOutcome === 'revealed' ? 'Revealed' : 'Skipped'}
                        </Badge>
                    ) : null}
                </div>
            ) : null}

            {viewMode === 'analyze' ? (
                <div className="space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>
                            Track:{' '}
                            <strong className="font-medium text-foreground">
                                {showRealMove && analyzeTrack === 'pv'
                                    ? 'Source move position'
                                    : analyzeTrack === 'game'
                                    ? `Source game · ply ${analyzeGamePly}`
                                    : analysisHistory.length > 1
                                      ? analysisHistoryStepLabel({
                                            historyLength:
                                                analysisHistory.length,
                                            historyIndex: analysisHistoryIdx,
                                        })
                                      : `Engine line · step ${pvStep}`}
                            </strong>
                        </span>
                        <span role="status">
                            {!analysisEnabled
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
                                      : 'Engine loading…'}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-full flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                                className="h-2 bg-foreground/70"
                                style={{ width: `${Math.round(evalUnit * 100)}%` }}
                            />
                        </div>
                        <div className="min-w-[3.5rem] text-right font-mono text-sm text-muted-foreground">
                            {evalText}
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );

    const analysisTools =
        viewMode === 'analyze' ? (
            <div className="mt-3 space-y-2">
                <div
                    className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                    aria-label="Board arrow legend"
                >
                    <span className="font-medium text-foreground">Arrows</span>
                    <span><span aria-hidden="true" className="mr-1 text-blue-500">●</span>Line 1</span>
                    <span><span aria-hidden="true" className="mr-1 text-emerald-500">●</span>Line 2</span>
                    <span><span aria-hidden="true" className="mr-1 text-amber-500">●</span>Line 3</span>
                    <span>Shown only at the analyzed root position.</span>
                </div>
                {liveAnalyze.error ? (
                    <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300" role="alert">
                        {liveAnalyze.error}
                    </div>
                ) : analysisEnabled &&
                  engineClient &&
                  (currentAnalysis?.lines?.length ?? 0) === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Engine is calculating candidate lines…
                    </div>
                ) : null}
                <div className="space-y-2">
                    {(currentAnalysis?.lines ?? []).slice(0, Math.max(1, Math.min(5, analysisMultiPv))).map((l, i) => (
                        <button
                            key={i}
                            type="button"
                            onClick={() => {
                                setAnalysisSelectedIdx(i);
                                setAnalysisSelectedKey((l.pvUci ?? []).join(' '));
                                setAnalyzeTrack('pv');
                                setPvStep(0);
                            }}
                            className={
                                'w-full rounded-md border bg-card px-3 py-3 text-left text-sm transition-colors ' +
                                (i === selectedLine ? 'bg-muted' : 'hover:bg-muted/50')
                            }
                        >
                            <div className="flex items-center justify-between gap-2">
                                <div className="font-medium">#{i + 1}</div>
                                <div className="font-mono text-xs text-muted-foreground">
                                    {formatEval(l.score, currentAnalysis?.fen ?? analysisRootFen ?? displayFen)}
                                    {typeof liveAnalyze.depth === 'number'
                                        ? ` d${liveAnalyze.depth}`
                                        : ''}
                                </div>
                            </div>
                            <div className="mt-1 font-mono text-xs text-muted-foreground">
                                {uciLineToSan(currentAnalysis?.fen ?? analysisRootFen ?? displayFen, l.pvUci ?? [], 6).join(' ')}
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
                        {analysisEnabled ? 'Pause engine' : 'Resume engine'}
                    </Button>
                </div>
            </div>
        ) : null;

    const details = currentPuzzle ? (
        <div className="mt-3 space-y-2">
            <div
                className="hidden grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg border bg-card p-2 lg:grid"
                aria-label="Puzzle navigation"
            >
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="justify-self-start"
                    onClick={() => setIdx((value) => Math.max(0, value - 1))}
                    disabled={idx <= 0}
                >
                    Previous puzzle
                </Button>
                <span className="text-xs text-muted-foreground">
                    Puzzle {idx + 1}
                </span>
                <Button
                    type="button"
                    size="sm"
                    className="justify-self-end"
                    onClick={() => void nextPuzzle()}
                    disabled={loadingNext}
                >
                    {loadingNext ? 'Loading…' : 'Next puzzle'}
                </Button>
            </div>
            <Link
                href={`/games/${encodeURIComponent(currentPuzzle.sourceGameId)}?ply=${encodeURIComponent(String(puzzlePly))}`}
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
                            {(contextHintsEnabled || reviewUnlocked) && openingText
                                ? openingText
                                : null}
                            {(contextHintsEnabled || reviewUnlocked) &&
                            openingText &&
                            sourceGame?.playedAt
                                ? ' · '
                                : null}
                            {sourceGame?.playedAt
                                ? new Date(sourceGame.playedAt).toLocaleDateString()
                                : sourceLoading
                                  ? 'Loading source…'
                                  : null}
                        </div>
                    </div>
                </div>
            </Link>
            {sourceError ? (
                <div className="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    <span>Source details unavailable. The puzzle board still works.</span>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSourceRetryNonce((value) => value + 1)}
                    >
                        Retry
                    </Button>
                </div>
            ) : null}

            <div className="flex items-center gap-3">
                <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2"
                    onClick={() =>
                        setTagsRevealedForId(
                            tagsRevealed ? null : currentPuzzleId
                        )
                    }
                    aria-pressed={tagsRevealed}
                    title={
                        !contextHintsEnabled && !reviewUnlocked
                            ? 'Available after your attempt'
                            : tagsRevealed
                              ? 'Hide tags'
                              : 'Show tags'
                    }
                    disabled={!contextHintsEnabled && !reviewUnlocked}
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
                    variant="ghost"
                    className="h-9 px-2"
                    onClick={() =>
                        setStatsVisibleForId(
                            showPuzzleStats ? null : currentPuzzleId
                        )
                    }
                    aria-pressed={showPuzzleStats}
                    title={
                        !reviewUnlocked
                            ? 'Available after your attempt'
                            : showPuzzleStats
                              ? 'Hide puzzle stats'
                              : 'Show puzzle stats'
                    }
                    disabled={!reviewUnlocked}
                >
                    {showPuzzleStats ? (
                        <EyeOff className="h-4 w-4" />
                    ) : (
                        <Eye className="h-4 w-4" />
                    )}
                    <span className="text-sm">stats</span>
                </Button>

            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
                {attemptSyncState === 'saving' ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving attempt…</>
                ) : queuedAttempts > 0 ? (
                    <>
                        {!attemptOnline ? <WifiOff className="h-3.5 w-3.5" /> : null}
                        {queuedAttempts} attempt{queuedAttempts === 1 ? '' : 's'} queued
                        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => void flushQueue()}>
                            Retry sync
                        </Button>
                    </>
                ) : attemptSyncError ? (
                    <span className="text-amber-700 dark:text-amber-300">{attemptSyncError}</span>
                ) : attemptResult && attemptSyncState === 'saved' ? (
                    <span>Attempt saved</span>
                ) : null}
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

            {showPuzzleStats ? (
                <div className="space-y-3">
                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">Your stats</CardTitle>
                        </CardHeader>
                        <CardContent className="text-sm text-muted-foreground">
                            {puzzleStatsLoading ? (
                                <div>Loading…</div>
                            ) : puzzleStatsError ? (
                                <div className="text-red-600">{puzzleStatsError}</div>
                            ) : puzzleStats ? (
                                <div className="space-y-1">
                                    <div>Attempts: {puzzleStats.attempted}</div>
                                    <div>Correct: {puzzleStats.correct}</div>
                                    <div>
                                        Success rate:{' '}
                                        {puzzleStats.successRate == null
                                            ? '—'
                                            : `${Math.round(puzzleStats.successRate * 100)}%`}
                                    </div>
                                    <div>
                                        Last attempted:{' '}
                                        {puzzleStats.lastAttemptedAt
                                            ? new Date(puzzleStats.lastAttemptedAt).toLocaleString()
                                            : '—'}
                                    </div>
                                    <div>
                                        Avg time:{' '}
                                        {puzzleStats.averageTimeMs == null
                                            ? '—'
                                            : `${Math.round(puzzleStats.averageTimeMs / 1000)}s`}
                                    </div>
                                    <div>
                                        Outcome:{' '}
                                        {puzzleStats.outcome === 'revealed'
                                            ? 'Revealed'
                                            : puzzleStats.outcome === 'skipped'
                                              ? 'Skipped'
                                              : puzzleStats.outcome === 'solved'
                                                ? 'Solved'
                                                : puzzleStats.outcome === 'failed'
                                                  ? 'Failed'
                                                  : 'New'}
                                    </div>
                                </div>
                            ) : (
                                <div>—</div>
                            )}
                        </CardContent>
                    </Card>

                    {isMultiSolutionPuzzle && reviewUnlocked ? (
                        <Card>
                            <CardHeader>
                                <CardTitle className="text-base">Solutions</CardTitle>
                            </CardHeader>
                            <CardContent className="text-sm text-muted-foreground space-y-2">
                                <Badge variant="secondary">Multiple correct moves</Badge>
                                <div>
                                    Best move:{' '}
                                    <span className="font-mono text-xs">
                                        {bestMoveSan}
                                    </span>
                                </div>
                                <div>
                                    Accepted moves:{' '}
                                    <span className="font-mono text-xs">{acceptedMovesText}</span>
                                </div>
                            </CardContent>
                        </Card>
                    ) : null}

                    <Card>
                        <CardHeader>
                            <CardTitle className="text-base">History</CardTitle>
                        </CardHeader>
                        <CardContent>
                            {puzzleStatsLoading ? (
                                <div className="text-sm text-muted-foreground">Loading…</div>
                            ) : puzzleAttempts.length === 0 ? (
                                <div className="text-sm text-muted-foreground">
                                    No attempts yet.
                                </div>
                            ) : (
                                <div className="rounded-md border">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Result</TableHead>
                                                <TableHead>Move</TableHead>
                                                <TableHead className="text-right">Time</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {puzzleAttempts.slice(0, 20).map((a) => (
                                                <TableRow key={a.id}>
                                                    <TableCell>
                                                        <Badge
                                                            className={
                                                                a.outcome === 'revealed'
                                                                    ? 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                                                    : a.outcome === 'skipped'
                                                                      ? 'border-transparent bg-slate-500/15 text-slate-700 dark:text-slate-300'
                                                                      : a.wasCorrect
                                                                    ? 'border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                                                    : 'border-transparent bg-red-500/15 text-red-700 dark:text-red-300'
                                                            }
                                                        >
                                                            {a.outcome === 'revealed'
                                                                ? 'Revealed'
                                                                : a.outcome === 'skipped'
                                                                  ? 'Skipped'
                                                                  : a.wasCorrect
                                                                    ? 'Correct'
                                                                    : 'Miss'}
                                                        </Badge>
                                                    </TableCell>
                                                    <TableCell className="font-mono text-xs">
                                                        {a.outcome
                                                            ? '—'
                                                            : currentPuzzle
                                                            ? uciToSan(currentPuzzle.fen, a.userMoveUci) ?? a.userMoveUci
                                                            : a.userMoveUci}
                                                    </TableCell>
                                                    <TableCell className="text-right text-sm text-muted-foreground">
                                                        {a.timeSpentMs != null
                                                            ? `${Math.round(a.timeSpentMs / 1000)}s`
                                                            : '—'}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>
            ) : null}
        </div>
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

                        {viewMode === 'solve' && attemptResult === 'incorrect' && showWrongOverlay ? (
                            <div className="absolute inset-x-3 bottom-3 z-[100] rounded-lg border bg-card/95 p-4 shadow-lg backdrop-blur-sm">
                                    <div className="text-sm font-medium">Not the best move</div>
                                    <div className="mt-1 text-sm text-muted-foreground">
                                        Choose how you want to learn from it. Nothing will autoplay.
                                    </div>
                                    <div className="mt-4 flex flex-wrap gap-2">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() => setHintForId(currentPuzzleId)}
                                        >
                                            <Lightbulb className="mr-2 h-4 w-4" />
                                            Hint
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={() => void loadRefutation()}
                                            disabled={refutationLoading}
                                        >
                                            {refutationLoading ? (
                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            ) : (
                                                <Play className="mr-2 h-4 w-4" />
                                            )}
                                            Play refutation
                                        </Button>
                                        <Button
                                            type="button"
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
                                            type="button"
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
                        ) : null}
                    </div>

                    <ModalDialog
                        open={pendingPromotion !== null}
                        onOpenChange={(open) => {
                            if (!open) setPendingPromotion(null);
                        }}
                        title="Promote pawn to"
                        description="Choose the piece for this legal promotion."
                    >
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                            {(
                                [
                                    ['q', 'Queen'],
                                    ['r', 'Rook'],
                                    ['b', 'Bishop'],
                                    ['n', 'Knight'],
                                ] as const
                            )
                                .filter(([piece]) =>
                                    pendingPromotion?.choices.includes(piece)
                                )
                                .map(([piece, label]) => (
                                    <Button
                                        key={piece}
                                        type="button"
                                        variant="outline"
                                        onClick={() => choosePromotion(piece)}
                                        aria-label={`Promote to ${label}`}
                                    >
                                        {label}
                                    </Button>
                                ))}
                        </div>
                    </ModalDialog>

                    <ModalDialog
                        open={disclosurePrompt !== null}
                        onOpenChange={(open) => {
                            if (!open) setDisclosureState(null);
                        }}
                        title="Reveal this puzzle?"
                        description={
                            disclosurePrompt === 'analyze'
                                ? 'Opening analysis can expose the answer. Counted as revealed in this session.'
                                : 'Showing the solution is counted as revealed in this session.'
                        }
                    >
                        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setDisclosureState(null)}
                            >
                                Keep solving
                            </Button>
                            <Button
                                type="button"
                                onClick={
                                    disclosurePrompt === 'analyze'
                                        ? enterAnalyzeMode
                                        : revealSolution
                                }
                            >
                                {disclosurePrompt === 'analyze'
                                    ? 'Reveal and analyze'
                                    : 'Reveal solution'}
                            </Button>
                        </div>
                    </ModalDialog>

                    <div
                        className="mt-3 min-h-10 rounded-lg border bg-card px-3 py-2 text-sm"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                    >
                        {(localOutcome === 'revealed' ||
                            localOutcome === 'skipped') &&
                        (attemptFeedback === 'best' ||
                            attemptFeedback === 'accepted') ? (
                            <span className="font-medium text-amber-700 dark:text-amber-300">
                                Good practice move. This puzzle remains{' '}
                                {localOutcome === 'revealed'
                                    ? 'Revealed'
                                    : 'Skipped'}.
                            </span>
                        ) : attemptFeedback === 'best' ? (
                            <span className="font-medium text-emerald-700 dark:text-emerald-300">
                                Best move — well found.
                            </span>
                        ) : attemptFeedback === 'accepted' ? (
                            <span className="font-medium text-emerald-700 dark:text-emerald-300">
                                Correct alternative. It works, though another accepted line is ranked best.
                            </span>
                        ) : attemptFeedback === 'wrong' ? (
                            <span className="font-medium text-red-700 dark:text-red-300">
                                Not the best move. Try again, ask for a hint, inspect the refutation, or analyze.
                            </span>
                        ) : hintLevel > 0 ? (
                            <span className="text-amber-700 dark:text-amber-300">
                                Hint: focus on the highlighted piece.
                            </span>
                        ) : (
                            <span className="text-muted-foreground">
                                Make a move when you are ready.
                            </span>
                        )}
                    </div>
                    {viewMode === 'solve' &&
                    (attemptResult || showSolution || showRealMove) ? (
                        <div
                            className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground"
                            aria-label="Board arrow legend"
                        >
                            <span>
                                <span aria-hidden="true" className="mr-1 text-emerald-500">●</span>
                                Accepted move
                            </span>
                            {attemptResult === 'incorrect' ? (
                                <span>
                                    <span aria-hidden="true" className="mr-1 text-red-500">●</span>
                                    Your move
                                </span>
                            ) : null}
                            {showRealMove ? (
                                <span>
                                    <span aria-hidden="true" className="mr-1 text-amber-500">●</span>
                                    Source-game move
                                </span>
                            ) : null}
                        </div>
                    ) : null}

                    {refutationLineUci && refutationApplied.length > 1 ? (
                        <div className="mt-3 rounded-lg border bg-card p-3">
                            <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="font-medium">Refutation line</span>
                                <span className="text-muted-foreground">
                                    Step {refutationStep} / {refutationApplied.length - 1}
                                </span>
                            </div>
                            <input
                                type="range"
                                min={0}
                                max={Math.max(0, refutationApplied.length - 1)}
                                value={refutationStep}
                                onChange={(event) =>
                                    setRefutationStep(Number(event.target.value))
                                }
                                className="mt-2 w-full accent-primary"
                                aria-label="Refutation line step"
                            />
                            <div className="mt-2 flex justify-between gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        setRefutationStep((step) => Math.max(0, step - 1))
                                    }
                                    disabled={refutationStep <= 0}
                                >
                                    Previous move
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                        setRefutationStep((step) =>
                                            Math.min(
                                                refutationApplied.length - 1,
                                                step + 1
                                            )
                                        )
                                    }
                                    disabled={refutationStep >= refutationApplied.length - 1}
                                >
                                    Next move
                                </Button>
                            </div>
                        </div>
                    ) : refutationError ? (
                        <div className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">
                            {refutationError}
                        </div>
                    ) : null}

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
                            aria-label="Previous line move"
                            title="Previous line move"
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </Button>

                        <div className="flex min-w-0 items-center justify-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                className="hidden h-10 px-2 text-xs sm:inline-flex sm:px-3 sm:text-sm"
                                onClick={toggleSourceMove}
                                disabled={
                                    !realSourceMove ||
                                    (!reviewUnlocked && !contextHintsEnabled)
                                }
                            >
                                {showRealMove ? 'Hide source move' : 'Show source move'}
                            </Button>
                            {viewMode === 'solve' ? (
                                <Button
                                    type="button"
                                    variant="outline"
                                    className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                                    onClick={() => {
                                        if (reviewUnlocked) revealSolution();
                                        else if (currentPuzzleId) {
                                            setDisclosureState({
                                                puzzleId: currentPuzzleId,
                                                type: 'solution',
                                            });
                                        }
                                    }}
                                    disabled={!currentPuzzle}
                                >
                                    Solution
                                </Button>
                            ) : null}
                            <Button
                                type="button"
                                variant="outline"
                                className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                                onClick={() => {
                                    setSolutionVisibleForId(null);
                                    setSourceMoveVisibleForId(null);
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
                            aria-label="Next line move"
                            title="Next line move"
                        >
                            <ChevronRight className="h-5 w-5" />
                        </Button>
                    </div>

                    {viewMode === 'analyze' ? (
                        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                    setAnalysisHistoryIdx((value) =>
                                        Math.max(0, value - 1)
                                    )
                                }
                                disabled={analysisHistoryIdx <= 0}
                            >
                                <Undo2 className="mr-2 h-4 w-4" />
                                Undo
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                    setAnalysisHistoryIdx((value) =>
                                        Math.min(
                                            analysisHistory.length - 1,
                                            value + 1
                                        )
                                    )
                                }
                                disabled={
                                    analysisHistoryIdx >= analysisHistory.length - 1
                                }
                            >
                                <Redo2 className="mr-2 h-4 w-4" />
                                Redo
                            </Button>
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setBoardFlipped((value) => !value)}
                                aria-pressed={boardFlipped}
                            >
                                <FlipHorizontal2 className="mr-2 h-4 w-4" />
                                Flip board
                            </Button>
                        </div>
                    ) : null}

                    <div className="sticky bottom-3 z-30 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur lg:hidden">
                        <Button
                            type="button"
                            variant="outline"
                            className="h-11"
                            onClick={() => setIdx((value) => Math.max(0, value - 1))}
                            disabled={idx <= 0}
                        >
                            Previous
                        </Button>
                        <Button
                            type="button"
                            className="h-11 w-full"
                            onClick={() => void nextPuzzle()}
                            disabled={loadingNext}
                        >
                            {loadingNext ? 'Loading next puzzle…' : 'Next puzzle'}
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
