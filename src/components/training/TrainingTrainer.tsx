'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import dynamic from 'next/dynamic';
import {
    ChevronRight,
    FlipHorizontal2,
    Loader2,
    RotateCcw,
    WifiOff,
} from 'lucide-react';

import { PostMoveStory } from '@/components/training/PostMoveStory';
import { PuzzleBoard } from '@/components/training/PuzzleBoard';
import {
    hasEffectivePracticeFocus,
    TrainingFocusControls,
} from '@/components/training/TrainingFocusControls';
import { ModalDialog } from '@/components/ui/ModalDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
    Tabs,
    TabsContent,
    TabsList,
    TabsTrigger,
} from '@/components/ui/tabs';
import { usePracticeFeed } from '@/lib/hooks/usePracticeFeed';
import type { PracticeFeedMode } from '@/lib/training/api';
import { legalMoveFromInput } from '@/lib/training/boardInput';
import { bestMoveReviewArrows } from '@/lib/training/boardPresentation';
import {
    feedbackForTrainingState,
    type TrainerAttemptPhase,
} from '@/lib/training/trainerState';
import { cn } from '@/lib/utils';

type TrainerViewMode = 'solve' | 'analyze';
type RevealIntent = 'solution' | 'analysis' | null;

const TrainingAnalysisWorkspace = dynamic(
    () =>
        import(
            '@/components/training/TrainingAnalysisWorkspace'
        ).then((module) => module.TrainingAnalysisWorkspace),
    {
        ssr: false,
        loading: () => (
            <div
                className="flex min-h-56 items-center justify-center gap-2 text-sm text-muted-foreground"
                role="status"
            >
                <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                />
                Preparing analysis…
            </div>
        ),
    }
);

