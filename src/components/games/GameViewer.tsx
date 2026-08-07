'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Chess, type Move as VerboseMove, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import {
    ChevronLeft,
    ChevronRight,
    ChevronsLeft,
    ChevronsRight,
    Pause,
    Play,
    Target,
} from 'lucide-react';
import { extractStartFenFromPgn, parseUci, uciLineToSan } from '@/lib/chess/utils';
import {
    getClassificationLabel,
    getClassificationSymbol,
    type MoveClassification,
    type GameAnalysis,
} from '@/lib/analysis/classification';
import type { ExtractionDecisionReason } from '@/lib/analysis/extractionReceipt';
import {
    StockfishClient,
} from '@/lib/analysis/stockfishClient';
import {
    formatEngineScoreForWhite,
    whiteExpectedScore,
} from '@/lib/analysis/evaluation';
import { useStockfishLiveMultiPvAnalysis } from '@/lib/hooks/useStockfishLiveMultiPvAnalysis';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/async-state';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

type TrainingMomentPreview = {
    decisionPly: number;
};

const START_FEN = new Chess().fen();

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

function hasInitialPly(initialPly: number | undefined): initialPly is number {
    return typeof initialPly === 'number' && Number.isFinite(initialPly);
}

function initialPlyValue(initialPly: number | undefined, maxPly?: number) {
    if (!hasInitialPly(initialPly)) return 0;
    const next = Math.max(0, Math.trunc(initialPly));
    return typeof maxPly === 'number' ? clamp(next, 0, maxPly) : next;
}

type PvSelection = {
    fen: string;
    idx: number;
    key: string | null;
};

function defaultPvSelection(fen: string): PvSelection {
    return { fen, idx: 0, key: null };
}

function createStockfishClientStore() {
    let client: StockfishClient | null = null;
    const listeners = new Set<() => void>();

    const notify = () => {
        for (const listener of listeners) listener();
    };

    return {
        getSnapshot: () => client,
        getServerSnapshot: () => null,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        ensureClient: () => {
            if (client) return client;
            client = new StockfishClient();
            notify();
            return client;
        },
        terminate: () => {
            if (!client) return;
            client.terminate();
            client = null;
            notify();
        },
    };
}

function isEditableTarget(el: EventTarget | null) {
    if (!(el instanceof HTMLElement)) return false;
    const tag = el.tagName.toLowerCase();
    return tag === 'input' || tag === 'textarea' || el.isContentEditable;
}

function classificationAccent(c: MoveClassification): {
    border: string;
    badge: string;
} {
    switch (c) {
        case 'brilliant':
            return {
                border: 'border-l-fuchsia-500/70',
                badge: 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300',
            };
        case 'great':
            return {
                border: 'border-l-emerald-500/70',
                badge: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
            };
        case 'best':
            return {
                border: 'border-l-blue-500/70',
                badge: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
            };
        case 'excellent':
            return {
                border: 'border-l-green-500/70',
                badge: 'bg-green-500/12 text-green-700 dark:text-green-300',
            };
        case 'good':
            return {
                border: 'border-l-green-500/50',
                badge: 'bg-green-500/10 text-green-700 dark:text-green-300',
            };
        case 'book':
            return {
                border: 'border-l-slate-500/40',
                badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300',
            };
        case 'inaccuracy':
            return {
                border: 'border-l-amber-500/70',
                badge: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
            };
        case 'mistake':
            return {
                border: 'border-l-orange-500/70',
                badge: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
            };
        case 'blunder':
            return {
                border: 'border-l-red-500/75',
                badge: 'bg-red-500/15 text-red-700 dark:text-red-300',
            };
        default:
            return {
                border: 'border-l-border',
                badge: 'bg-muted text-muted-foreground',
            };
    }
}

