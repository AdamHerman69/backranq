'use client';

import {
    useCallback,
    useMemo,
    useState,
    type CSSProperties,
} from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';

import { ModalDialog } from '@/components/ui/ModalDialog';
import { Button } from '@/components/ui/button';
import type {
    BoardPresentationState,
    MoveQualityTone,
} from '@/lib/training/boardPresentation';
import { useReliableBoardTouch } from '@/lib/hooks/useReliableBoardTouch';
import type { SubmittedBoardMove } from '@/lib/training/boardInput';
import { cn } from '@/lib/utils';

type PromotionPiece = 'q' | 'r' | 'b' | 'n';

type PendingPromotion = {
    fen: string;
    from: Square;
    to: Square;
    choices: PromotionPiece[];
};

export type PuzzleBoardArrow = {
    startSquare: Square;
    endSquare: Square;
    color: string;
};

export type PuzzleBoardFeedback = {
    message: string;
    tone: 'neutral' | MoveQualityTone;
    busy?: boolean;
};

function moveHighlight(tone: PuzzleBoardFeedback['tone'] | undefined) {
    if (tone === 'negative') return 'rgba(239,68,68,0.34)';
    if (tone === 'warning') return 'rgba(59,130,246,0.30)';
    if (tone === 'positive') return 'rgba(16,185,129,0.30)';
    return 'rgba(99,102,241,0.24)';
}

function markerClass(tone: MoveQualityTone) {
    if (tone === 'negative') {
        return 'border-red-200 bg-red-500 text-white shadow-red-950/25';
    }
    if (tone === 'warning') {
        return 'border-blue-100 bg-blue-500 text-white shadow-blue-950/25';
    }
    return 'border-emerald-100 bg-emerald-500 text-white shadow-emerald-950/25';
}

function feedbackClass(tone: PuzzleBoardFeedback['tone']) {
    if (tone === 'negative') {
        return 'border-red-200/80 bg-red-950/88 text-red-50';
    }
    if (tone === 'warning') {
        return 'border-blue-200/80 bg-blue-950/88 text-blue-50';
    }
    if (tone === 'positive') {
        return 'border-emerald-200/80 bg-emerald-950/88 text-emerald-50';
    }
    return 'border-white/20 bg-zinc-950/82 text-white';
}

