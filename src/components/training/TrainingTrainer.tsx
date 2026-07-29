'use client';

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Chess, type Square } from 'chess.js';
import {
    ChevronRight,
    FlipHorizontal2,
    Loader2,
    RotateCcw,
    WifiOff,
} from 'lucide-react';
import { Chessboard } from 'react-chessboard';

import {
    filtersForReviewAgain,
    hasEffectivePracticeFocus,
    TrainingFocusControls,
} from '@/components/training/TrainingFocusControls';
import { ModalDialog } from '@/components/ui/ModalDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { usePracticeFeed } from '@/lib/hooks/usePracticeFeed';
import type { TrainingReviewDto } from '@/lib/training/api';
import {
    formatOutcomeDifference,
    formatScoreForTrainingSide,
    formatSignedOutcomeDifference,
    lessonLabel,
    moveLabel,
    moveLineLabels,
    sourceLabel,
    themeLabel,
} from '@/lib/training/presentation';
import {
    feedbackForTrainingState,
    type TrainerAttemptPhase,
} from '@/lib/training/trainerState';
import { cn } from '@/lib/utils';

type PromotionPiece = 'q' | 'r' | 'b' | 'n';

type PendingPromotion = {
    from: Square;
    to: Square;
    choices: PromotionPiece[];
};

function gradeLabel(grade: string): string {
    return grade
        .toLowerCase()
        .split('_')
        .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
        .join(' ');
}

