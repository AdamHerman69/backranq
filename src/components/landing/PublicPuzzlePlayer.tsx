'use client';

import {
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { FlipHorizontal2 } from 'lucide-react';

import { PostMoveStory } from '@/components/training/PostMoveStory';
import { PuzzleBoard } from '@/components/training/PuzzleBoard';
import { ModalDialog } from '@/components/ui/ModalDialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { usePublicPuzzleSession } from '@/lib/hooks/usePublicPuzzleSession';
import type { LandingPuzzleDto } from '@/lib/onboarding/contracts';
import { legalMoveFromInput } from '@/lib/training/boardInput';
import { bestMoveReviewArrows } from '@/lib/training/boardPresentation';
import { feedbackForTrainingState } from '@/lib/training/trainerState';
import { cn } from '@/lib/utils';
import {
    PersonalGameScanHeader,
    PersonalGameScanPlaceholder,
    PersonalGameScanStatus,
    useScanPlayback,
    type ScanState,
} from './PersonalGameScan';

export function PublicPuzzlePlayer({
    puzzle,
    personalScan,
    onTerminal,
    onAttemptStarted,
    statusSlot,
    compactLayout = false,
}: {
    puzzle: LandingPuzzleDto;
    personalScan?: ScanState;
    onTerminal?: () => void;
    onAttemptStarted?: () => void;
    statusSlot?: ReactNode;
    compactLayout?: boolean;
}) {
    const session = usePublicPuzzleSession(personalScan ? null : puzzle.prompt);
    const playback = useScanPlayback(personalScan);
    const scanPreview = playback.displayed?.progress.preview;
    const sessionActive = !personalScan && session.prompt === puzzle.prompt;
    const [flipped, setFlipped] = useState(false);
    const [revealOpen, setRevealOpen] = useState(false);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardError, setKeyboardError] = useState<string | null>(null);
    const [showBestMove, setShowBestMove] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const terminalReportedRef = useRef<string | null>(null);
    const [presentationIdentity, setPresentationIdentity] = useState(puzzle.id);
    const nextPresentationIdentity = personalScan
        ? `scan:${personalScan.runId}`
        : puzzle.id;
    if (presentationIdentity !== nextPresentationIdentity) {
        setPresentationIdentity(nextPresentationIdentity);
        setFlipped(false);
        setRevealOpen(false);
        setKeyboardMove('');
        setKeyboardError(null);
        setShowBestMove(false);
    }

    useEffect(() => {
        terminalReportedRef.current = null;
    }, [presentationIdentity]);

    useEffect(() => {
        if (!sessionActive || !session.terminal ||
            terminalReportedRef.current === presentationIdentity) return;
        terminalReportedRef.current = presentationIdentity;
        onTerminal?.();
    }, [onTerminal, session.terminal, sessionActive, presentationIdentity]);

    useEffect(() => {
        const media = window.matchMedia('(prefers-reduced-motion: reduce)');
        const update = () => setReducedMotion(media.matches);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    const reviewArrows = showBestMove
        ? bestMoveReviewArrows(session.review?.bestMoveUci)
        : [];

    const feedback = session.reviewFallback
        ? {
              tone: 'neutral' as const,
              message: 'Let’s compare your move with the strongest continuation.',
          }
        : feedbackForTrainingState({
              phase: session.phase,
              grade: session.grade,
          });
    const boardFeedback = (() => {
        if (
            session.presentation.stage === 'GRADE_REVEAL' &&
            session.presentation.marker
        ) {
            return {
                message: session.presentation.marker.label,
                tone: session.presentation.marker.tone,
            };
        }
        if (session.presentation.stage === 'OPPONENT_MOVE') {
            return {
                message: 'Opponent replies…',
                tone: 'neutral' as const,
            };
        }
        if (
            session.phase === 'SUBMITTING' &&
            session.presentation.stage !== 'USER_MOVE'
        ) {
            return {
                message: feedback.message,
                tone: 'neutral' as const,
                busy: true,
            };
        }
        if (
            session.phase === 'GRADED' ||
            session.phase === 'REVEALED' ||
            session.phase === 'AWAITING_MOVE'
        ) {
            return {
                message: feedback.message,
                tone: feedback.tone,
            };
        }
        return null;
    })();
    const boardFen = personalScan
        ? scanPreview?.fen ?? puzzle.prompt.fen
        : sessionActive
          ? session.displayFen ?? puzzle.prompt.fen
          : puzzle.prompt.fen;
    const boardSide = personalScan && scanPreview
        ? scanPreview.orientation === 'white' ? 'w' : 'b'
        : puzzle.prompt.sideToMove;
    const animationDurationMs = personalScan
        ? playback.animationMs
        : sessionActive ? 180 : 0;

    const submitKeyboardMove = () => {
        if (!sessionActive || !session.canMove || !keyboardMove.trim()) return;
        const move = legalMoveFromInput(
            session.positionFen ?? puzzle.prompt.fen,
            keyboardMove
        );
        if (!move) {
            setKeyboardError('Enter a legal move such as Qf8 or f7f8.');
            return;
        }
        setKeyboardMove('');
        setKeyboardError(null);
        session.requestEnginePrewarm();
        onAttemptStarted?.();
        void session.submitMove(move);
    };

    return (
        <section aria-label={personalScan ? "Personal game search" : "Interactive chess puzzle"} className="space-y-3 sm:space-y-4">
            <div className={cn("flex items-start justify-between gap-2 sm:gap-3", compactLayout && "h-[104px]")}>
                {personalScan ? <PersonalGameScanHeader personal={personalScan} playback={playback} /> : <>
                <div className="min-w-0 flex-1">
                    <p className="editorial-label">
                        {puzzle.context.kind === 'PERSONAL'
                            ? 'Your game'
                            : puzzle.context.kind === 'MASTER'
                              ? 'This week’s master position'
                              : 'Instant warm-up'}
                    </p>
                    <h2 className="mt-1.5 text-balance text-lg font-semibold tracking-[-0.025em] sm:text-xl">
                        {puzzle.context.headline}
                    </h2>
                    {puzzle.context.teaser ? (
                        <p className={cn('mt-1 line-clamp-1 text-sm text-muted-foreground', !compactLayout && 'sm:line-clamp-none')}>
                            {puzzle.context.teaser}
                        </p>
                    ) : null}
                    {puzzle.context.kind === 'MASTER' &&
                    puzzle.context.attributionLabel ? (
                        <p className="mt-2 hidden text-xs text-muted-foreground sm:block">
                            {puzzle.context.attributionLabel} · public game · no
                            affiliation or endorsement implied
                        </p>
                    ) : null}
                </div>
                <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0 sm:w-auto sm:px-3"
                    onClick={() => setFlipped((value) => !value)}
                    aria-label="Flip board"
                >
                    <FlipHorizontal2 aria-hidden="true" />
                    <span className="hidden sm:inline">Flip</span>
                </Button>
                </>}
            </div>

            <div
                className={cn(
                    'grid gap-3 sm:gap-4',
                    !compactLayout &&
                        'xl:grid-cols-[minmax(0,560px)_minmax(250px,1fr)]'
                )}
            >
                <div
                    className={cn(
                        'min-w-0',
                        compactLayout && 'mx-auto w-full sm:max-w-none'
                    )}
                >
                    <div className="relative"
                        role={personalScan && scanPreview ? 'group' : undefined}
                        aria-label={personalScan && scanPreview ? 'Game being analyzed' : undefined}
                        data-scan-fen={personalScan ? scanPreview?.fen : undefined}
                        data-scan-phase={personalScan ? playback.displayed?.progress.phase : undefined}
                        data-scan-ply={personalScan ? playback.displayed?.progress.ply : undefined}
                        data-scan-orientation={personalScan ? scanPreview?.orientation : undefined}
                        data-landing-board="true"
                    >
                    <div className={personalScan && !scanPreview ? 'invisible' : undefined}>
                    <PuzzleBoard
                        interactionId={presentationIdentity}
                        positionFen={boardFen}
                        sideToMove={boardSide}
                        flipped={!personalScan && flipped}
                        canMove={sessionActive && session.canMove}
                        arrows={sessionActive ? reviewArrows : []}
                        presentation={sessionActive ? session.presentation : undefined}
                        feedback={sessionActive ? boardFeedback : null}
                        reducedMotion={reducedMotion}
                        animationDurationMs={animationDurationMs}
                        ariaLabel={personalScan ? "Analyzed position" : `${puzzle.prompt.sideToMove === 'w' ? 'White' : 'Black'} to move — find the best move`}
                        onMove={(move) => {
                            session.requestEnginePrewarm();
                            onAttemptStarted?.();
                            void session.submitMove(move);
                        }}
                    />
                    </div>
                    {personalScan && !scanPreview ? <PersonalGameScanPlaceholder personal={personalScan} /> : null}
                    </div>
                    {personalScan ? <PersonalGameScanStatus personal={personalScan} playback={playback} /> :
                    <div className="mt-3 flex flex-wrap gap-2">
                        {sessionActive && session.canReveal ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="min-h-11 flex-1"
                                onClick={() => setRevealOpen(true)}
                            >
                                Reveal
                            </Button>
                        ) : null}
                        {sessionActive && session.review?.submittedMoveUci ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="min-h-11 flex-1"
                                onClick={() => {
                                    setShowBestMove(false);
                                    session.showReviewPosition('ATTEMPT');
                                }}
                            >
                                Your move
                            </Button>
                        ) : null}
                        {sessionActive && session.review ? (
                            <Button
                                type="button"
                                variant="outline"
                                className="min-h-11 flex-1"
                                onClick={() => {
                                    setShowBestMove(true);
                                    session.showReviewPosition('DECISION');
                                }}
                            >
                                Show best
                            </Button>
                        ) : null}
                    </div>}
                </div>

                {!personalScan ? <div className="space-y-3">
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Your decision</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Play the move you would choose in a real game. Known
                                moves are graded instantly on this device.
                            </p>
                            {sessionActive && session.canMove ? (
                                <details className="rounded-lg border px-3 py-2 text-sm">
                                    <summary className="flex min-h-11 cursor-pointer select-none items-center font-medium">
                                        Enter a move with the keyboard
                                    </summary>
                                    <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                                        <Input
                                            value={keyboardMove}
                                            className="h-11"
                                            aria-label="Chess move in SAN or coordinate notation"
                                            aria-invalid={keyboardError ? true : undefined}
                                            placeholder="Qf8 or f7f8"
                                            onChange={(event) => {
                                                setKeyboardMove(event.target.value);
                                                setKeyboardError(null);
                                            }}
                                            onKeyDown={(event) => {
                                                if (event.key === 'Enter') {
                                                    event.preventDefault();
                                                    submitKeyboardMove();
                                                }
                                            }}
                                        />
                                        <Button
                                            type="button"
                                            variant="outline"
                                            className="min-h-11"
                                            disabled={!keyboardMove.trim()}
                                            onClick={submitKeyboardMove}
                                        >
                                            Play move
                                        </Button>
                                    </div>
                                    {keyboardError ? (
                                        <p className="mt-2 text-xs text-destructive" role="alert">
                                            {keyboardError}
                                        </p>
                                    ) : null}
                                </details>
                            ) : null}
                        </CardContent>
                    </Card>
                    {statusSlot}
                </div> : null}
            </div>

            {sessionActive && session.review ? (
                <PostMoveStory
                    review={session.review}
                    rootFen={puzzle.prompt.fen}
                    grade={session.grade}
                    showGameMove={puzzle.context.kind !== 'WARMUP'}
                    sourceUrl={puzzle.context.sourceUrl}
                    sourceNotice={
                        puzzle.context.kind === 'WARMUP'
                            ? 'This is a curated warm-up, not a claimed celebrity game.'
                            : null
                    }
                    compact
                />
            ) : null}

            <ModalDialog
                open={!personalScan && revealOpen}
                onOpenChange={setRevealOpen}
                title="Reveal this position?"
                description="The answer and game context stay hidden until you confirm."
            >
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button type="button" variant="outline" onClick={() => setRevealOpen(false)}>
                        Keep solving
                    </Button>
                    <Button
                        type="button"
                        onClick={() => {
                            setRevealOpen(false);
                            onAttemptStarted?.();
                            session.reveal();
                        }}
                    >
                        Reveal solution
                    </Button>
                </div>
            </ModalDialog>
        </section>
    );
}