export function PuzzleBoard({
    positionFen,
    sideToMove,
    flipped,
    canMove,
    arrows = [],
    squareStyles: externalSquareStyles,
    presentation,
    feedback,
    reducedMotion = false,
    ariaLabel,
    onMove,
}: {
    positionFen: string;
    sideToMove: 'w' | 'b';
    flipped: boolean;
    canMove: boolean;
    arrows?: PuzzleBoardArrow[];
    squareStyles?: Record<string, CSSProperties>;
    presentation?: BoardPresentationState;
    feedback?: PuzzleBoardFeedback | null;
    reducedMotion?: boolean;
    ariaLabel: string;
    onMove: (move: SubmittedBoardMove) => void;
}) {
    const [selection, setSelection] = useState<{
        fen: string;
        square: Square;
    } | null>(null);
    const [pendingPromotion, setPendingPromotion] =
        useState<PendingPromotion | null>(null);
    const selectedSquare =
        canMove && selection?.fen === positionFen
            ? selection.square
            : null;
    const activePromotion =
        canMove && pendingPromotion?.fen === positionFen
            ? pendingPromotion
            : null;

    const { legalTargets, captureTargets } = useMemo(() => {
        const targets = new Set<Square>();
        const captures = new Set<Square>();
        if (!selectedSquare || !canMove) {
            return { legalTargets: targets, captureTargets: captures };
        }
        try {
            const chess = new Chess(positionFen);
            for (const move of chess.moves({
                square: selectedSquare,
                verbose: true,
            })) {
                const target = move.to as Square;
                targets.add(target);
                if (move.captured) captures.add(target);
            }
        } catch {
            // An invalid position should leave the board usable without hints.
        }
        return { legalTargets: targets, captureTargets: captures };
    }, [canMove, positionFen, selectedSquare]);

    const squareStyles = useMemo(() => {
        const styles: Record<string, CSSProperties> = {
            ...(externalSquareStyles ?? {}),
        };
        if (presentation?.lastMove) {
            const color = moveHighlight(presentation.marker?.tone);
            styles[presentation.lastMove.from] = {
                ...styles[presentation.lastMove.from],
                backgroundColor: color,
            };
            styles[presentation.lastMove.to] = {
                ...styles[presentation.lastMove.to],
                backgroundColor: color,
            };
        }
        if (selectedSquare) {
            styles[selectedSquare] = {
                ...styles[selectedSquare],
                backgroundColor: 'hsl(var(--board-selected) / 0.72)',
                boxShadow:
                    'inset 0 0 0 3px hsl(var(--foreground) / 0.3)',
            };
        }
        return styles;
    }, [
        externalSquareStyles,
        presentation,
        selectedSquare,
    ]);

    const lastMoveAttribute = presentation?.lastMove
        ? `${presentation.lastMove.from}${presentation.lastMove.to}`
        : undefined;

    const submitLegalMove = useCallback(
        (from: Square, to: Square, promotion?: PromotionPiece) => {
            if (!canMove) return false;
            try {
                const chess = new Chess(positionFen);
                const move = chess.move({ from, to, promotion });
                if (!move) return false;
                setSelection(null);
                setPendingPromotion(null);
                onMove({
                    moveUci: `${move.from}${move.to}${move.promotion ?? ''}`,
                    fenAfterMove: chess.fen(),
                });
                return true;
            } catch {
                return false;
            }
        },
        [canMove, onMove, positionFen]
    );

    const playOrPromote = useCallback(
        (from: Square, to: Square) => {
            if (!canMove) return false;
            try {
                const chess = new Chess(positionFen);
                const choices = Array.from(
                    new Set(
                        chess
                            .moves({ square: from, verbose: true })
                            .filter((move) => move.to === to && move.promotion)
                            .map((move) => move.promotion as PromotionPiece)
                    )
                );
                if (choices.length > 0) {
                    setPendingPromotion({
                        fen: positionFen,
                        from,
                        to,
                        choices,
                    });
                    return true;
                }
            } catch {
                return false;
            }
            return submitLegalMove(from, to);
        },
        [canMove, positionFen, submitLegalMove]
    );

    const handleSquareTap = useCallback(
        (target: Square) => {
            if (!canMove) return;
            if (selectedSquare && legalTargets.has(target)) {
                playOrPromote(selectedSquare, target);
                return;
            }
            try {
                const chess = new Chess(positionFen);
                setSelection(
                    chess.get(target)?.color === chess.turn()
                        ? { fen: positionFen, square: target }
                        : null
                );
            } catch {
                setSelection(null);
            }
        },
        [canMove, legalTargets, playOrPromote, positionFen, selectedSquare]
    );
    const reliableBoardTouch = useReliableBoardTouch({
        enabled: canMove,
        onTap: handleSquareTap,
    });

    return (
        <>
            <div
                className="relative max-w-full overflow-hidden rounded-[0.7rem] border border-foreground/15 bg-foreground p-1 shadow-raised sm:p-1.5"
                role="group"
                aria-label={ariaLabel}
                data-board-stage={presentation?.stage ?? 'READY'}
                data-board-fen={positionFen}
                data-board-last-move={lastMoveAttribute}
                data-board-marker={presentation?.marker?.grade}
                data-board-marker-square={presentation?.marker?.square}
                data-board-selected-square={selectedSquare ?? undefined}
            >
                <div
                    className="relative aspect-square w-full touch-none"
                    {...reliableBoardTouch}
                >
                    <Chessboard
                        options={{
                            position: positionFen,
                            lightSquareStyle: {
                                backgroundColor: 'hsl(var(--board-light))',
                            },
                            darkSquareStyle: {
                                backgroundColor: 'hsl(var(--board-dark))',
                            },
                            boardOrientation:
                                (sideToMove === 'w') !== flipped
                                    ? 'white'
                                    : 'black',
                            allowDragging: canMove,
                            dragActivationDistance: 12,
                            allowDrawingArrows: false,
                            arrows,
                            showAnimations: !reducedMotion,
                            animationDurationInMs: reducedMotion ? 0 : 180,
                            squareStyles,
                            squareRenderer: ({ square, children }) => (
                                <div
                                    className="relative h-full w-full"
                                    style={squareStyles[square]}
                                >
                                    {children}
                                    {legalTargets.has(square as Square) ? (
                                        <span
                                            className={cn(
                                                'pointer-events-none absolute z-10 block motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:duration-150',
                                                captureTargets.has(
                                                    square as Square
                                                )
                                                    ? 'inset-[7%] rounded-full border-[clamp(3px,0.55vw,5px)] border-foreground/45 shadow-[inset_0_0_0_1px_hsl(var(--background)/0.28)]'
                                                    : 'left-1/2 top-1/2 h-[23%] w-[23%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/45 shadow-[0_0_0_1px_hsl(var(--background)/0.22),0_2px_8px_hsl(var(--foreground)/0.18)]'
                                            )}
                                            aria-hidden="true"
                                            data-legal-move-target={square}
                                            data-legal-move-kind={
                                                captureTargets.has(
                                                    square as Square
                                                )
                                                    ? 'capture'
                                                    : 'move'
                                            }
                                        />
                                    ) : null}
                                    {presentation?.marker?.square === square ? (
                                        <span
                                            className={cn(
                                                'pointer-events-none absolute right-[5%] top-[5%] z-20 flex h-[28%] min-h-5 min-w-5 items-center justify-center rounded-full border text-[clamp(11px,2.8vw,17px)] font-black leading-none shadow-lg',
                                                'animate-in fade-in zoom-in-75 duration-200 motion-reduce:animate-none',
                                                markerClass(
                                                    presentation.marker.tone
                                                )
                                            )}
                                            role="img"
                                            aria-label={`${presentation.marker.label} on ${square}`}
                                            data-move-quality-marker={
                                                presentation.marker.grade
                                            }
                                        >
                                            {presentation.marker.symbol}
                                        </span>
                                    ) : null}
                                </div>
                            ),
                            canDragPiece: ({ square }) => {
                                if (!square || !canMove) return false;
                                try {
                                    const chess = new Chess(positionFen);
                                    return (
                                        chess.get(square as Square)?.color ===
                                        chess.turn()
                                    );
                                } catch {
                                    return false;
                                }
                            },
                            onSquareClick: ({ square }) => {
                                if (square) handleSquareTap(square as Square);
                            },
                            onPieceDrop: canMove
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
                    {feedback ? (
                        <div className="pointer-events-none absolute inset-x-2 bottom-2 z-30 flex justify-center sm:inset-x-3 sm:bottom-3">
                            <div
                                className={cn(
                                    'flex max-w-[92%] items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold shadow-xl backdrop-blur-md sm:text-sm',
                                    'animate-in fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none',
                                    feedbackClass(feedback.tone)
                                )}
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                                data-board-feedback-tone={feedback.tone}
                            >
                                {feedback.busy ? (
                                    <span
                                        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current motion-reduce:animate-none"
                                        aria-hidden="true"
                                    />
                                ) : null}
                                <span className="truncate">
                                    {feedback.message}
                                </span>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>

            <ModalDialog
                open={activePromotion !== null}
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
                            activePromotion?.choices.includes(piece)
                        )
                        .map(([piece, label]) => (
                            <Button
                                key={piece}
                                type="button"
                                variant="outline"
                                aria-label={`Promote to ${label}`}
                                onClick={() => {
                                    if (!activePromotion) return;
                                    submitLegalMove(
                                        activePromotion.from,
                                        activePromotion.to,
                                        piece
                                    );
                                }}
                            >
                                {label}
                            </Button>
                        ))}
                </div>
            </ModalDialog>
        </>
    );
}