function ReviewPanel({
    review,
    rootFen,
    grade,
}: {
    review: TrainingReviewDto;
    rootFen: string;
    grade: string | null;
}) {
    const playedAt = new Date(review.source.playedAt);
    const sourceDate = Number.isNaN(playedAt.getTime())
        ? review.source.playedAt
        : playedAt.toLocaleDateString();
    const acceptedAlternatives = Array.from(
        new Set([
            ...review.acceptedMovesUci,
            ...(grade === 'BEST' || grade === 'GOOD'
                ? [review.submittedMoveUci]
                : []),
        ])
    ).filter(
        (move): move is string =>
            Boolean(move) &&
            move?.trim().toLowerCase() !==
                review.bestMoveUci.trim().toLowerCase()
    );
    const bestLine = moveLineLabels(rootFen, review.bestLineUci);

    return (
        <Card role="region" aria-label="Position review">
            <CardHeader className="pb-3">
                <CardTitle className="text-base">Position review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
                <dl className="grid gap-3 sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Your move</dt>
                        <dd className="mt-1 font-medium">
                            {moveLabel(rootFen, review.submittedMoveUci)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Best move</dt>
                        <dd className="mt-1 font-medium">
                            {moveLabel(rootFen, review.bestMoveUci)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Move played in the game
                        </dt>
                        <dd className="mt-1 font-medium">
                            {moveLabel(rootFen, review.originalMoveUci)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Position before the decision
                        </dt>
                        <dd className="mt-1 font-medium">
                            {formatScoreForTrainingSide(
                                review.scoreAtStart,
                                review.trainingSide
                            )}
                        </dd>
                    </div>
                </dl>

                {acceptedAlternatives.length > 0 ||
                !review.acceptedMovesComplete ? (
                    <div>
                        <div className="text-muted-foreground">
                            {review.acceptedMovesComplete
                                ? 'Other good moves'
                                : 'Known good alternatives'}
                        </div>
                        {acceptedAlternatives.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                                {acceptedAlternatives.map((move) => (
                                    <Badge
                                        key={move}
                                        variant="secondary"
                                    >
                                        {moveLabel(rootFen, move)}
                                    </Badge>
                                ))}
                            </div>
                        ) : null}
                        {!review.acceptedMovesComplete ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                                This is not an exhaustive list. Other legal
                                moves are evaluated when you play them.
                            </p>
                        ) : null}
                    </div>
                ) : null}

                {bestLine.length > 0 ? (
                    <div>
                        <div className="text-muted-foreground">
                            Best continuation
                        </div>
                        <p className="mt-1 font-medium">
                            {bestLine.join(' ')}
                        </p>
                    </div>
                ) : null}

                {review.comparison ? (
                    <dl className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
                        <div>
                            <dt className="text-muted-foreground">
                                Distance from the best move
                            </dt>
                            <dd className="mt-1 font-medium">
                                {formatOutcomeDifference({
                                    winChance:
                                        review.comparison
                                            .bestGapWinChance,
                                    cp: review.comparison.bestGapCp,
                                })}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground">
                                Change versus your game
                            </dt>
                            <dd className="mt-1 font-medium">
                                {formatSignedOutcomeDifference({
                                    winChance:
                                        review.comparison
                                            .recoveredWinChance,
                                    cp: review.comparison.recoveredCp,
                                })}
                            </dd>
                        </div>
                    </dl>
                ) : null}

                <div className="border-t pt-4">
                    <div className="mt-2 flex flex-wrap gap-2">
                        {review.sourceKinds.map((value) => (
                            <Badge
                                key={`source:${value}`}
                                variant="secondary"
                            >
                                {sourceLabel(value)}
                            </Badge>
                        ))}
                        {review.lessonKinds.map((value) => (
                            <Badge
                                key={`lesson:${value}`}
                                variant="outline"
                            >
                                {lessonLabel(value)}
                            </Badge>
                        ))}
                        {review.themes.map((value) => (
                            <Badge
                                key={`theme:${value}`}
                                variant="outline"
                            >
                                {themeLabel(value)}
                            </Badge>
                        ))}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                        {review.source.provider === 'lichess'
                            ? 'Lichess'
                            : 'Chess.com'}{' '}
                        game · {sourceDate} · move{' '}
                        {Math.floor(review.source.decisionPly / 2) + 1}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}

function feedbackClass(
    phase: TrainerAttemptPhase,
    grade?: Parameters<typeof feedbackForTrainingState>[0]['grade']
) {
    const feedback = feedbackForTrainingState({ phase, grade });
    if (feedback.tone === 'positive') {
        return 'border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200';
    }
    if (feedback.tone === 'negative') {
        return 'border-red-500/30 bg-red-500/5 text-red-800 dark:text-red-200';
    }
    if (feedback.tone === 'warning') {
        return 'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200';
    }
    return 'bg-card text-muted-foreground';
}

function unresolvedExplanation(
    reason:
        | 'ENGINE_UNAVAILABLE'
        | 'UNSTABLE_EVIDENCE'
        | 'MISSING_OUTCOME_EVIDENCE'
): string {
    if (reason === 'UNSTABLE_EVIDENCE') {
        return 'Local analysis was not stable enough to judge this alternative fairly.';
    }
    if (reason === 'MISSING_OUTCOME_EVIDENCE') {
        return 'This device needs stronger outcome evidence before it can judge the alternative.';
    }
    return 'Local Stockfish is temporarily unavailable on this device.';
}

export function TrainingTrainer({
    initialMomentId,
    ownerId,
    entry,
    compact = false,
}: {
    initialMomentId?: string;
    ownerId?: string;
    entry?: 'progress';
    compact?: boolean;
}) {
    const training = usePracticeFeed(
        initialMomentId,
        ownerId,
        entry
    );
    const [flipped, setFlipped] = useState(false);
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [pendingPromotion, setPendingPromotion] =
        useState<PendingPromotion | null>(null);
    const [revealOpen, setRevealOpen] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardMoveError, setKeyboardMoveError] = useState<
        string | null
    >(null);
    const promptHeadingRef = useRef<HTMLHeadingElement>(null);
    const feedbackRef = useRef<HTMLDivElement>(null);
    const previousPromptIdRef = useRef<string | null>(null);
    const previousPhaseRef =
        useRef<TrainerAttemptPhase>('READY');

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    const legalTargets = useMemo(() => {
        if (!selectedSquare || !training.positionFen || !training.canMove) {
            return new Set<Square>();
        }
        try {
            const chess = new Chess(training.positionFen);
            return new Set(
                chess
                    .moves({ square: selectedSquare, verbose: true })
                    .map((move) => move.to as Square)
            );
        } catch {
            return new Set<Square>();
        }
    }, [selectedSquare, training.canMove, training.positionFen]);

    const squareStyles = useMemo(() => {
        const styles: Record<string, React.CSSProperties> = {};
        if (selectedSquare) {
            styles[selectedSquare] = {
                backgroundColor: 'rgba(59, 130, 246, 0.32)',
            };
        }
        for (const square of legalTargets) {
            styles[square] = {
                background:
                    'radial-gradient(circle, rgba(59,130,246,0.52) 0 18%, transparent 20%)',
            };
        }
        return styles;
    }, [legalTargets, selectedSquare]);

    const reviewArrows = useMemo(() => {
        const bestMove = training.review?.bestMoveUci
            .trim()
            .toLowerCase();
        if (!bestMove || bestMove.length < 4) return [];
        return [
            {
                startSquare: bestMove.slice(0, 2) as Square,
                endSquare: bestMove.slice(2, 4) as Square,
                color: 'rgba(16, 185, 129, 0.82)',
            },
        ];
    }, [training.review?.bestMoveUci]);

    const selectSquare = useCallback(
        (square: Square) => {
            if (!training.positionFen || !training.canMove) return;
            try {
                const chess = new Chess(training.positionFen);
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
        [training.canMove, training.positionFen]
    );

    const submitLegalMove = useCallback(
        (from: Square, to: Square, promotion?: PromotionPiece): boolean => {
            if (!training.positionFen || !training.canMove) return false;
            try {
                const chess = new Chess(training.positionFen);
                const move = chess.move({ from, to, promotion });
                if (!move) return false;
                const moveUci = `${move.from}${move.to}${move.promotion ?? ''}`;
                setSelectedSquare(null);
                setPendingPromotion(null);
                void training.submitMove({
                    moveUci,
                    fenAfterMove: chess.fen(),
                });
                return true;
            } catch {
                return false;
            }
        },
        [training]
    );

    const playOrChoosePromotion = useCallback(
        (from: Square, to: Square): boolean => {
            if (!training.positionFen || !training.canMove) return false;
            try {
                const chess = new Chess(training.positionFen);
                const choices = Array.from(
                    new Set(
                        chess
                            .moves({ square: from, verbose: true })
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
            return submitLegalMove(from, to);
        },
        [submitLegalMove, training.canMove, training.positionFen]
    );

    const submitKeyboardMove = useCallback(() => {
        if (
            !training.positionFen ||
            !training.canMove ||
            !keyboardMove.trim()
        ) {
            return;
        }
        try {
            const chess = new Chess(training.positionFen);
            const notation = keyboardMove.trim();
            const normalized = notation.toLowerCase();
            const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(
                normalized
            )
                ? chess.move({
                      from: normalized.slice(0, 2),
                      to: normalized.slice(2, 4),
                      promotion:
                          normalized.slice(4, 5) || undefined,
                  })
                : chess.move(notation);
            if (!move) throw new Error('Illegal move');
            setKeyboardMove('');
            setKeyboardMoveError(null);
            setSelectedSquare(null);
            setPendingPromotion(null);
            void training.submitMove({
                moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
                fenAfterMove: chess.fen(),
            });
        } catch {
            setKeyboardMoveError(
                'Enter a legal move such as Nf3, O-O, or g1f3.'
            );
        }
    }, [keyboardMove, training]);

    const promptText = training.prompt
        ? `${training.prompt.sideToMove === 'w' ? 'White' : 'Black'} to move — find the best move`
        : null;
    const feedback = feedbackForTrainingState({
        phase: training.phase,
        grade: training.grade,
    });
    const terminal =
        training.phase === 'GRADED' ||
        training.phase === 'REVEALED' ||
        training.phase === 'UNRESOLVED';
    const boardFen = training.review
        ? training.prompt?.fen
        : training.positionFen;
    const hasCustomFocus = hasEffectivePracticeFocus(
        training.practiceFilters,
        training.appliedPracticeFilters
    );
    const isCaughtUp =
        training.feedExhausted && training.feedHadPositions;
    const focusControls =
        !compact && !initialMomentId ? (
            <TrainingFocusControls
                key={JSON.stringify(training.practiceFilters)}
                disabled={
                    training.loading ||
                    training.phase === 'SUBMITTING' ||
                    training.phase === 'AWAITING_MOVE'
                }
                filters={training.practiceFilters}
                onApply={(filters) => {
                    setSelectedSquare(null);
                    setPendingPromotion(null);
                    setKeyboardMove('');
                    setKeyboardMoveError(null);
                    training.resetFeed(filters);
                }}
            />
        ) : null;

    useEffect(() => {
        const promptId = training.prompt?.id ?? null;
        if (
            promptId &&
            previousPromptIdRef.current &&
            promptId !== previousPromptIdRef.current
        ) {
            promptHeadingRef.current?.focus();
        }
        previousPromptIdRef.current = promptId;
        setKeyboardMove('');
        setKeyboardMoveError(null);
    }, [training.prompt?.id]);

    useEffect(() => {
        const wasTerminal =
            previousPhaseRef.current === 'GRADED' ||
            previousPhaseRef.current === 'REVEALED';
        const isReviewed =
            training.phase === 'GRADED' ||
            training.phase === 'REVEALED';
        if (isReviewed && !wasTerminal) {
            feedbackRef.current?.focus();
        }
        previousPhaseRef.current = training.phase;
    }, [training.phase]);

    if (training.loading && !training.prompt) {
        return (
            <div
                className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
            >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                Preparing your positions…
            </div>
        );
    }

    if (training.loadError && !training.prompt) {
        return (
            <Card>
                <CardContent className="py-8 text-center">
                    <p role="alert" className="text-sm text-destructive">
                        {training.loadError}
                    </p>
                    <Button
                        className="mt-4"
                        type="button"
                        variant="outline"
                        onClick={() => void training.retryFeed()}
                    >
                        <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />
                        Try again
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (!training.prompt || !training.positionFen) {
        return (
            <div className="space-y-4">
                {focusControls}
                <Card>
                    <CardContent className="py-10 text-center">
                        <h2 className="font-medium">
                            {isCaughtUp
                                ? 'You’re caught up'
                                : hasCustomFocus
                                  ? 'No positions match this focus'
                                  : 'No practice positions yet'}
                        </h2>
                        <p className="mt-2 text-sm text-muted-foreground">
                            {isCaughtUp
                                ? 'You’ve practised every position matching this focus.'
                                : hasCustomFocus
                                  ? 'Adjust the position focus above to practise a broader set of decisions.'
                                : 'Analyze more games to find personal practice positions.'}
                        </p>
                        {isCaughtUp && !initialMomentId ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="mt-4"
                                onClick={() =>
                                    training.resetFeed(
                                        filtersForReviewAgain(
                                            training.practiceFilters
                                        )
                                    )
                                }
                            >
                                Review these positions again
                            </Button>
                        ) : null}
                    </CardContent>
                </Card>
            </div>
        );
    }

    return (
        <section
            className="space-y-4"
            aria-label="Personal chess practice"
        >
            {focusControls}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h2
                        ref={promptHeadingRef}
                        tabIndex={-1}
                        className={cn(
                            'font-semibold outline-none',
                            compact ? 'text-lg' : 'text-xl'
                        )}
                    >
                        {promptText}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        Choose the move you would play in a real game.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {!training.online ? (
                        <Badge variant="outline">
                            <WifiOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                            Offline
                        </Badge>
                    ) : null}
                    {training.queuedCount > 0 ? (
                        <Badge variant="secondary">
                            {training.queuedCount}{' '}
                            {training.queuedCount === 1 ? 'result' : 'results'} waiting to sync
                        </Badge>
                    ) : null}
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setFlipped((value) => !value)}
                        aria-label="Flip board"
                    >
                        <FlipHorizontal2 className="mr-2 h-4 w-4" aria-hidden="true" />
                        Flip
                    </Button>
                </div>
            </div>

            <div
                className={cn(
                    'grid gap-4',
                    compact
                        ? 'xl:grid-cols-[minmax(0,560px)_minmax(260px,1fr)]'
                        : 'lg:grid-cols-[minmax(0,560px)_minmax(280px,1fr)]'
                )}
            >
                <div className="min-w-0">
                    <div
                        className="rounded-xl border bg-card p-1 shadow-sm sm:p-2"
                        role="group"
                        aria-label={promptText ?? 'Chess practice board'}
                    >
                        <Chessboard
                            options={{
                                position:
                                    boardFen ?? training.positionFen,
                                boardOrientation:
                                    (training.prompt.sideToMove === 'w') !==
                                    flipped
                                        ? 'white'
                                        : 'black',
                                allowDragging: training.canMove,
                                allowDrawingArrows: false,
                                arrows: reviewArrows,
                                showAnimations: !reducedMotion,
                                animationDurationInMs: reducedMotion ? 0 : 180,
                                squareStyles,
                                canDragPiece: ({ square }) => {
                                    if (
                                        !training.canMove ||
                                        !square ||
                                        !training.positionFen
                                    ) {
                                        return false;
                                    }
                                    try {
                                        const chess = new Chess(
                                            training.positionFen
                                        );
                                        const piece = chess.get(
                                            square as Square
                                        );
                                        return Boolean(
                                            piece &&
                                                piece.color === chess.turn()
                                        );
                                    } catch {
                                        return false;
                                    }
                                },
                                onSquareClick: ({ square }) => {
                                    if (!square) return;
                                    const target = square as Square;
                                    if (
                                        selectedSquare &&
                                        legalTargets.has(target)
                                    ) {
                                        playOrChoosePromotion(
                                            selectedSquare,
                                            target
                                        );
                                        return;
                                    }
                                    selectSquare(target);
                                },
                                onPieceDrop: training.canMove
                                    ? ({ sourceSquare, targetSquare }) => {
                                          if (!targetSquare) return false;
                                          return playOrChoosePromotion(
                                              sourceSquare as Square,
                                              targetSquare as Square
                                          );
                                      }
                                    : undefined,
                            }}
                        />
                    </div>

                    <div
                        ref={feedbackRef}
                        tabIndex={-1}
                        className={cn(
                            'mt-3 min-h-11 rounded-lg border px-3 py-2.5 text-sm',
                            feedbackClass(training.phase, training.grade)
                        )}
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                    >
                        <div className="flex items-center gap-2">
                            {training.grade ? (
                                <Badge variant="outline">
                                    {gradeLabel(training.grade)}
                                </Badge>
                            ) : null}
                            <span>{feedback.message}</span>
                        </div>
                    </div>

                    {training.error ? (
                        <div
                            className="mt-2 flex flex-wrap items-center justify-between gap-2"
                            role="alert"
                        >
                            <p className="text-sm text-destructive">
                                {training.error}
                            </p>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void training.retryFeed()}
                            >
                                Reload position
                            </Button>
                        </div>
                    ) : null}
                </div>

                <div className="space-y-4">
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">
                                Your decision
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Every legal move is graded on this device against
                                the position and your original game.
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {training.phase === 'UNRESOLVED' ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11"
                                        onClick={() =>
                                            void training.retryGrading()
                                        }
                                    >
                                        Retry local analysis
                                    </Button>
                                ) : null}
                                {training.queuedCount > 0 &&
                                training.online ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11"
                                        onClick={() =>
                                            void training.flushQueue()
                                        }
                                    >
                                        Sync saved progress
                                    </Button>
                                ) : null}
                                {training.canReveal ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11"
                                        onClick={() => {
                                            setSelectedSquare(null);
                                            setPendingPromotion(null);
                                            setRevealOpen(true);
                                        }}
                                    >
                                        Reveal
                                    </Button>
                                ) : null}
                                {terminal ? (
                                    <Button
                                        type="button"
                                        className="min-h-11"
                                        disabled={training.loading}
                                        onClick={() => void training.next()}
                                    >
                                        {training.loading ? (
                                            <>
                                                <Loader2
                                                    className="mr-2 h-4 w-4 animate-spin"
                                                    aria-hidden="true"
                                                />
                                                Loading next…
                                            </>
                                        ) : (
                                            <>
                                                Next position
                                                <ChevronRight
                                                    className="ml-2 h-4 w-4"
                                                    aria-hidden="true"
                                                />
                                            </>
                                        )}
                                    </Button>
                                ) : null}
                            </div>

                            {training.unresolved ? (
                                <p className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                                    {unresolvedExplanation(
                                        training.unresolved.reason
                                    )}
                                </p>
                            ) : null}

                            {training.loadError && training.prompt ? (
                                <div
                                    className="rounded-md border border-destructive/30 p-3 text-sm"
                                    role="alert"
                                >
                                    <p className="text-destructive">
                                        {training.loadError}
                                    </p>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="mt-2"
                                        disabled={training.loading}
                                        onClick={() =>
                                            void training.next()
                                        }
                                    >
                                        Try next position again
                                    </Button>
                                </div>
                            ) : null}

                            {training.canMove ? (
                                <details className="rounded-lg border px-3 py-2 text-sm">
                                    <summary className="cursor-pointer select-none font-medium">
                                        Enter a move with the keyboard
                                    </summary>
                                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                                        <div className="flex-1">
                                            <label
                                                htmlFor="training-keyboard-move"
                                                className="sr-only"
                                            >
                                                Chess move in SAN or
                                                coordinate notation
                                            </label>
                                            <Input
                                                id="training-keyboard-move"
                                                value={keyboardMove}
                                                placeholder="Nf3 or g1f3"
                                                aria-invalid={
                                                    keyboardMoveError
                                                        ? true
                                                        : undefined
                                                }
                                                aria-describedby={
                                                    keyboardMoveError
                                                        ? 'training-keyboard-move-error'
                                                        : undefined
                                                }
                                                onChange={(event) => {
                                                    setKeyboardMove(
                                                        event.target.value
                                                    );
                                                    setKeyboardMoveError(
                                                        null
                                                    );
                                                }}
                                                onKeyDown={(event) => {
                                                    if (
                                                        event.key ===
                                                        'Enter'
                                                    ) {
                                                        event.preventDefault();
                                                        submitKeyboardMove();
                                                    }
                                                }}
                                            />
                                        </div>
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="min-h-11"
                                            disabled={
                                                !keyboardMove.trim()
                                            }
                                            onClick={submitKeyboardMove}
                                        >
                                            Play move
                                        </Button>
                                    </div>
                                    {keyboardMoveError ? (
                                        <p
                                            id="training-keyboard-move-error"
                                            className="mt-2 text-xs text-destructive"
                                            role="alert"
                                        >
                                            {keyboardMoveError}
                                        </p>
                                    ) : null}
                                </details>
                            ) : null}
                        </CardContent>
                    </Card>

                    {training.review ? (
                        <ReviewPanel
                            review={training.review}
                            rootFen={training.prompt.fen}
                            grade={training.grade}
                        />
                    ) : null}
                </div>
            </div>

            <ModalDialog
                open={pendingPromotion !== null}
                onOpenChange={(open) => {
                    if (!open) setPendingPromotion(null);
                }}
                title="Promote pawn to"
                description="Choose the piece before the move is checked."
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
                                    submitLegalMove(
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

            <ModalDialog
                open={revealOpen}
                onOpenChange={setRevealOpen}
                title="Reveal this position?"
                description="The answer and game context stay hidden until you confirm. This will be recorded as revealed."
            >
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => setRevealOpen(false)}
                    >
                        Keep solving
                    </Button>
                    <Button
                        type="button"
                        onClick={() => {
                            setRevealOpen(false);
                            void training.reveal();
                        }}
                    >
                        Reveal solution
                    </Button>
                </div>
            </ModalDialog>
        </section>
    );
}
