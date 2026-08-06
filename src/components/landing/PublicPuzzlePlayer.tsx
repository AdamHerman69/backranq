'use client';

import {
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { FlipHorizontal2, Loader2 } from 'lucide-react';

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

function feedbackClass(tone: 'neutral' | 'positive' | 'warning' | 'negative') {
    if (tone === 'positive') {
        return 'border-emerald-500/30 bg-emerald-500/5 text-emerald-800 dark:text-emerald-200';
    }
    if (tone === 'negative') {
        return 'border-red-500/30 bg-red-500/5 text-red-800 dark:text-red-200';
    }
    if (tone === 'warning') {
        return 'border-amber-500/30 bg-amber-500/5 text-amber-800 dark:text-amber-200';
    }
    return 'bg-card text-muted-foreground';
}

export function PublicPuzzlePlayer({
    puzzle,
    onTerminal,
    onAttemptStarted,
    statusSlot,
    compactLayout = false,
}: {
    puzzle: LandingPuzzleDto;
    onTerminal?: () => void;
    onAttemptStarted?: () => void;
    statusSlot?: ReactNode;
    compactLayout?: boolean;
}) {
    const session = usePublicPuzzleSession(puzzle.prompt);
    const [flipped, setFlipped] = useState(false);
    const [revealOpen, setRevealOpen] = useState(false);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardError, setKeyboardError] = useState<string | null>(null);
    const terminalReportedRef = useRef(false);

    useEffect(() => {
        if (!session.terminal || terminalReportedRef.current) return;
        terminalReportedRef.current = true;
        onTerminal?.();
    }, [onTerminal, session.terminal]);

    const reviewArrows = bestMoveReviewArrows(
        session.review?.bestMoveUci
    );

    const feedback = session.reviewFallback
        ? {
              tone: 'neutral' as const,
              message: 'Let’s compare your move with the strongest continuation.',
          }
        : feedbackForTrainingState({
              phase: session.phase,
              grade: session.grade,
          });
    const submitKeyboardMove = () => {
        if (!session.canMove || !keyboardMove.trim()) return;
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
        onAttemptStarted?.();
        void session.submitMove(move);
    };

    return (
        <section aria-label="Interactive chess puzzle" className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        {puzzle.context.kind === 'PERSONAL'
                            ? 'Your game'
                            : puzzle.context.kind === 'MASTER'
                              ? 'This week’s master position'
                              : 'Instant warm-up'}
                    </p>
                    <h2 className="mt-1 text-balance text-xl font-semibold tracking-tight">
                        {puzzle.context.headline}
                    </h2>
                    {puzzle.context.teaser ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                            {puzzle.context.teaser}
                        </p>
                    ) : null}
                    {puzzle.context.kind === 'MASTER' &&
                    puzzle.context.attributionLabel ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                            {puzzle.context.attributionLabel} · public game · no
                            affiliation or endorsement implied
                        </p>
                    ) : null}
                </div>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setFlipped((value) => !value)}
                    aria-label="Flip board"
                >
                    <FlipHorizontal2 aria-hidden="true" />
                    Flip
                </Button>
            </div>

            <div
                className={cn(
                    'grid gap-4',
                    !compactLayout &&
                        'xl:grid-cols-[minmax(0,560px)_minmax(250px,1fr)]'
                )}
            >
                <div className="min-w-0">
                    <PuzzleBoard
                        positionFen={
                            session.displayFen ?? puzzle.prompt.fen
                        }
                        sideToMove={puzzle.prompt.sideToMove}
                        flipped={flipped}
                        canMove={session.canMove}
                        arrows={reviewArrows}
                        ariaLabel={`${puzzle.prompt.sideToMove === 'w' ? 'White' : 'Black'} to move — find the best move`}
                        onMove={(move) => {
                            onAttemptStarted?.();
                            void session.submitMove(move);
                        }}
                    />
                    <div
                        className={cn(
                            'mt-3 min-h-11 rounded-lg border px-3 py-2.5 text-sm',
                            feedbackClass(feedback.tone)
                        )}
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                    >
                        <div className="flex items-center gap-2">
                            {session.phase === 'SUBMITTING' ? (
                                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : null}
                            <span>{feedback.message}</span>
                        </div>
                    </div>
                </div>

                <div className="space-y-3">
                    <Card>
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">Your decision</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Play the move you would choose in a real game. Known
                                moves are graded instantly on this device.
                            </p>
                            <div className="flex flex-wrap gap-2">
                                {session.canReveal ? (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        className="min-h-11"
                                        onClick={() => setRevealOpen(true)}
                                    >
                                        Reveal
                                    </Button>
                                ) : null}
                            </div>
                            {session.canMove ? (
                                <details className="rounded-lg border px-3 py-2 text-sm">
                                    <summary className="cursor-pointer select-none font-medium">
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
                </div>
            </div>

            {session.review ? (
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
                open={revealOpen}
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
