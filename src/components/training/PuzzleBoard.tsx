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

    const legalTargets = useMemo(() => {
        if (!selectedSquare || !canMove) return new Set<Square>();
        try {
            const chess = new Chess(positionFen);
            return new Set(
                chess
                    .moves({ square: selectedSquare, verbose: true })
                    .map((move) => move.to as Square)
            );
        } catch {
            return new Set<Square>();
        }
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
                backgroundColor: 'rgba(59, 130, 246, 0.32)',
            };
        }
        for (const square of legalTargets) {
            styles[square] = {
                ...styles[square],
                background:
                    'radial-gradient(circle, rgba(59,130,246,0.52) 0 18%, transparent 20%)',
            };
        }
        return styles;
    }, [
        externalSquareStyles,
        legalTargets,
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

    return (
        <>
            <div
                className="relative max-w-full overflow-hidden rounded-xl border bg-card p-1 shadow-sm sm:p-2"
                role="group"
                aria-label={ariaLabel}
                data-board-stage={presentation?.stage ?? 'READY'}
                data-board-fen={positionFen}
                data-board-last-move={lastMoveAttribute}
                data-board-marker={presentation?.marker?.grade}
                data-board-marker-square={presentation?.marker?.square}
            >
                <div className="relative aspect-square w-full touch-manipulation">
                    <Chessboard
                        options={{
                            position: positionFen,
                            boardOrientation:
                                (sideToMove === 'w') !== flipped
                                    ? 'white'
                                    : 'black',
                            allowDragging: canMove,
                            allowDrawingArrows: false,
                            arrows,
                            showAnimations: !reducedMotion,
                            animationDurationInMs: reducedMotion ? 0 : 180,
                            squareStyles,
                            squareRenderer: ({ square, children }) => (
                                <div className="relative h-full w-full">
                                    {children}
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
                                if (!square || !canMove) return;
                                const target = square as Square;
                                if (
                                    selectedSquare &&
                                    legalTargets.has(target)
                                ) {
                                    playOrPromote(selectedSquare, target);
                                    return;
                                }
                                try {
                                    const chess = new Chess(positionFen);
                                    setSelection(
                                        chess.get(target)?.color === chess.turn()
                                            ? {
                                                  fen: positionFen,
                                                  square: target,
                                              }
                                            : null
                                    );
                                } catch {
                                    setSelection(null);
                                }
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
