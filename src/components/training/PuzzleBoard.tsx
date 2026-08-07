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
import type { SubmittedBoardMove } from '@/lib/training/boardInput';

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

export function PuzzleBoard({
    positionFen,
    sideToMove,
    flipped,
    canMove,
    arrows = [],
    squareStyles: externalSquareStyles,
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
    }, [externalSquareStyles, legalTargets, selectedSquare]);

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
                className="rounded-xl border bg-card p-1 shadow-sm sm:p-2"
                role="group"
                aria-label={ariaLabel}
            >
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
                                        ? { fen: positionFen, square: target }
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