function gradeLabel(grade: string): string {
    return grade
        .toLowerCase()
        .split('_')
        .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
        .join(' ');
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
    initialMode,
    initialViewMode = 'solve',
    compact = false,
}: {
    initialMomentId?: string;
    ownerId?: string;
    entry?: 'progress';
    initialMode?: PracticeFeedMode;
    initialViewMode?: TrainerViewMode;
    compact?: boolean;
}) {
    const training = usePracticeFeed(
        initialMomentId,
        ownerId,
        entry,
        initialMode
    );
    const nextPosition = training.next;
    const [flipped, setFlipped] = useState(false);
    const [viewMode, setViewMode] =
        useState<TrainerViewMode>('solve');
    const [revealIntent, setRevealIntent] =
        useState<RevealIntent>(() =>
            initialViewMode === 'analyze' ? 'analysis' : null
        );
    const [analysisSession, setAnalysisSession] = useState<{
        promptId: string;
        initialFen: string;
    } | null>(null);
    const [reducedMotion, setReducedMotion] = useState(false);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardMoveError, setKeyboardMoveError] = useState<
        string | null
    >(null);
    const [bestMovePromptId, setBestMovePromptId] = useState<string | null>(
        null
    );
    const showBestMove = bestMovePromptId === training.prompt?.id;
    const setShowBestMove = (shown: boolean) => {
        setBestMovePromptId(shown ? (training.prompt?.id ?? null) : null);
    };
    const promptHeadingRef = useRef<HTMLHeadingElement>(null);
    const feedbackRef = useRef<HTMLDivElement>(null);
    const previousPromptIdRef = useRef<string | null>(null);
    const previousPhaseRef =
        useRef<TrainerAttemptPhase>('READY');

    const replaceViewInUrl = useCallback(
        (mode: TrainerViewMode) => {
            if (typeof window === 'undefined') return;
            const url = new URL(window.location.href);
            if (mode === 'analyze') {
                url.searchParams.set('view', 'analyze');
            } else {
                url.searchParams.delete('view');
            }
            window.history.replaceState(
                window.history.state,
                '',
                `${url.pathname}${url.search}${url.hash}`
            );
        },
        []
    );

    const enterAnalysis = useCallback(() => {
        const prompt = training.prompt;
        const positionFen = training.positionFen;
        if (!prompt || !positionFen) return;
        setKeyboardMove('');
        setKeyboardMoveError(null);
        setAnalysisSession((current) =>
            current?.promptId === prompt.id
                ? current
                : {
                      promptId: prompt.id,
                      initialFen: positionFen,
                  }
        );
        setViewMode('analyze');
        replaceViewInUrl('analyze');
    }, [
        replaceViewInUrl,
        training.positionFen,
        training.prompt,
    ]);

    const returnToSolve = useCallback(() => {
        setViewMode('solve');
        replaceViewInUrl('solve');
    }, [replaceViewInUrl]);

    const requestAnalysis = useCallback(() => {
        if (viewMode === 'analyze') return;
        if (training.canReveal) {
            setRevealIntent('analysis');
            return;
        }
        if (
            training.phase === 'GRADED' ||
            training.phase === 'REVEALED'
        ) {
            enterAnalysis();
        }
    }, [
        enterAnalysis,
        training.canReveal,
        training.phase,
        viewMode,
    ]);

    const goToNextPosition = useCallback(() => {
        returnToSolve();
        setAnalysisSession(null);
        setKeyboardMove('');
        setKeyboardMoveError(null);
        void nextPosition();
    }, [nextPosition, returnToSolve]);

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    const reviewArrows = showBestMove
        ? bestMoveReviewArrows(training.review?.bestMoveUci)
        : [];

    const submitKeyboardMove = useCallback(() => {
        if (
            !training.positionFen ||
            !training.canMove ||
            !keyboardMove.trim()
        ) {
            return;
        }
        const move = legalMoveFromInput(
            training.positionFen,
            keyboardMove
        );
        if (move) {
            setKeyboardMove('');
            setKeyboardMoveError(null);
            void training.submitMove(move);
            return;
        }
        setKeyboardMoveError(
            'Enter a legal move such as Nf3, O-O, or g1f3.'
        );
    }, [keyboardMove, training]);

    const promptText = training.prompt
        ? `${training.prompt.sideToMove === 'w' ? 'White' : 'Black'} to move — find the best move`
        : null;
    const feedback = feedbackForTrainingState({
        phase: training.phase,
        grade: training.grade,
    });
    const boardFeedback = (() => {
        if (
            training.presentation.stage === 'GRADE_REVEAL' &&
            training.presentation.marker
        ) {
            return {
                message: training.presentation.marker.label,
                tone: training.presentation.marker.tone,
            };
        }
        if (training.presentation.stage === 'OPPONENT_MOVE') {
            return {
                message: 'Opponent replies…',
                tone: 'neutral' as const,
            };
        }
        if (
            training.phase === 'SUBMITTING' &&
            training.presentation.stage !== 'USER_MOVE'
        ) {
            return {
                message: feedback.message,
                tone: 'neutral' as const,
                busy: true,
            };
        }
        if (
            training.phase === 'GRADED' ||
            training.phase === 'REVEALED' ||
            training.phase === 'UNRESOLVED' ||
            training.phase === 'AWAITING_MOVE'
        ) {
            return {
                message: feedback.message,
                tone: feedback.tone,
            };
        }
        return null;
    })();
    const terminal =
        training.terminal ||
        training.phase === 'UNRESOLVED';
    const boardFen = training.displayFen ?? training.positionFen;
    const hasCustomFocus = hasEffectivePracticeFocus(
        training.practiceFilters,
        training.appliedPracticeFilters
    );
    const practiceMode =
        training.practiceFilters.mode ??
        training.appliedPracticeFilters.mode ??
        'RECOMMENDED';
    const isCaughtUp = training.feedExhausted && training.feedHadPositions;
    const emptyHeading = isCaughtUp
        ? 'You’re caught up'
        : practiceMode === 'REVIEW'
          ? 'Nothing is due for review'
          : practiceMode === 'NEW'
            ? 'No new positions available'
            : hasCustomFocus
              ? 'No positions are ready for this focus'
              : 'No practice positions yet';
    const emptyDescription = isCaughtUp
        ? 'You’ve completed this queue. Reviewed positions will return when they are due.'
        : practiceMode === 'REVIEW'
          ? 'Your reviewed positions will return here when they are due.'
          : practiceMode === 'NEW'
            ? 'Analyze more games or switch back to the recommended queue.'
            : hasCustomFocus
              ? 'No new or due positions are ready. Broaden the focus or return after a review becomes due.'
              : 'Analyze more games to find personal practice positions.';
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
                    returnToSolve();
                    setAnalysisSession(null);
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
    }, [training.prompt?.id]);

    useEffect(() => {
        const wasTerminal =
            previousPhaseRef.current === 'GRADED' ||
            previousPhaseRef.current === 'REVEALED';
        const isReviewed =
            training.phase === 'GRADED' ||
            training.phase === 'REVEALED';
        if (viewMode === 'solve' && isReviewed && !wasTerminal) {
            feedbackRef.current?.focus();
        }
        previousPhaseRef.current = training.phase;
    }, [training.phase, viewMode]);

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
                            {emptyHeading}
                        </h2>
                        <p className="mt-2 text-sm text-muted-foreground">
                            {emptyDescription}
                        </p>
                        {practiceMode !== 'RECOMMENDED' && !initialMomentId ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="mt-4"
                                onClick={() =>
                                    training.resetFeed({
                                        ...training.practiceFilters,
                                        mode: 'RECOMMENDED',
                                    })
                                }
                            >
                                Return to recommended
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
            <Tabs
                value={viewMode}
                onValueChange={(value) => {
                    if (value === 'solve') {
                        returnToSolve();
                    } else if (value === 'analyze') {
                        requestAnalysis();
                    }
                }}
                aria-label="Practice mode"
                className="space-y-3 sm:space-y-4"
            >
                <TabsList className="grid w-full grid-cols-2 sm:max-w-sm">
                    <TabsTrigger value="solve">Solve</TabsTrigger>
                    <TabsTrigger
                        value="analyze"
                        disabled={training.phase === 'SUBMITTING'}
                    >
                        Analyze
                    </TabsTrigger>
                </TabsList>

                <TabsContent
                    value="solve"
                    className="mt-0 flex flex-col gap-4"
                >
                    <div className="order-1 flex items-start justify-between gap-2 lg:order-2 lg:gap-3">
                        <div className="min-w-0 flex-1">
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
                        <div className="flex shrink-0 flex-wrap items-center gap-2">
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
                                size="icon"
                                variant="outline"
                                className="sm:w-auto sm:px-3"
                                onClick={() => setFlipped((value) => !value)}
                                aria-label="Flip board"
                            >
                                <FlipHorizontal2 aria-hidden="true" />
                                <span className="hidden sm:inline">Flip</span>
                            </Button>
                        </div>
                    </div>

                    <div
                        className={cn(
                            'order-2 grid gap-4 lg:order-3',
                            compact
                                ? 'xl:grid-cols-[minmax(0,620px)_minmax(280px,1fr)]'
                                : 'lg:grid-cols-[minmax(0,620px)_minmax(300px,1fr)]'
                        )}
                    >
                        <div className="min-w-0">
                            <PuzzleBoard
                                key={`${training.prompt.id}:${training.prompt.solutionRevisionId}`}
                                positionFen={boardFen ?? training.prompt.fen}
                                sideToMove={training.prompt.sideToMove}
                                flipped={flipped}
                                canMove={training.canMove}
                                arrows={reviewArrows}
                                presentation={training.presentation}
                                feedback={boardFeedback}
                                reducedMotion={reducedMotion}
                                ariaLabel={
                                    promptText ?? 'Chess practice board'
                                }
                                onMove={(move) => {
                                    void training.submitMove(move);
                                }}
                            />

                            <div
                                ref={feedbackRef}
                                tabIndex={-1}
                                className="sr-only"
                                aria-label={`${training.grade ? `${gradeLabel(training.grade)}. ` : ''}${feedback.message}`}
                            />

                            <div
                                className="sticky bottom-[calc(var(--app-bottom-nav-height)+env(safe-area-inset-bottom)+0.5rem)] z-30 mt-3 flex flex-wrap items-center gap-2 border-y border-foreground/15 bg-background/92 p-2 shadow-raised backdrop-blur md:hidden"
                                data-training-mobile-actions
                            >
                                {training.canReveal ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11 flex-1"
                                        onClick={() =>
                                            setRevealIntent('solution')
                                        }
                                    >
                                        Reveal
                                    </Button>
                                ) : null}
                                {training.review?.submittedMoveUci ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11 flex-1"
                                        onClick={() => {
                                            setShowBestMove(false);
                                            training.showReviewPosition(
                                                'ATTEMPT'
                                            );
                                        }}
                                    >
                                        Your move
                                    </Button>
                                ) : null}
                                {training.review ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11 flex-1"
                                        onClick={() => {
                                            setShowBestMove(true);
                                            training.showReviewPosition(
                                                'DECISION'
                                            );
                                        }}
                                    >
                                        Show best
                                    </Button>
                                ) : null}
                                {training.phase === 'UNRESOLVED' ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11 flex-1"
                                        onClick={() =>
                                            void training.retryGrading()
                                        }
                                    >
                                        Retry analysis
                                    </Button>
                                ) : null}
                                {terminal ? (
                                    <Button
                                        type="button"
                                        className="min-h-11 flex-1"
                                        disabled={training.loading}
                                        onClick={goToNextPosition}
                                    >
                                        {training.loading
                                            ? 'Loading…'
                                            : 'Next position'}
                                        {!training.loading ? (
                                            <ChevronRight
                                                className="ml-1 h-4 w-4"
                                                aria-hidden="true"
                                            />
                                        ) : null}
                                    </Button>
                                ) : null}
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
                            <Card variant="plain" className="rounded-none border-t border-foreground/15">
                                <CardHeader className="px-0 pb-3">
                                    <CardTitle className="text-base">
                                        Your decision
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-3 px-0">
                                    <p className="text-sm text-muted-foreground">
                                        Every legal move is graded on this device against
                                        the position and your original game.
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {training.phase === 'UNRESOLVED' ? (
                                            <Button
                                                type="button"
                                                variant="outline"
                                                className="min-h-11 max-md:hidden"
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
                                                className="min-h-11 max-md:hidden"
                                                onClick={() => {
                                                    setRevealIntent('solution');
                                                }}
                                            >
                                                Reveal
                                            </Button>
                                        ) : null}
                                        {terminal ? (
                                            <Button
                                                type="button"
                                                className="min-h-11 max-md:hidden"
                                                disabled={training.loading}
                                                onClick={goToNextPosition}
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
                                                onClick={goToNextPosition}
                                            >
                                                Try next position again
                                            </Button>
                                        </div>
                                    ) : null}

                                    {training.canMove ? (
                                        <details className="rounded-lg border px-3 py-2 text-sm">
                                            <summary className="flex min-h-11 cursor-pointer select-none items-center font-medium">
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
                                <PostMoveStory
                                    review={training.review}
                                    rootFen={training.prompt.fen}
                                    grade={training.grade}
                                    bestMoveShown={showBestMove}
                                    onShowAttempt={() => {
                                        setShowBestMove(false);
                                        training.showReviewPosition('ATTEMPT');
                                    }}
                                    onShowBest={() => {
                                        setShowBestMove(true);
                                        training.showReviewPosition('DECISION');
                                    }}
                                />
                            ) : null}
                        </div>
                    </div>
                    {focusControls ? (
                        <div className="order-3 lg:order-1">
                            {focusControls}
                        </div>
                    ) : null}
                </TabsContent>

                <TabsContent
                    value="analyze"
                    forceMount
                    className="mt-0 data-[state=inactive]:hidden"
                >
                    {analysisSession?.promptId === training.prompt.id ? (
                        <TrainingAnalysisWorkspace
                            key={`${training.prompt.id}:${training.prompt.solutionRevisionId}`}
                            active={viewMode === 'analyze'}
                            prompt={training.prompt}
                            initialFen={analysisSession.initialFen}
                            review={
                                training.review ??
                                training.prompt.grading.review
                            }
                            engineClient={training.engineClient}
                            onRequestEngine={
                                training.getOrCreateEngine
                            }
                            flipped={flipped}
                            onFlip={() =>
                                setFlipped((value) => !value)
                            }
                            loadingNext={training.loading}
                            onNext={goToNextPosition}
                        >
                            {training.review ? (
                                <PostMoveStory
                                    review={training.review}
                                    rootFen={training.prompt.fen}
                                    grade={training.grade}
                                />
                            ) : null}
                        </TrainingAnalysisWorkspace>
                    ) : null}
                </TabsContent>
            </Tabs>

            <ModalDialog
                open={revealIntent !== null}
                onOpenChange={(open) => {
                    if (open) return;
                    const wasAnalysis = revealIntent === 'analysis';
                    setRevealIntent(null);
                    if (wasAnalysis) returnToSolve();
                }}
                title={
                    revealIntent === 'analysis'
                        ? 'Analyze this position?'
                        : 'Reveal this position?'
                }
                description={
                    revealIntent === 'analysis'
                        ? 'Analysis can expose the answer. Opening it now will record this position as revealed.'
                        : 'The answer and game context stay hidden until you confirm. This will be recorded as revealed.'
                }
            >
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => {
                            const wasAnalysis =
                                revealIntent === 'analysis';
                            setRevealIntent(null);
                            if (wasAnalysis) returnToSolve();
                        }}
                    >
                        Keep solving
                    </Button>
                    <Button
                        type="button"
                        onClick={() => {
                            const shouldEnterAnalysis =
                                revealIntent === 'analysis';
                            setRevealIntent(null);
                            void training.reveal();
                            if (shouldEnterAnalysis) {
                                enterAnalysis();
                            }
                        }}
                    >
                        {revealIntent === 'analysis'
                            ? 'Reveal and analyze'
                            : 'Reveal solution'}
                    </Button>
                </div>
            </ModalDialog>
        </section>
    );
}
