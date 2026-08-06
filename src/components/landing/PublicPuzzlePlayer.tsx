'use client';

import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type CSSProperties,
    type ReactNode,
} from 'react';
import { Chess, type Square } from 'chess.js';
import { ExternalLink, FlipHorizontal2, Loader2 } from 'lucide-react';
import { Chessboard } from 'react-chessboard';

import { ModalDialog } from '@/components/ui/ModalDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { usePublicPuzzleSession } from '@/lib/hooks/usePublicPuzzleSession';
import type { LandingPuzzleDto } from '@/lib/onboarding/contracts';
import {
    lessonLabel,
    moveLabel,
    moveLineLabels,
    sourceLabel,
    themeLabel,
} from '@/lib/training/presentation';
import { feedbackForTrainingState } from '@/lib/training/trainerState';
import { cn } from '@/lib/utils';

type PromotionPiece = 'q' | 'r' | 'b' | 'n';
type PendingPromotion = {
    from: Square;
    to: Square;
    choices: PromotionPiece[];
};

function safeSourceUrl(value: string | null): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

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
    const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
    const [pendingPromotion, setPendingPromotion] =
        useState<PendingPromotion | null>(null);
    const [flipped, setFlipped] = useState(false);
    const [revealOpen, setRevealOpen] = useState(false);
    const [keyboardMove, setKeyboardMove] = useState('');
    const [keyboardError, setKeyboardError] = useState<string | null>(null);
    const terminalReportedRef = useRef(false);

    useEffect(() => {
        terminalReportedRef.current = false;
        setSelectedSquare(null);
        setPendingPromotion(null);
        setRevealOpen(false);
        setKeyboardMove('');
        setKeyboardError(null);
    }, [puzzle.id]);

    useEffect(() => {
        if (!session.terminal || terminalReportedRef.current) return;
        terminalReportedRef.current = true;
        onTerminal?.();
    }, [onTerminal, session.terminal]);

    const legalTargets = useMemo(() => {
        if (!selectedSquare || !session.canMove) return new Set<Square>();
        try {
            const chess = new Chess(session.positionFen);
            return new Set(
                chess
                    .moves({ square: selectedSquare, verbose: true })
                    .map((move) => move.to as Square)
            );
        } catch {
            return new Set<Square>();
        }
    }, [selectedSquare, session.canMove, session.positionFen]);

    const squareStyles = useMemo(() => {
        const styles: Record<string, CSSProperties> = {};
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
        const move = session.review?.bestMoveUci.trim().toLowerCase();
        if (!move || move.length < 4) return [];
        return [
            {
                startSquare: move.slice(0, 2) as Square,
                endSquare: move.slice(2, 4) as Square,
                color: 'rgba(16, 185, 129, 0.82)',
            },
        ];
    }, [session.review?.bestMoveUci]);

    const submitLegalMove = useCallback(
        (from: Square, to: Square, promotion?: PromotionPiece) => {
            if (!session.canMove) return false;
            try {
                const chess = new Chess(session.positionFen);
                const move = chess.move({ from, to, promotion });
                if (!move) return false;
                setSelectedSquare(null);
                setPendingPromotion(null);
                onAttemptStarted?.();
                void session.submitMove({
                    moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
                    fenAfterMove: chess.fen(),
                });
                return true;
            } catch {
                return false;
            }
        },
        [onAttemptStarted, session]
    );

    const playOrPromote = useCallback(
        (from: Square, to: Square) => {
            if (!session.canMove) return false;
            try {
                const chess = new Chess(session.positionFen);
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
        [session.canMove, session.positionFen, submitLegalMove]
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
    const boardFen = session.review ? puzzle.prompt.fen : session.positionFen;
    const sourceUrl = safeSourceUrl(puzzle.context.sourceUrl);

    const submitKeyboardMove = () => {
        if (!session.canMove || !keyboardMove.trim()) return;
        try {
            const chess = new Chess(session.positionFen);
            const notation = keyboardMove.trim();
            const normalized = notation.toLowerCase();
            const move = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(normalized)
                ? chess.move({
                      from: normalized.slice(0, 2),
                      to: normalized.slice(2, 4),
                      promotion: normalized.slice(4, 5) || undefined,
                  })
                : chess.move(notation);
            if (!move) throw new Error('Illegal move');
            setKeyboardMove('');
            setKeyboardError(null);
            setSelectedSquare(null);
            onAttemptStarted?.();
            void session.submitMove({
                moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
                fenAfterMove: chess.fen(),
            });
        } catch {
            setKeyboardError('Enter a legal move such as Qf8 or f7f8.');
        }
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
                    <div
                        className="rounded-xl border bg-card p-1 shadow-sm sm:p-2"
                        role="group"
                        aria-label={`${puzzle.prompt.sideToMove === 'w' ? 'White' : 'Black'} to move — find the best move`}
                    >
                        <Chessboard
                            options={{
                                position: boardFen,
                                boardOrientation:
                                    (puzzle.prompt.sideToMove === 'w') !== flipped
                                        ? 'white'
                                        : 'black',
                                allowDragging: session.canMove,
                                allowDrawingArrows: false,
                                arrows: reviewArrows,
                                squareStyles,
                                canDragPiece: ({ square }) => {
                                    if (!square || !session.canMove) return false;
                                    try {
                                        const chess = new Chess(session.positionFen);
                                        return (
                                            chess.get(square as Square)?.color ===
                                            chess.turn()
                                        );
                                    } catch {
                                        return false;
                                    }
                                },
                                onSquareClick: ({ square }) => {
                                    if (!square || !session.canMove) return;
                                    const target = square as Square;
                                    if (
                                        selectedSquare &&
                                        legalTargets.has(target)
                                    ) {
                                        playOrPromote(selectedSquare, target);
                                        return;
                                    }
                                    try {
                                        const chess = new Chess(session.positionFen);
                                        setSelectedSquare(
                                            chess.get(target)?.color === chess.turn()
                                                ? target
                                                : null
                                        );
                                    } catch {
                                        setSelectedSquare(null);
                                    }
                                },
                                onPieceDrop: session.canMove
                                    ? ({ sourceSquare, targetSquare }) =>
                                          targetSquare
                                              ? playOrPromote(
                                                    sourceSquare as Square,
                                                    targetSquare as Square
                                                )
                                              : false
                                    : undefined,
                            }}
                        />
                    </div>
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
                <Card role="region" aria-label="Position review">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base">Position review</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4 text-sm">
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                            <div>
                                <dt className="text-muted-foreground">Your move</dt>
                                <dd className="mt-1 font-medium">
                                    {moveLabel(
                                        puzzle.prompt.fen,
                                        session.review.submittedMoveUci
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-muted-foreground">Best move</dt>
                                <dd className="mt-1 font-medium">
                                    {moveLabel(
                                        puzzle.prompt.fen,
                                        session.review.bestMoveUci
                                    )}
                                </dd>
                            </div>
                            {puzzle.context.kind !== 'WARMUP' ? (
                                <div>
                                    <dt className="text-muted-foreground">
                                        Move played in the game
                                    </dt>
                                    <dd className="mt-1 font-medium">
                                        {moveLabel(
                                            puzzle.prompt.fen,
                                            session.review.originalMoveUci
                                        )}
                                    </dd>
                                </div>
                            ) : null}
                        </dl>
                        <div>
                            <div className="text-muted-foreground">
                                Best continuation
                            </div>
                            <p className="mt-1 font-medium">
                                {moveLineLabels(
                                    puzzle.prompt.fen,
                                    session.review.bestLineUci
                                ).join(' ') || 'No continuation needed.'}
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {session.review.sourceKinds.map((value) => (
                                <Badge key={value} variant="secondary">
                                    {sourceLabel(value)}
                                </Badge>
                            ))}
                            {session.review.lessonKinds.map((value) => (
                                <Badge key={value} variant="outline">
                                    {lessonLabel(value)}
                                </Badge>
                            ))}
                            {session.review.themes.map((value) => (
                                <Badge key={value} variant="outline">
                                    {themeLabel(value)}
                                </Badge>
                            ))}
                        </div>
                        {sourceUrl ? (
                            <a
                                href={sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                            >
                                Open the public source game
                                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                        ) : puzzle.context.kind === 'WARMUP' ? (
                            <p className="text-xs text-muted-foreground">
                                This is a curated warm-up, not a claimed celebrity game.
                            </p>
                        ) : null}
                    </CardContent>
                </Card>
            ) : null}

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
                        .filter(([piece]) => pendingPromotion?.choices.includes(piece))
                        .map(([piece, label]) => (
                            <Button
                                key={piece}
                                type="button"
                                variant="outline"
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
