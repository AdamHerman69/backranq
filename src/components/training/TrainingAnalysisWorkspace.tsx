'use client';

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { Chess, type Square } from 'chess.js';
import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ChevronsLeft,
    ChevronsRight,
    FlipHorizontal2,
    Loader2,
    Pause,
    Play,
    RotateCcw,
    ShieldAlert,
} from 'lucide-react';
import { Chessboard } from 'react-chessboard';

import { TrainingAnalysisMoveTree } from '@/components/training/TrainingAnalysisMoveTree';
import {
    TRAINING_ANALYSIS_CONTEXT_PALETTE,
    trainingAnalysisChipStyle,
    trainingAnalysisDotStyle,
    trainingAnalysisFrameStyle,
} from '@/components/training/trainingAnalysisPalette';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import { ModalDialog } from '@/components/ui/ModalDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/ui/tabs';
import {
    formatEngineScoreForWhite,
    formatEngineWdlForWhite,
    whiteExpectedScore,
} from '@/lib/analysis/evaluation';
import type { StockfishClient } from '@/lib/analysis/stockfishClient';
import { moveToUci, parseUci, uciLineToSan } from '@/lib/chess/utils';
import { useStockfishLiveMultiPvAnalysis } from '@/lib/hooks/useStockfishLiveMultiPvAnalysis';
import { useReliableBoardTouch } from '@/lib/hooks/useReliableBoardTouch';
import {
    loadTrainingAnalysisDraft,
    saveTrainingAnalysisDraft,
} from '@/lib/training/analysisDraftStore';
import {
    createTrainingAnalysisTree,
    deleteTrainingAnalysisVariation,
    firstTrainingAnalysisNode,
    jumpToTrainingAnalysisNode,
    lastTrainingAnalysisNode,
    nextTrainingAnalysisNode,
    playTrainingAnalysisMove,
    previousTrainingAnalysisNode,
    promoteTrainingAnalysisVariation,
    siblingTrainingAnalysisNode,
    threatModeFen,
    trainingAnalysisAnchorNodes,
    trainingAnalysisPath,
    trainingAnalysisPositionContext,
    type TrainingAnalysisPositionContext,
    type TrainingAnalysisTree,
} from '@/lib/training/analysisTree';
import {
    TRAINING_ANALYSIS_DEFAULT_MULTIPV,
    TRAINING_ANALYSIS_MAX_DEPTH,
    TRAINING_ANALYSIS_MAX_TIME_MS,
} from '@/lib/training/analysisWorkspace';
import type { TrainingPromptDto, TrainingReviewDto } from '@/lib/training/api';
import { cn } from '@/lib/utils';

type PromotionPiece = 'q' | 'r' | 'b' | 'n';

type PendingPromotion = {
    from: Square;
    to: Square;
    choices: PromotionPiece[];
};

type DraftStatus =
    | 'loading'
    | 'saving'
    | 'saved'
    | 'session'
    | 'unavailable';

type AnalysisPanel = 'review' | 'moves' | 'engine';

export type PositionAnalysisSeed = {
    sessionKey: string;
    revisionKey: string;
    decisionFen: string;
    sideToMove: 'w' | 'b';
    positionHistory: string[];
    originalMoveUci?: string | null;
    submittedMoveUci?: string | null;
    bestLineUci?: string[];
};

const LINE_COLORS = [
    'rgba(59,130,246,0.82)',
    'rgba(16,185,129,0.78)',
    'rgba(245,158,11,0.78)',
    'rgba(168,85,247,0.78)',
    'rgba(244,63,94,0.78)',
] as const;

const THREAT_LINE_COLORS = [
    'rgba(239,68,68,0.90)',
    'rgba(244,63,94,0.72)',
    'rgba(249,115,22,0.68)',
] as const;

function isEditableTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tagName = target.tagName.toLowerCase();
    return (
        tagName === 'input' ||
        tagName === 'textarea' ||
        target.isContentEditable ||
        Boolean(
            target.closest(
                '[role="dialog"], [role="listbox"], [role="menu"]'
            )
        )
    );
}

function cursorDescription(tree: TrainingAnalysisTree): string {
    const node = tree.nodes[tree.cursorId];
    if (!node) return 'Analysis position';
    if (node.id === tree.decisionNodeId) return 'Decision position';
    if (node.id === tree.submittedMoveNodeId) return 'After your move';
    if (node.id === tree.gameMoveNodeId) return 'After the game move';
    if (node.id === tree.bestLineNodeId) return 'End of best line';
    return node.moveSan ? `After ${node.moveSan}` : 'Analysis variation';
}

function draftStatusLabel(status: DraftStatus): string {
    if (status === 'loading') return 'Restoring local draft…';
    if (status === 'saving') return 'Saving locally…';
    if (status === 'saved') return 'Saved on this device';
    if (status === 'session') return 'Session only';
    return 'Local saving unavailable';
}