function classificationMarkerClass(c: MoveClassification): string {
    switch (c) {
        case 'brilliant':
            return 'border-fuchsia-100 bg-fuchsia-600 text-white';
        case 'great':
        case 'best':
            return 'border-emerald-100 bg-emerald-600 text-white';
        case 'excellent':
        case 'good':
            return 'border-green-100 bg-green-600 text-white';
        case 'book':
            return 'border-slate-100 bg-slate-600 text-white';
        case 'inaccuracy':
            return 'border-amber-100 bg-amber-500 text-white';
        case 'mistake':
            return 'border-orange-100 bg-orange-600 text-white';
        case 'blunder':
            return 'border-red-100 bg-red-600 text-white';
    }
}

function extractionReasonLabel(reason: ExtractionDecisionReason): string {
    switch (reason) {
        case 'SAVED':
            return 'Saved as a practice position';
        case 'FORCED_MOVE':
            return 'Not saved: there was only one legal move';
        case 'BELOW_COVERAGE_THRESHOLD':
            return 'Not saved: the outcome difference was below your coverage threshold';
        case 'BELOW_THRESHOLD_AFTER_CONFIRMATION':
            return 'Not saved: deeper confirmation put the difference below your threshold';
        case 'ANALYSIS_INCOMPLETE':
            return 'Not saved: engine evidence was incomplete';
        case 'VERIFICATION_UNSTABLE':
            return 'Not saved yet: deeper verification remained unstable';
    }
}