function AnalysisPositionContextBar({
    context,
    showBackToDecision,
    onBackToDecision,
}: {
    context: TrainingAnalysisPositionContext;
    showBackToDecision: boolean;
    onBackToDecision: () => void;
}) {
    const palette = TRAINING_ANALYSIS_CONTEXT_PALETTE[context];
    return (
        <div
            className="mb-1.5 flex min-h-8 items-center gap-2 px-1"
            aria-live="polite"
        >
            <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={trainingAnalysisDotStyle(context)}
                aria-hidden="true"
            />
            <span
                className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]"
                style={trainingAnalysisChipStyle(context)}
            >
                <span className="truncate font-medium">{palette.label}</span>
                <span
                    className="hidden text-muted-foreground sm:inline"
                    aria-hidden="true"
                >
                    · {palette.detail}
                </span>
            </span>
            {showBackToDecision ? (
                <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-11 px-2 text-[11px] text-muted-foreground sm:h-7"
                    onClick={onBackToDecision}
                >
                    Back to decision
                </Button>
            ) : null}
        </div>
    );
}

export function TrainingAnalysisWorkspace({
    active,
    prompt,
    initialFen,
    review,
    positionSeed,
    persistDraft = true,
    engineClient,
    onRequestEngine,
    flipped,
    onFlip,
    loadingNext,
    onNext,
    heading = 'Analyze the position',
    description = 'Explore legal moves freely. Your variations stay on this device and never change the practice result.',
    primaryActionLabel = 'Next position',
    primaryActionLoadingLabel = 'Loading next…',
    primaryActionShortcut = 'N',
    primaryActionHint = 'next',
    children,
}: {
    active: boolean;
    prompt?: TrainingPromptDto;
    initialFen: string;
    review?: TrainingReviewDto;
    positionSeed?: PositionAnalysisSeed;
    persistDraft?: boolean;
    engineClient: StockfishClient | null;
    onRequestEngine: () => StockfishClient | null;
    flipped: boolean;
    onFlip: () => void;
    loadingNext: boolean;
    onNext: () => void;
    heading?: string;
    description?: string;
    primaryActionLabel?: string;
    primaryActionLoadingLabel?: string;
    primaryActionShortcut?: string | null;
    primaryActionHint?: string;
    children?: ReactNode;
}) {
    const resolvedSeed = useMemo<PositionAnalysisSeed>(() => {
        if (positionSeed) return positionSeed;
        if (!prompt || !review) {
            throw new Error(
                'Position analysis requires either a training prompt and review or an explicit position seed.'
            );
        }
        return {
            sessionKey: prompt.id,
            revisionKey: prompt.solutionRevisionId,
            decisionFen: prompt.fen,
            sideToMove: prompt.sideToMove,
            positionHistory: prompt.grading.positionHistory,
            originalMoveUci: review.originalMoveUci,
            submittedMoveUci: review.submittedMoveUci,
            bestLineUci: review.bestLineUci,
        };
    }, [positionSeed, prompt, review]);
    const seedTree = useMemo(
        () =>
            createTrainingAnalysisTree({
                decisionFen: resolvedSeed.decisionFen,
                positionHistory: resolvedSeed.positionHistory,
                originalMoveUci: resolvedSeed.originalMoveUci,
                submittedMoveUci: resolvedSeed.submittedMoveUci,
                bestLineUci: resolvedSeed.bestLineUci,
                initialFen,
            }),
        [initialFen, resolvedSeed]
    );
    const [tree, setTree] = useState<TrainingAnalysisTree>(() => seedTree);
    const [draftReady, setDraftReady] = useState(!persistDraft);
    const [draftStatus, setDraftStatus] =
        useState<DraftStatus>(
            persistDraft ? 'loading' : 'session'
        );
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [pendingPromotion, setPendingPromotion] =
        useState<PendingPromotion | null>(null);
    const [multiPv, setMultiPv] = useState(TRAINING_ANALYSIS_DEFAULT_MULTIPV);
    const [selectedMultiPv, setSelectedMultiPv] = useState(1);
    const [analysisEnabled, setAnalysisEnabled] = useState(false);
    const [activePanel, setActivePanel] = useState<AnalysisPanel>(() =>
        children ? 'review' : 'moves'
    );
    const [threatCursorId, setThreatCursorId] = useState<string | null>(null);
    const [clearDialogOpen, setClearDialogOpen] = useState(false);
    const [engineRequestError, setEngineRequestError] = useState<string | null>(
        null
    );
    const engineRequestedRef = useRef(false);
    const headingRef = useRef<HTMLHeadingElement>(null);

    const cursorNode = tree.nodes[tree.cursorId] ?? tree.nodes[tree.rootId]!;
    const cursorFen = cursorNode.fen;
    const threatFen = useMemo(() => threatModeFen(cursorFen), [cursorFen]);
    const threatMode =
        threatCursorId === tree.cursorId && threatFen !== null;
    const engineFen = threatMode ? threatFen! : cursorFen;
    const path = useMemo(() => trainingAnalysisPath(tree), [tree]);
    const anchors = useMemo(() => trainingAnalysisAnchorNodes(tree), [tree]);
    const parentNode = cursorNode.parentId
        ? tree.nodes[cursorNode.parentId]
        : null;
    const siblingCount = parentNode?.childrenIds.length ?? 0;
    const hasNextNode = cursorNode.childrenIds.length > 0;
    const atLineEnd = !hasNextNode;
    const positionContext = trainingAnalysisPositionContext(tree);
    const hasUserVariations = useMemo(
        () =>
            Object.values(tree.nodes).some(
                (node) =>
                    node.tags.length === 1 &&
                    node.tags[0] === 'ANALYSIS'
            ),
        [tree.nodes]
    );

    useEffect(() => {
        if (!persistDraft) return;
        let cancelled = false;
        void loadTrainingAnalysisDraft({
            promptId: resolvedSeed.sessionKey,
            solutionRevisionId: resolvedSeed.revisionKey,
            decisionFen: resolvedSeed.decisionFen,
        }).then((restored) => {
            if (cancelled) return;
            if (restored) setTree(restored);
            setDraftReady(true);
            setDraftStatus('saving');
        });
        return () => {
            cancelled = true;
        };
    }, [
        resolvedSeed.decisionFen,
        resolvedSeed.revisionKey,
        resolvedSeed.sessionKey,
        persistDraft,
    ]);

    useEffect(() => {
        if (!draftReady || !persistDraft) return;
        let cancelled = false;
        const timeoutId = window.setTimeout(() => {
            void saveTrainingAnalysisDraft({
                promptId: resolvedSeed.sessionKey,
                solutionRevisionId: resolvedSeed.revisionKey,
                tree,
            }).then((saved) => {
                if (!cancelled) {
                    setDraftStatus(saved ? 'saved' : 'unavailable');
                }
            });
        }, 400);
        return () => {
            cancelled = true;
            window.clearTimeout(timeoutId);
        };
    }, [
        draftReady,
        resolvedSeed.revisionKey,
        resolvedSeed.sessionKey,
        persistDraft,
        tree,
    ]);

    const liveAnalysis = useStockfishLiveMultiPvAnalysis({
        client: engineClient,
        fen: engineFen,
        multiPv,
        enabled: active && draftReady && analysisEnabled,
        maxDepth: TRAINING_ANALYSIS_MAX_DEPTH,
        maxTimeMs: TRAINING_ANALYSIS_MAX_TIME_MS,
        emitIntervalMs: 150,
    });
    const currentUpdate =
        liveAnalysis.update?.fen === engineFen ? liveAnalysis.update : null;
    const lines = useMemo(
        () =>
            [...(currentUpdate?.lines ?? [])].sort(
                (left, right) => left.multipv - right.multipv
            ),
        [currentUpdate?.lines]
    );
    const selectedLine =
        lines.find((line) => line.multipv === selectedMultiPv) ??
        lines[0] ??
        null;

    const requestEngine = useCallback(() => {
        engineRequestedRef.current = true;
        try {
            const client = onRequestEngine();
            if (!client) {
                setEngineRequestError(
                    'Local Stockfish could not start on this device.'
                );
            } else {
                setEngineRequestError(null);
            }
        } catch {
            setEngineRequestError(
                'Local Stockfish could not start on this device.'
            );
        }
    }, [onRequestEngine]);

    const selectPanel = useCallback(
        (panel: AnalysisPanel) => {
            setActivePanel(panel);
            if (panel !== 'engine') {
                setAnalysisEnabled(false);
                return;
            }
            setAnalysisEnabled(true);
            if (!engineClient && !engineRequestedRef.current) {
                requestEngine();
            }
        },
        [engineClient, requestEngine]
    );

    useEffect(() => {
        if (!active) {
            const timeoutId = window.setTimeout(() => {
                setSelectedSquare(null);
                setPendingPromotion(null);
            }, 0);
            return () => window.clearTimeout(timeoutId);
        }
        const animationFrame = window.requestAnimationFrame(() => {
            headingRef.current?.focus();
        });
        return () => window.cancelAnimationFrame(animationFrame);
    }, [active]);

    const legalTargets = useMemo(() => {
        if (!active || !draftReady || !selectedSquare) {
            return new Set<Square>();
        }
        try {
            const chess = new Chess(cursorFen);
            return new Set(
                chess
                    .moves({
                        square: selectedSquare,
                        verbose: true,
                    })
                    .map((move) => move.to as Square)
            );
        } catch {
            return new Set<Square>();
        }
    }, [active, cursorFen, draftReady, selectedSquare]);

    const displayLastMove = useMemo(() => {
        const move = cursorNode.moveUci
            ? parseUci(cursorNode.moveUci)
            : null;
        return move
            ? {
                  from: move.from as Square,
                  to: move.to as Square,
              }
            : null;
    }, [cursorNode.moveUci]);

    const squareStyles = useMemo(() => {
        const styles: Record<string, React.CSSProperties> = {};
        if (displayLastMove) {
            styles[displayLastMove.from] = {
                backgroundColor: 'rgba(124,58,237,0.20)',
            };
            styles[displayLastMove.to] = {
                backgroundColor: 'rgba(124,58,237,0.30)',
            };
        }
        if (selectedSquare) {
            styles[selectedSquare] = {
                backgroundColor: 'hsl(var(--board-selected) / 0.72)',
                boxShadow:
                    'inset 0 0 0 3px hsl(var(--foreground) / 0.3)',
            };
        }
        for (const square of legalTargets) {
            styles[square] = {
                background:
                    'radial-gradient(circle, hsl(var(--foreground) / 0.38) 0 16%, transparent 18%)',
            };
        }
        return styles;
    }, [displayLastMove, legalTargets, selectedSquare]);

    const arrows = useMemo(() => {
        const seen = new Set<string>();
        return lines.slice(0, 3).flatMap((line, index) => {
            const move = parseUci(line.pvUci[0] ?? '');
            if (!move) return [];
            const key = `${move.from}${move.to}`;
            if (seen.has(key)) return [];
            seen.add(key);
            const colors = threatMode ? THREAT_LINE_COLORS : LINE_COLORS;
            return [
                {
                    startSquare: move.from as Square,
                    endSquare: move.to as Square,
                    color: colors[index] ?? colors[0],
                },
            ];
        });
    }, [lines, threatMode]);

    const navigateTree = useCallback(
        (navigate: (current: TrainingAnalysisTree) => TrainingAnalysisTree) => {
            setTree(navigate);
            setSelectedSquare(null);
            setPendingPromotion(null);
            setSelectedMultiPv(1);
            setThreatCursorId(null);
            if (draftReady) setDraftStatus('saving');
        },
        [draftReady]
    );

    const jumpToNode = useCallback((nodeId: string) => {
        navigateTree((current) =>
            jumpToTrainingAnalysisNode(current, nodeId)
        );
    }, [navigateTree]);

    const goToPreviousPosition = useCallback(() => {
        navigateTree(previousTrainingAnalysisNode);
    }, [navigateTree]);

    const goToNextPosition = useCallback(() => {
        navigateTree(nextTrainingAnalysisNode);
    }, [navigateTree]);

    const goToSibling = useCallback((direction: -1 | 1) => {
        navigateTree((current) =>
            siblingTrainingAnalysisNode(current, direction)
        );
    }, [navigateTree]);

    const resetWorkspace = useCallback(() => {
        setTree(seedTree);
        setThreatCursorId(null);
        setClearDialogOpen(false);
        setDraftStatus('saving');
    }, [seedTree]);

    const promoteVariation = useCallback((nodeId: string) => {
        setTree((current) =>
            promoteTrainingAnalysisVariation(current, nodeId)
        );
        setDraftStatus('saving');
    }, []);

    useEffect(() => {
        if (!active) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (
                event.defaultPrevented ||
                isEditableTarget(event.target) ||
                event.metaKey ||
                event.ctrlKey ||
                event.altKey ||
                pendingPromotion
            ) {
                return;
            }
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                goToPreviousPosition();
            } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                goToNextPosition();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                goToSibling(-1);
            } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                goToSibling(1);
            } else if (event.key === 'Home') {
                event.preventDefault();
                navigateTree(firstTrainingAnalysisNode);
            } else if (event.key === 'End') {
                event.preventDefault();
                navigateTree(lastTrainingAnalysisNode);
            } else if (event.key.toLowerCase() === 'r') {
                event.preventDefault();
                jumpToNode(tree.decisionNodeId);
            } else if (
                event.key.toLowerCase() === 'x' &&
                threatFen !== null
            ) {
                event.preventDefault();
                const activateThreats = !threatMode;
                setThreatCursorId(
                    activateThreats ? tree.cursorId : null
                );
                if (activateThreats) selectPanel('engine');
            } else if (
                primaryActionShortcut &&
                event.key.toLowerCase() ===
                    primaryActionShortcut.toLowerCase()
            ) {
                if (loadingNext) return;
                event.preventDefault();
                onNext();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [
        active,
        goToNextPosition,
        goToPreviousPosition,
        goToSibling,
        jumpToNode,
        loadingNext,
        navigateTree,
        onNext,
        pendingPromotion,
        primaryActionShortcut,
        selectPanel,
        threatFen,
        threatMode,
        tree.cursorId,
        tree.decisionNodeId,
    ]);

    const playMove = useCallback(
        (from: Square, to: Square, promotion?: PromotionPiece): boolean => {
            if (!active || !draftReady) return false;
            try {
                const chess = new Chess(cursorFen);
                const move = chess.move({ from, to, promotion });
                if (!move) return false;
                const next = playTrainingAnalysisMove(
                    tree,
                    moveToUci(move)
                );
                if (next === tree) return false;
                setTree(next);
                setDraftStatus('saving');
                setSelectedSquare(null);
                setPendingPromotion(null);
                setThreatCursorId(null);
                return true;
            } catch {
                return false;
            }
        },
        [active, cursorFen, draftReady, tree]
    );

    const playOrChoosePromotion = useCallback(
        (from: Square, to: Square): boolean => {
            if (!active || !draftReady) return false;
            try {
                const chess = new Chess(cursorFen);
                const choices = Array.from(
                    new Set(
                        chess
                            .moves({
                                square: from,
                                verbose: true,
                            })
                            .filter((move) => move.to === to && move.promotion)
                            .map((move) => move.promotion as PromotionPiece)
                    )
                );
                if (choices.length > 0) {
                    setPendingPromotion({ from, to, choices });
                    return true;
                }
            } catch {
                return false;
            }
            return playMove(from, to);
        },
        [active, cursorFen, draftReady, playMove]
    );

    const selectSquare = useCallback(
        (square: Square) => {
            if (!active || !draftReady) return;
            try {
                const chess = new Chess(cursorFen);
                const piece = chess.get(square);
                if (piece?.color === chess.turn()) {
                    setSelectedSquare((current) =>
                        current === square ? null : square
                    );
                } else {
                    setSelectedSquare(null);
                }
            } catch {
                setSelectedSquare(null);
            }
        },
        [active, cursorFen, draftReady]
    );

    const handleAnalysisSquareTap = useCallback(
        (target: Square) => {
            if (!active || !draftReady) return;
            if (selectedSquare && legalTargets.has(target)) {
                playOrChoosePromotion(selectedSquare, target);
                return;
            }
            if (selectedSquare === target) {
                setSelectedSquare(null);
                return;
            }
            selectSquare(target);
        },
        [
            active,
            draftReady,
            legalTargets,
            playOrChoosePromotion,
            selectSquare,
            selectedSquare,
        ]
    );
    const reliableAnalysisTouch = useReliableBoardTouch({
        enabled: active && draftReady,
        onTap: handleAnalysisSquareTap,
    });

    const evaluationText = formatEngineScoreForWhite(
        selectedLine?.score ?? null,
        engineFen
    );
    const wdlText = formatEngineWdlForWhite(
        selectedLine?.wdl,
        engineFen
    );
    const whiteScore = whiteExpectedScore({
        score: selectedLine?.score ?? null,
        wdl: selectedLine?.wdl,
        fen: engineFen,
    });
    const engineError =
        (engineClient ? null : engineRequestError) ?? liveAnalysis.error;
    const engineStatus = engineError
        ? 'Engine unavailable'
        : !engineClient
          ? analysisEnabled
              ? 'Engine loading…'
              : 'Engine off'
          : !analysisEnabled
            ? 'Engine paused'
            : liveAnalysis.running
              ? `${threatMode ? 'Finding threats' : 'Analyzing'}${typeof liveAnalysis.depth === 'number' ? ` · depth ${liveAnalysis.depth}` : ''}`
              : currentUpdate
                ? `${threatMode ? 'Threat scan' : 'Analysis'} complete${typeof liveAnalysis.depth === 'number' ? ` · depth ${liveAnalysis.depth}` : ''}`
                : 'Engine starting…';

    if (!active) return null;

    return (
        <div className="space-y-4" aria-label="Position analysis">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2
                        ref={headingRef}
                        tabIndex={-1}
                        className="text-xl font-semibold outline-none"
                    >
                        {heading}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {description}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        type="button"
                        size="sm"
                        variant={threatMode ? 'destructive' : 'outline'}
                        disabled={!draftReady || threatFen === null}
                        onClick={() => {
                            const activateThreats = !threatMode;
                            setThreatCursorId(
                                activateThreats ? tree.cursorId : null
                            );
                            if (activateThreats) selectPanel('engine');
                        }}
                        aria-pressed={threatMode}
                        title={
                            threatFen === null
                                ? 'Threat mode is unavailable while the side to move is in check or the game is over.'
                                : 'Show what the opponent threatens if you pass (X)'
                        }
                    >
                        <ShieldAlert
                            className="mr-2 h-4 w-4"
                            aria-hidden="true"
                        />
                        Threats
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={onFlip}
                        aria-pressed={flipped}
                    >
                        <FlipHorizontal2
                            className="mr-2 h-4 w-4"
                            aria-hidden="true"
                        />
                        Flip
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-[minmax(0,560px)_minmax(300px,1fr)]">
                <div className="min-w-0">
                    <div
                        className="touch-none rounded-xl border p-1 shadow-sm transition-colors duration-200 motion-reduce:transition-none sm:p-2"
                        role="group"
                        aria-label="Interactive analysis board"
                        aria-busy={!draftReady}
                        data-analysis-position-context={positionContext}
                        data-analysis-selected-square={
                            selectedSquare ?? undefined
                        }
                        style={trainingAnalysisFrameStyle(positionContext)}
                        {...reliableAnalysisTouch}
                    >
                        <AnalysisPositionContextBar
                            context={positionContext}
                            showBackToDecision={
                                tree.cursorId !== tree.decisionNodeId
                            }
                            onBackToDecision={() =>
                                jumpToNode(tree.decisionNodeId)
                            }
                        />
                        <Chessboard
                            options={{
                                position: cursorFen,
                                lightSquareStyle: {
                                    backgroundColor:
                                        'hsl(var(--board-light))',
                                },
                                darkSquareStyle: {
                                    backgroundColor:
                                        'hsl(var(--board-dark))',
                                },
                                boardOrientation:
                                    (resolvedSeed.sideToMove === 'w') !== flipped
                                        ? 'white'
                                        : 'black',
                                allowDragging: active && draftReady,
                                dragActivationDistance: 12,
                                allowDrawingArrows: false,
                                arrows:
                                    activePanel === 'engine' ? arrows : [],
                                squareStyles,
                                canDragPiece: ({ square }) => {
                                    if (!active || !draftReady || !square) {
                                        return false;
                                    }
                                    try {
                                        const chess = new Chess(cursorFen);
                                        return (
                                            chess.get(square as Square)
                                                ?.color === chess.turn()
                                        );
                                    } catch {
                                        return false;
                                    }
                                },
                                onSquareClick: ({ square }) => {
                                    if (square) {
                                        handleAnalysisSquareTap(
                                            square as Square
                                        );
                                    }
                                },
                                onPieceDrop: ({
                                    sourceSquare,
                                    targetSquare,
                                }) => {
                                    setSelectedSquare(null);
                                    if (!targetSquare || !draftReady) {
                                        return false;
                                    }
                                    return playOrChoosePromotion(
                                        sourceSquare as Square,
                                        targetSquare as Square
                                    );
                                },
                            }}
                        />
                    </div>

                    <div
                        className="mt-3 grid grid-cols-[repeat(6,44px)] items-center justify-center gap-1 sm:grid-cols-[repeat(6,40px)_minmax(0,1fr)]"
                        role="group"
                        aria-label="Analysis navigation"
                    >
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 sm:h-10 sm:w-10"
                            disabled={tree.cursorId === tree.rootId}
                            onClick={() =>
                                navigateTree(firstTrainingAnalysisNode)
                            }
                            aria-label="First move"
                        >
                            <ChevronsLeft className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 sm:h-10 sm:w-10"
                            disabled={!cursorNode.parentId}
                            onClick={goToPreviousPosition}
                            aria-label="Previous move"
                        >
                            <ChevronLeft className="h-5 w-5" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 sm:h-10 sm:w-10"
                            disabled={siblingCount < 2}
                            onClick={() => goToSibling(-1)}
                            aria-label="Previous variation"
                        >
                            <ChevronUp className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 sm:h-10 sm:w-10"
                            disabled={siblingCount < 2}
                            onClick={() => goToSibling(1)}
                            aria-label="Next variation"
                        >
                            <ChevronDown className="h-4 w-4" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 sm:h-10 sm:w-10"
                            disabled={!hasNextNode}
                            onClick={goToNextPosition}
                            aria-label="Next move"
                        >
                            <ChevronRight className="h-5 w-5" />
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 sm:h-10 sm:w-10"
                            disabled={atLineEnd}
                            onClick={() =>
                                navigateTree(lastTrainingAnalysisNode)
                            }
                            aria-label="Last move"
                        >
                            <ChevronsRight className="h-4 w-4" />
                        </Button>
                        <div className="col-span-6 min-w-0 pt-1 text-center text-sm sm:col-span-1 sm:pl-2 sm:pt-0 sm:text-left">
                            <div className="truncate font-medium">
                                {cursorDescription(tree)}
                            </div>
                            <div className="truncate text-xs text-muted-foreground">
                                {cursorFen.split(' ')[1] === 'b'
                                    ? 'Black to move'
                                    : 'White to move'}
                                {' · '}
                                {Math.max(0, path.length - 1)} plies in path
                            </div>
                        </div>
                    </div>
                    <div
                        className="mt-2 flex gap-2 overflow-x-auto pb-1"
                        role="group"
                        aria-label="Key analysis positions"
                    >
                        {anchors.map((anchor) => (
                            <Button
                                key={anchor.id}
                                type="button"
                                size="sm"
                                variant={
                                    tree.cursorId === anchor.id
                                        ? 'secondary'
                                        : 'outline'
                                }
                                className="shrink-0"
                                onClick={() => jumpToNode(anchor.id)}
                            >
                                {anchor.label}
                            </Button>
                        ))}
                    </div>
                </div>

                <div className="min-w-0 space-y-4">
                    <Tabs
                        value={activePanel}
                        onValueChange={(value) =>
                            selectPanel(value as AnalysisPanel)
                        }
                        data-analysis-panel={activePanel}
                    >
                        <TabsList
                            className={cn(
                                'grid w-full',
                                children ? 'grid-cols-3' : 'grid-cols-2'
                            )}
                            aria-label="Analysis panels"
                        >
                            {children ? (
                                <TabsTrigger value="review">
                                    Review
                                </TabsTrigger>
                            ) : null}
                            <TabsTrigger value="moves">Moves</TabsTrigger>
                            <TabsTrigger value="engine">Engine</TabsTrigger>
                        </TabsList>

                        {children ? (
                            <TabsContent value="review" className="mt-3">
                                <div data-analysis-panel-content="review">
                                    {children}
                                </div>
                            </TabsContent>
                        ) : null}

                        <TabsContent value="moves" className="mt-3">
                            <Card data-analysis-panel-content="moves">
                                <CardHeader className="pb-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <CardTitle className="text-base">
                                            Move tree
                                        </CardTitle>
                                        <span
                                            className="text-xs text-muted-foreground"
                                            role="status"
                                            aria-live="polite"
                                        >
                                            {draftStatusLabel(draftStatus)}
                                        </span>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-3">
                                    <TrainingAnalysisMoveTree
                                        tree={tree}
                                        onJump={jumpToNode}
                                        onPromote={promoteVariation}
                                        onDelete={(nodeId) =>
                                            navigateTree((current) =>
                                                deleteTrainingAnalysisVariation(
                                                    current,
                                                    nodeId
                                                )
                                            )
                                        }
                                    />
                                    <div className="flex flex-wrap items-center justify-end gap-2">
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => setClearDialogOpen(true)}
                                            disabled={!hasUserVariations}
                                        >
                                            <RotateCcw
                                                className="mr-2 h-4 w-4"
                                                aria-hidden="true"
                                            />
                                            Clear analysis
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        </TabsContent>

                        <TabsContent value="engine" className="mt-3">
                            <Card data-analysis-panel-content="engine">
                                <CardHeader className="pb-3">
                                    <div className="flex items-center justify-between gap-3">
                                        <CardTitle className="text-base">
                                            {threatMode
                                                ? 'Opponent threats'
                                                : 'Live engine'}
                                        </CardTitle>
                                        <span
                                            className="text-xs text-muted-foreground"
                                            role="status"
                                            aria-live="polite"
                                        >
                                            {engineStatus}
                                        </span>
                                    </div>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    {threatMode ? (
                                        <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm">
                                            <div className="font-medium text-red-700 dark:text-red-300">
                                                If you did nothing
                                            </div>
                                            <p className="mt-1 text-xs text-muted-foreground">
                                                Stockfish is giving the opponent an
                                                immediate extra move. Red arrows show
                                                their strongest threats; the board and
                                                move tree stay unchanged.
                                            </p>
                                        </div>
                                    ) : null}

                                    <div>
                                        <div className="flex items-end justify-between gap-3">
                                            <div>
                                                <div className="text-xs text-muted-foreground">
                                                    White evaluation
                                                </div>
                                                <div className="font-mono text-2xl font-semibold">
                                                    {evaluationText}
                                                </div>
                                            </div>
                                            {wdlText ? (
                                                <div className="text-right text-xs text-muted-foreground">
                                                    {wdlText}
                                                </div>
                                            ) : null}
                                        </div>
                                        <div
                                            className="mt-2 flex h-3 overflow-hidden rounded-full border bg-zinc-900"
                                            role="img"
                                            aria-label={`White expected score ${Math.round(whiteScore * 100)} percent`}
                                        >
                                            <div
                                                className="h-full bg-zinc-100 transition-[width] dark:bg-zinc-200"
                                                style={{
                                                    width: `${Math.round(whiteScore * 100)}%`,
                                                }}
                                            />
                                        </div>
                                        <p className="mt-1 text-[11px] text-muted-foreground">
                                            + favors White · − favors Black
                                        </p>
                                    </div>

                                    {engineError ? (
                                        <div
                                            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
                                            role="alert"
                                        >
                                            <p>{engineError}</p>
                                            {!engineClient ? (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    className="mt-2"
                                                    onClick={() => {
                                                        engineRequestedRef.current = false;
                                                        requestEngine();
                                                    }}
                                                >
                                                    Retry engine
                                                </Button>
                                            ) : null}
                                        </div>
                                    ) : analysisEnabled &&
                                      engineClient &&
                                      lines.length === 0 ? (
                                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                            {threatMode
                                                ? 'Calculating opponent threats…'
                                                : 'Calculating candidate lines…'}
                                        </div>
                                    ) : null}

                                    <div className="space-y-2">
                                        {lines.map((line, index) => {
                                            const san = uciLineToSan(
                                                engineFen,
                                                line.pvUci,
                                                8
                                            );
                                            const lineWdl = formatEngineWdlForWhite(
                                                line.wdl,
                                                engineFen
                                            );
                                            const selected =
                                                line.multipv ===
                                                (selectedLine?.multipv ?? 1);
                                            const colors = threatMode
                                                ? THREAT_LINE_COLORS
                                                : LINE_COLORS;
                                            return (
                                                <button
                                                    key={line.multipv}
                                                    type="button"
                                                    className={cn(
                                                        'w-full rounded-lg border p-3 text-left transition-colors',
                                                        selected
                                                            ? threatMode
                                                                ? 'border-red-500 bg-red-500/5'
                                                                : 'border-primary bg-primary/5'
                                                            : 'hover:bg-muted/50'
                                                    )}
                                                    onClick={() =>
                                                        setSelectedMultiPv(
                                                            line.multipv
                                                        )
                                                    }
                                                    aria-pressed={selected}
                                                >
                                                    <span className="flex items-start justify-between gap-3">
                                                        <span className="flex min-w-0 items-start gap-2">
                                                            <span
                                                                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
                                                                style={{
                                                                    backgroundColor:
                                                                        colors[index] ??
                                                                        colors[0],
                                                                }}
                                                                aria-hidden="true"
                                                            />
                                                            <span className="min-w-0">
                                                                <span className="block font-mono text-sm">
                                                                    {san.length > 0
                                                                        ? san.join(' ')
                                                                        : 'Waiting for a legal line…'}
                                                                </span>
                                                                {lineWdl ? (
                                                                    <span className="mt-1 block text-xs text-muted-foreground">
                                                                        {lineWdl}
                                                                    </span>
                                                                ) : null}
                                                            </span>
                                                        </span>
                                                        <span className="shrink-0 font-mono text-sm font-medium">
                                                            {formatEngineScoreForWhite(
                                                                line.score,
                                                                engineFen
                                                            )}
                                                        </span>
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>

                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <Select
                                            value={String(multiPv)}
                                            onValueChange={(value) => {
                                                setMultiPv(
                                                    Math.max(
                                                        1,
                                                        Math.min(
                                                            5,
                                                            Math.trunc(
                                                                Number(value) || 1
                                                            )
                                                        )
                                                    )
                                                );
                                                setSelectedMultiPv(1);
                                            }}
                                        >
                                            <SelectTrigger
                                                className="w-[150px]"
                                                aria-label="Engine lines"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {[1, 2, 3, 4, 5].map((count) => (
                                                    <SelectItem
                                                        key={count}
                                                        value={String(count)}
                                                    >
                                                        {count}{' '}
                                                        {count === 1 ? 'line' : 'lines'}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            disabled={
                                                !engineClient && !engineRequestError
                                            }
                                            onClick={() => {
                                                if (liveAnalysis.running) {
                                                    liveAnalysis.stop();
                                                    setAnalysisEnabled(false);
                                                    return;
                                                }
                                                if (!engineClient) {
                                                    requestEngine();
                                                    return;
                                                }
                                                if (analysisEnabled) {
                                                    liveAnalysis.start();
                                                } else {
                                                    setAnalysisEnabled(true);
                                                }
                                            }}
                                        >
                                            {liveAnalysis.running ? (
                                                <>
                                                    <Pause className="mr-2 h-4 w-4" />
                                                    Pause
                                                </>
                                            ) : (
                                                <>
                                                    <Play className="mr-2 h-4 w-4" />
                                                    {analysisEnabled && currentUpdate
                                                        ? 'Run again'
                                                        : 'Resume'}
                                                </>
                                            )}
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        </TabsContent>
                    </Tabs>

                    <Card>
                        <CardContent className="space-y-3 pt-6">
                            <Button
                                type="button"
                                className="w-full"
                                disabled={loadingNext}
                                onClick={onNext}
                            >
                                {loadingNext
                                    ? primaryActionLoadingLabel
                                    : primaryActionLabel}
                                {!loadingNext ? (
                                    <ChevronRight className="ml-2 h-4 w-4" />
                                ) : null}
                            </Button>
                            <p className="text-center text-xs text-muted-foreground">
                                ←/→ moves · ↑/↓ variations · Home/End line · R
                                decision · X threats
                                {primaryActionShortcut
                                    ? ` · ${primaryActionShortcut.toUpperCase()} ${primaryActionHint}`
                                    : ''}
                            </p>
                        </CardContent>
                    </Card>
                </div>
            </div>

            <ModalDialog
                open={active && pendingPromotion !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingPromotion(null);
                }}
                title="Promote pawn to"
                description="Choose the piece for this analysis move."
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
                                aria-label={`Promote to ${label}`}
                                onClick={() => {
                                    if (!pendingPromotion) return;
                                    playMove(
                                        pendingPromotion.from,
                                        pendingPromotion.to,
                                        piece
                                    );
                                }}
                            >
                                {label}
                            </Button>
                        ))}
                </div>
            </ModalDialog>

            <ActionConfirmDialog
                open={clearDialogOpen}
                onOpenChange={setClearDialogOpen}
                title="Clear your analysis?"
                description={
                    persistDraft
                        ? 'This removes every variation you added for this position from this device. The source game, your move, and the best line remain.'
                        : 'This removes every variation you added from this analysis session. The source game, your move, and the best line remain.'
                }
                confirmLabel="Clear analysis"
                variant="destructive"
                onConfirm={resetWorkspace}
            />
        </div>
    );
}