export function GameViewer({
    pgn,
    metaLabel,
    analysis,
    trainingMoments,
    userBoardOrientation,
    initialPly,
}: {
    pgn: string;
    metaLabel?: string;
    analysis?: GameAnalysis | null;
    trainingMoments?: TrainingMomentPreview[];
    userBoardOrientation?: 'white' | 'black';
    initialPly?: number;
}) {
    const parsed = useMemo(() => {
        const chess = new Chess();
        try {
            chess.loadPgn(pgn, { strict: false });
        } catch {
            return null;
        }
        const verboseMoves = chess.history({ verbose: true }) as VerboseMove[];
        const movesSan = verboseMoves.map((m) => m.san);
        const startFen = (() => {
            const fenTag = extractStartFenFromPgn(pgn);
            if (fenTag) return fenTag;
            const c2 = new Chess();
            try {
                c2.loadPgn(pgn, { strict: false });
                while (c2.undo()) {}
                return c2.fen();
            } catch {
                return START_FEN;
            }
        })();
        // Precompute per-ply positions for fast scrubbing
        const c = new Chess(startFen);
        const positions: { fen: string; lastMove: { from: Square; to: Square } | null }[] =
            [{ fen: c.fen(), lastMove: null }];
        for (const m of verboseMoves) {
            try {
                const mv = c.move({
                    from: m.from,
                    to: m.to,
                    promotion: (m as unknown as { promotion?: string }).promotion,
                });
                if (!mv) break;
                positions.push({
                    fen: c.fen(),
                    lastMove: { from: mv.from as Square, to: mv.to as Square },
                });
            } catch {
                break;
            }
        }
        return { movesSan, verboseMoves, startFen, positions };
    }, [pgn]);

    const initialPlyForState = initialPlyValue(
        initialPly,
        parsed ? parsed.positions.length - 1 : undefined
    );
    const initialSelectionFen =
        parsed?.positions[initialPlyForState]?.fen ?? parsed?.startFen ?? START_FEN;

    const [ply, setPly] = useState(initialPlyForState);
    const [showPvArrows, setShowPvArrows] = useState(true);
    const movesScrollRef = useRef<HTMLDivElement | null>(null);

    const engineStore = useMemo(() => createStockfishClientStore(), []);
    const engineClient = useSyncExternalStore(
        engineStore.subscribe,
        engineStore.getSnapshot,
        engineStore.getServerSnapshot
    );
    const [analysisEnabled, setAnalysisEnabled] = useState(false);
    const [analysisMultiPv, setAnalysisMultiPv] = useState(3);
    const [activePanel, setActivePanel] = useState<'review' | 'moves' | 'engine'>(
        'review'
    );
    const [isPlaying, setIsPlaying] = useState(false);
    const [selection, setSelection] = useState<PvSelection>(
        defaultPvSelection(initialSelectionFen)
    );

    const clampedPly = useMemo(() => {
        if (!parsed) return 0;
        return clamp(ply, 0, parsed.positions.length - 1);
    }, [ply, parsed]);
    const extractionReceiptByPly = useMemo(
        () =>
            new Map(
                (analysis?.trainingExtraction?.decisions ?? []).map(
                    (decision) => [decision.ply, decision] as const
                )
            ),
        [analysis?.trainingExtraction?.decisions]
    );
    const activeExtractionReceipt =
        clampedPly > 0
            ? extractionReceiptByPly.get(clampedPly - 1)
            : undefined;
    const analysisMoveByPly = useMemo(
        () =>
            new Map(
                (analysis?.moves ?? []).map(
                    (move) => [move.ply, move] as const
                )
            ),
        [analysis?.moves]
    );
    const activeAnalyzedMove =
        clampedPly > 0
            ? analysisMoveByPly.get(clampedPly - 1)
            : undefined;

    // Keep the active move visible in the move list, without scrolling the page.
    // `scrollIntoView()` can scroll the *window* which feels like the page is jumping.
    useEffect(() => {
        if (!parsed) return;
        if (clampedPly <= 0) return;
        const container = movesScrollRef.current;
        if (!container) return;

        const idx = clampedPly - 1;
        const el = container.querySelector<HTMLElement>(`#game-move-${idx}`);
        if (!el) return;

        const padding = 12;
        const elTop = el.offsetTop;
        const elBottom = elTop + el.offsetHeight;
        const viewTop = container.scrollTop;
        const viewBottom = viewTop + container.clientHeight;

        if (elTop - padding < viewTop) {
            container.scrollTop = Math.max(0, elTop - padding);
        } else if (elBottom + padding > viewBottom) {
            container.scrollTop = Math.max(0, elBottom + padding - container.clientHeight);
        }
    }, [clampedPly, parsed]);

    const fen = useMemo(() => {
        if (!parsed) return START_FEN;
        return parsed.positions[clampedPly]?.fen ?? parsed.startFen;
    }, [parsed, clampedPly]);

    const setActivePly = useCallback(
        (nextPly: number) => {
            if (!parsed) {
                setPly(Math.max(0, Math.trunc(nextPly)));
                return;
            }

            const next = clamp(Math.trunc(nextPly), 0, parsed.positions.length - 1);
            const nextFen = parsed.positions[next]?.fen ?? parsed.startFen;

            setPly(next);
            if (nextFen !== fen) setSelection(defaultPvSelection(nextFen));
        },
        [fen, parsed]
    );

    useEffect(() => {
        if (!isPlaying || !parsed) return;
        const timer = window.setTimeout(() => {
            if (clampedPly >= parsed.positions.length - 1) {
                setIsPlaying(false);
                return;
            }
            setActivePly(clampedPly + 1);
        }, clampedPly >= parsed.positions.length - 1 ? 0 : 720);
        return () => window.clearTimeout(timer);
    }, [clampedPly, isPlaying, parsed, setActivePly]);

    // Only construct the engine when analysis is needed.
    useEffect(() => {
        if (!analysisEnabled) return;
        if (!fen) return;
        engineStore.ensureClient();
    }, [analysisEnabled, engineStore, fen]);

    const lastMove = useMemo(() => {
        if (!parsed) return null;
        return parsed.positions[clampedPly]?.lastMove ?? null;
    }, [parsed, clampedPly]);

    const trainingMomentByPly = useMemo(() => {
        const m = new Map<number, TrainingMomentPreview>();
        for (const moment of trainingMoments ?? []) {
            m.set(moment.decisionPly, moment);
        }
        return m;
    }, [trainingMoments]);

    // Arrow-key navigation through the game
    useEffect(() => {
        function onKeyDown(e: KeyboardEvent) {
            if (isEditableTarget(e.target)) return;
            if (!parsed) return;
            // Prevent focused UI (e.g. Radix Tabs) from hijacking arrow keys.
            if (
                e.key === 'ArrowLeft' ||
                e.key === 'ArrowRight' ||
                e.key === 'Home' ||
                e.key === 'End'
            ) {
                e.stopPropagation();
                e.stopImmediatePropagation?.();
            }

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setActivePly(clampedPly - 1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setActivePly(clampedPly + 1);
            } else if (e.key === 'Home') {
                e.preventDefault();
                setActivePly(0);
            } else if (e.key === 'End') {
                e.preventDefault();
                setActivePly(parsed.positions.length - 1);
            }
        }
        window.addEventListener('keydown', onKeyDown, { capture: true });
        return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
    }, [clampedPly, parsed, setActivePly]);

    const analyzeStreamingEnabled = analysisEnabled && !!fen && !!engineClient;
    const live = useStockfishLiveMultiPvAnalysis({
        client: engineClient,
        fen: analyzeStreamingEnabled ? fen : null,
        multiPv: analysisMultiPv,
        enabled: analyzeStreamingEnabled,
        emitIntervalMs: 150,
    });

    const analysisBusy =
        live.running ||
        (analysisEnabled &&
            // show busy while engine is being created or before first update arrives
            (!engineClient || (!live.update && !live.error)));

    const selectedLine = useMemo(() => {
        const lines = live.lines;
        const activeSelection =
            selection.fen === fen ? selection : defaultPvSelection(fen);
        if (activeSelection.key) {
            const idx = lines.findIndex(
                (l) => (l.pvUci ?? []).join(' ') === activeSelection.key
            );
            if (idx >= 0) return idx;
        }
        return Math.max(0, Math.min(activeSelection.idx, lines.length - 1));
    }, [live.lines, selection, fen]);

    const pvSanByLine = useMemo(() => {
        const lines = live.lines ?? [];
        return lines.map((l) => {
            const san = uciLineToSan(fen, l.pvUci ?? [], 12);
            return {
                preview: san.slice(0, 8).join(' '),
                full: san.join(' '),
            };
        });
    }, [live.lines, fen]);

    useEffect(() => {
        return () => {
            engineStore.terminate();
        };
    }, [engineStore]);

    const analysisEvalScore = useMemo(() => {
        const line = live.lines?.[selectedLine] ?? live.lines?.[0];
        return line?.score ?? null;
    }, [live.lines, selectedLine]);

    const analysisEvalText = useMemo(() => {
        return formatEngineScoreForWhite(analysisEvalScore, fen);
    }, [analysisEvalScore, fen]);

    const analysisEvalUnit = useMemo(() => {
        const line = live.lines?.[selectedLine] ?? live.lines?.[0];
        return whiteExpectedScore({
            score: line?.score ?? null,
            wdl: line?.wdl,
            fen,
        });
    }, [fen, live.lines, selectedLine]);

    const analysisArrows = useMemo(() => {
        const byKey = new Map<
            string,
            { startSquare: Square; endSquare: Square; color: string }
        >();
        const put = (a: { startSquare: Square; endSquare: Square; color: string }) => {
            byKey.set(`${a.startSquare}-${a.endSquare}`, a);
        };
        const colors = [
            'rgba(59,130,246,0.80)',
            'rgba(16,185,129,0.75)',
            'rgba(245,158,11,0.75)',
        ];
        const lines = live.lines ?? [];
        for (let i = 0; i < Math.min(3, lines.length); i++) {
            if (i === selectedLine) continue;
            const first = lines[i]?.pvUci?.[0];
            const u = first ? parseUci(first) : null;
            if (!u) continue;
            put({
                startSquare: u.from as Square,
                endSquare: u.to as Square,
                color: colors[i]
                    .replace('0.80', '0.35')
                    .replace('0.75', '0.35'),
            });
        }
        const first = (live.lines ?? [])[selectedLine]?.pvUci?.[0];
        const u = first ? parseUci(first) : null;
        if (u) {
            put({
                startSquare: u.from as Square,
                endSquare: u.to as Square,
                color: colors[selectedLine] ?? 'rgba(59,130,246,0.80)',
            });
        }
        return Array.from(byKey.values());
    }, [live.lines, selectedLine]);

    const squareStyles = useMemo(() => {
        const s: Record<string, React.CSSProperties> = {};
        if (lastMove) {
            s[lastMove.from] = { backgroundColor: 'rgba(255, 215, 0, 0.18)' };
            s[lastMove.to] = { backgroundColor: 'rgba(255, 215, 0, 0.34)' };
        }
        return s;
    }, [lastMove]);

    if (!parsed) {
        return (
            <ErrorState
                title="This game could not be displayed"
                description="The saved PGN is incomplete or invalid. You can still open the original game or use the game actions outside this review."
            />
        );
    }

    const activeAccent = activeAnalyzedMove
        ? classificationAccent(activeAnalyzedMove.classification)
        : null;

    const moveRows: { moveNo: number; w?: number; b?: number }[] = [];
    for (let i = 0; i < parsed.movesSan.length; i += 2) {
        moveRows.push({
            moveNo: i / 2 + 1,
            w: i,
            b: i + 1 < parsed.movesSan.length ? i + 1 : undefined,
        });
    }

    const moveCell = (
        row: { moveNo: number },
        idx: number | undefined,
        side: 'w' | 'b'
    ) => {
        if (idx == null) return <div className="h-10" />;
        const san = parsed.movesSan[idx]!;
        const analyzedMove = analysisMoveByPly.get(idx);
        const trainingMoment = trainingMomentByPly.get(idx);
        const active = clampedPly === idx + 1;
        const accent = analyzedMove
            ? classificationAccent(analyzedMove.classification)
            : null;
        const symbol = analyzedMove
            ? getClassificationSymbol(analyzedMove.classification)
            : null;

        return (
            <button
                key={`${side}-${idx}`}
                id={`game-move-${idx}`}
                type="button"
                aria-current={active ? 'true' : undefined}
                className={cn(
                    'flex h-10 min-w-0 items-center gap-2 rounded-lg border-l-2 px-2.5 text-left font-mono text-xs transition-all duration-150',
                    'hover:bg-muted/65 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    accent?.border ?? 'border-l-border',
                    active ? 'bg-primary/8 ring-1 ring-primary/25' : 'bg-transparent'
                )}
                onClick={() => {
                    setIsPlaying(false);
                    setActivePly(idx + 1);
                }}
            >
                <span className="w-7 shrink-0 text-muted-foreground">
                    {side === 'w' ? `${row.moveNo}.` : '…'}
                </span>
                <span className="truncate font-semibold">{san}</span>
                {symbol && analyzedMove ? (
                    <span
                        className={cn(
                            'ml-auto inline-flex min-w-6 items-center justify-center rounded-md px-1.5 py-0.5 font-sans text-[10px] font-bold',
                            accent?.badge
                        )}
                        title={getClassificationLabel(analyzedMove.classification)}
                    >
                        {symbol}
                    </span>
                ) : null}
                {trainingMoment || analyzedMove?.hasTrainingMoment ? (
                    <span
                        className="h-2 w-2 shrink-0 rounded-full bg-primary"
                        title="Practice position"
                    />
                ) : null}
            </button>
        );
    };

    return (
        <section
            className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,720px)_minmax(320px,1fr)] lg:items-start xl:gap-6"
            aria-label="Game review workspace"
        >
            <div className="min-w-0 lg:sticky lg:top-20">
                <div
                    className="relative mx-auto w-full min-w-0 max-w-[720px] overflow-hidden rounded-[1.25rem] border bg-card p-1.5 shadow-[0_28px_90px_-60px_rgba(15,23,42,0.72)] sm:p-2"
                    data-game-review-board
                >
                    <span className="sr-only" aria-live="polite" aria-atomic="true">
                        {activeAnalyzedMove
                            ? `${getClassificationLabel(activeAnalyzedMove.classification)} move: ${activeAnalyzedMove.san}`
                            : 'Start position'}
                    </span>
                    <div className="min-w-0 max-w-full overflow-hidden rounded-[0.9rem]">
                        <Chessboard
                            options={{
                                position: fen,
                                boardOrientation: userBoardOrientation ?? 'white',
                                allowDragging: false,
                                allowDrawingArrows: false,
                                arrows: showPvArrows ? analysisArrows : [],
                                squareStyles,
                                squareRenderer: ({ square, children }) => (
                                    <div className="relative h-full w-full">
                                        {children}
                                        {activeAnalyzedMove &&
                                        lastMove?.to === square ? (
                                            <span
                                                className={cn(
                                                    'pointer-events-none absolute right-[5%] top-[5%] z-20 flex h-[28%] min-h-5 min-w-5 items-center justify-center rounded-full border text-[clamp(11px,2.8vw,17px)] font-black leading-none shadow-lg',
                                                    'animate-in fade-in zoom-in-75 duration-200 motion-reduce:animate-none',
                                                    classificationMarkerClass(
                                                        activeAnalyzedMove.classification
                                                    )
                                                )}
                                                role="img"
                                                aria-label={`${getClassificationLabel(activeAnalyzedMove.classification)} on ${square}`}
                                                data-game-move-quality={
                                                    activeAnalyzedMove.classification
                                                }
                                            >
                                                {getClassificationSymbol(
                                                    activeAnalyzedMove.classification
                                                )}
                                            </span>
                                        ) : null}
                                    </div>
                                ),
                                showAnimations: true,
                                animationDurationInMs: 240,
                            }}
                        />
                    </div>
                </div>

                <div className="mx-auto mt-2 flex w-full max-w-[720px] items-center justify-between gap-2 rounded-2xl border bg-card/90 p-2 shadow-[0_16px_50px_-45px_rgba(15,23,42,0.55)] backdrop-blur">
                    <div className="flex items-center gap-1">
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Go to start"
                            disabled={clampedPly === 0}
                            onClick={() => {
                                setIsPlaying(false);
                                setActivePly(0);
                            }}
                        >
                            <ChevronsLeft aria-hidden="true" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Previous move"
                            disabled={clampedPly === 0}
                            onClick={() => {
                                setIsPlaying(false);
                                setActivePly(clampedPly - 1);
                            }}
                        >
                            <ChevronLeft aria-hidden="true" />
                        </Button>
                        <Button
                            variant="default"
                            size="icon"
                            aria-label={isPlaying ? 'Pause review' : 'Play review'}
                            onClick={() => {
                                if (
                                    !isPlaying &&
                                    clampedPly >= parsed.positions.length - 1
                                ) {
                                    setActivePly(0);
                                }
                                setIsPlaying((current) => !current);
                            }}
                        >
                            {isPlaying ? (
                                <Pause aria-hidden="true" />
                            ) : (
                                <Play aria-hidden="true" />
                            )}
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Next move"
                            disabled={clampedPly >= parsed.positions.length - 1}
                            onClick={() => {
                                setIsPlaying(false);
                                setActivePly(clampedPly + 1);
                            }}
                        >
                            <ChevronRight aria-hidden="true" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label="Go to end"
                            disabled={clampedPly >= parsed.positions.length - 1}
                            onClick={() => {
                                setIsPlaying(false);
                                setActivePly(parsed.positions.length - 1);
                            }}
                        >
                            <ChevronsRight aria-hidden="true" />
                        </Button>
                    </div>
                    <div className="pr-2 text-right">
                        <div className="text-xs font-semibold tabular-nums">
                            {clampedPly} / {parsed.positions.length - 1}
                        </div>
                        <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                            ply
                        </div>
                    </div>
                </div>
            </div>

            <Tabs
                value={activePanel}
                onValueChange={(value) => {
                    const next = value as 'review' | 'moves' | 'engine';
                    setActivePanel(next);
                    setAnalysisEnabled(next === 'engine');
                }}
                className="min-w-0 overflow-hidden rounded-[1.25rem] border bg-card/80 shadow-[0_22px_70px_-58px_rgba(15,23,42,0.68)]"
            >
                <div className="border-b p-2">
                    <TabsList className="grid w-full grid-cols-3">
                        <TabsTrigger value="review">Review</TabsTrigger>
                        <TabsTrigger value="moves">Moves</TabsTrigger>
                        <TabsTrigger value="engine">Engine</TabsTrigger>
                    </TabsList>
                </div>

                <TabsContent value="review" className="m-0 space-y-4 p-4 sm:p-5">
                    {clampedPly === 0 ? (
                        <div className="rounded-2xl bg-muted/45 p-5">
                            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                Start position
                            </p>
                            <h2 className="mt-2 text-xl font-semibold tracking-tight">
                                Replay the decisions that shaped the game.
                            </h2>
                            <p className="mt-2 text-sm leading-6 text-muted-foreground">
                                Use the controls below the board or select any move
                                from the move list.
                            </p>
                        </div>
                    ) : activeAnalyzedMove ? (
                        <div className="space-y-4">
                            <div className="flex items-start justify-between gap-3">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                        Move {Math.ceil(clampedPly / 2)}
                                    </p>
                                    <h2 className="mt-1 text-2xl font-semibold tracking-tight">
                                        {activeAnalyzedMove.san}
                                    </h2>
                                </div>
                                <span
                                    className={cn(
                                        'inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold',
                                        activeAccent?.badge
                                    )}
                                >
                                    {getClassificationSymbol(
                                        activeAnalyzedMove.classification
                                    )}
                                    {getClassificationLabel(
                                        activeAnalyzedMove.classification
                                    )}
                                </span>
                            </div>

                            <div className="rounded-2xl bg-muted/45 p-4">
                                <p className="text-sm leading-6">
                                    {activeAnalyzedMove.cpLoss <= 10
                                        ? 'This kept the position on its strongest course.'
                                        : `This decision gave up about ${(activeAnalyzedMove.cpLoss / 100).toFixed(2)} pawns of evaluation.`}
                                </p>
                                {activeAnalyzedMove.bestMoveSan &&
                                activeAnalyzedMove.bestMoveSan !==
                                    activeAnalyzedMove.san ? (
                                    <p className="mt-2 text-sm text-muted-foreground">
                                        Best was{' '}
                                        <span className="font-semibold text-foreground">
                                            {activeAnalyzedMove.bestMoveSan}
                                        </span>
                                        .
                                    </p>
                                ) : null}
                            </div>

                            {activeExtractionReceipt ? (
                                <div className="rounded-2xl border p-4 text-sm">
                                    <div className="font-medium">
                                        {extractionReasonLabel(
                                            activeExtractionReceipt.reason
                                        )}
                                    </div>
                                    {activeExtractionReceipt.winChanceLoss != null ||
                                    activeExtractionReceipt.cpLoss != null ? (
                                        <div className="mt-1 text-xs text-muted-foreground">
                                            {activeExtractionReceipt.winChanceLoss != null
                                                ? `${(
                                                      activeExtractionReceipt.winChanceLoss *
                                                      100
                                                  ).toFixed(1)}% winning-chance loss`
                                                : `${Math.round(
                                                      activeExtractionReceipt.cpLoss ??
                                                          0
                                                  )} cp loss`}
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}

                            {activeAnalyzedMove.hasTrainingMoment ||
                            trainingMomentByPly.has(clampedPly - 1) ? (
                                <Button asChild className="w-full">
                                    <Link href="/practice">
                                        <Target aria-hidden="true" />
                                        Practice this kind of decision
                                    </Link>
                                </Button>
                            ) : null}
                        </div>
                    ) : (
                        <div className="rounded-2xl bg-muted/45 p-5 text-sm text-muted-foreground">
                            This move has no saved review classification yet. Open
                            Engine for live analysis.
                        </div>
                    )}

                    {analysis ? (
                        <div className="grid grid-cols-3 gap-2 border-t pt-4 text-center">
                            <div>
                                <div className="font-semibold tabular-nums">
                                    {analysis.whiteAccuracy?.toFixed(1) ?? '—'}%
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                    White
                                </div>
                            </div>
                            <div>
                                <div className="font-semibold tabular-nums">
                                    {analysis.blackAccuracy?.toFixed(1) ?? '—'}%
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                    Black
                                </div>
                            </div>
                            <div>
                                <div className="font-semibold tabular-nums">
                                    {analysis.trainingExtraction?.summary
                                        .savedPositions ?? 0}
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                                    Positions
                                </div>
                            </div>
                        </div>
                    ) : null}
                </TabsContent>

                <TabsContent value="moves" className="m-0 p-3 sm:p-4">
                    <div
                        ref={movesScrollRef}
                        className="max-h-[min(62vh,620px)] space-y-1 overflow-auto pr-1"
                    >
                        {moveRows.map((row) => (
                            <div key={row.moveNo} className="grid grid-cols-2 gap-1">
                                {moveCell(row, row.w, 'w')}
                                {moveCell(row, row.b, 'b')}
                            </div>
                        ))}
                    </div>
                </TabsContent>

                <TabsContent value="engine" className="m-0 space-y-4 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <h2 className="font-semibold">Live Stockfish</h2>
                            <p className="text-xs text-muted-foreground">
                                Runs only while this tab is open.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <div className="w-[112px]">
                                <Select
                                    value={String(analysisMultiPv)}
                                    onValueChange={(value) =>
                                        setAnalysisMultiPv(
                                            Math.max(
                                                1,
                                                Math.min(
                                                    5,
                                                    Math.trunc(Number(value) || 1)
                                                )
                                            )
                                        )
                                    }
                                >
                                    <SelectTrigger className="h-11 sm:h-9">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {[1, 2, 3, 4, 5].map((count) => (
                                            <SelectItem
                                                key={count}
                                                value={String(count)}
                                            >
                                                {count} {count === 1 ? 'line' : 'lines'}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setShowPvArrows((current) => !current)}
                            >
                                {showPvArrows ? 'Hide arrows' : 'Show arrows'}
                            </Button>
                        </div>
                    </div>

                    <div className="rounded-2xl bg-muted/45 p-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="font-mono text-sm font-semibold">
                                White {analysisEvalText}
                            </div>
                            <div className="h-2 w-32 overflow-hidden rounded-full bg-background">
                                <div
                                    className="h-full bg-primary transition-[width] duration-300"
                                    style={{
                                        width: `${Math.round(analysisEvalUnit * 100)}%`,
                                    }}
                                />
                            </div>
                        </div>
                        <div className="mt-2 flex h-5 items-center gap-2 text-xs text-muted-foreground">
                            <div
                                className={cn(
                                    'h-3.5 w-3.5 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-primary',
                                    analysisBusy ? 'opacity-100' : 'opacity-0'
                                )}
                                aria-hidden={!analysisBusy}
                            />
                            {analysisBusy
                                ? `Thinking${typeof live.depth === 'number' ? ` · depth ${live.depth}` : ''}${typeof live.timeMs === 'number' ? ` · ${(live.timeMs / 1000).toFixed(1)}s` : ''}`
                                : 'Ready'}
                            {live.error ? (
                                <span className="ml-auto text-destructive">
                                    {live.error}
                                </span>
                            ) : null}
                        </div>
                    </div>

                    <div className="space-y-2">
                        {(live.lines ?? []).slice(0, 5).map((line, index) => (
                            <button
                                key={index}
                                type="button"
                                onClick={() =>
                                    setSelection({
                                        fen,
                                        idx: index,
                                        key: (line.pvUci ?? []).join(' '),
                                    })
                                }
                                className={cn(
                                    'w-full rounded-xl border px-3 py-2.5 text-left transition-all duration-150 hover:-translate-y-px hover:bg-muted/50',
                                    index === selectedLine &&
                                        'border-primary/35 bg-primary/5'
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-semibold">
                                        Line {index + 1}
                                    </span>
                                    <span className="font-mono text-xs text-muted-foreground">
                                        {formatEngineScoreForWhite(line.score, fen)}
                                    </span>
                                </div>
                                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                                    {pvSanByLine[index]?.preview ?? ''}
                                </div>
                            </button>
                        ))}
                    </div>

                    <Separator />
                    <p className="break-words font-mono text-[11px] leading-5 text-muted-foreground">
                        {pvSanByLine[selectedLine]?.full ??
                            pvSanByLine[0]?.full ??
                            'Engine line will appear here.'}
                    </p>
                    {metaLabel ? (
                        <p className="text-[11px] text-muted-foreground">
                            {metaLabel}
                        </p>
                    ) : null}
                </TabsContent>
            </Tabs>
        </section>
    );
}
