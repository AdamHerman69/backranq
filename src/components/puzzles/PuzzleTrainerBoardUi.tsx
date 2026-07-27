'use client';

import {
    ChevronLeft,
    ChevronRight,
    FlipHorizontal2,
    Lightbulb,
    Loader2,
    Play,
    Redo2,
    RotateCcw,
    Undo2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ModalDialog } from '@/components/ui/ModalDialog';

type TrainerViewMode = 'solve' | 'analyze';
type AttemptFeedback = 'best' | 'accepted' | 'wrong' | null;
type AttemptResult = 'correct' | 'incorrect' | null;
type LocalOutcome = 'solved' | 'failed' | 'revealed' | 'skipped' | null;

export function PuzzleTrainerWrongMoveOverlay({
    visible,
    refutationLoading,
    onHint,
    onLoadRefutation,
    onAnalyze,
    onTryAgain,
}: {
    visible: boolean;
    refutationLoading: boolean;
    onHint: () => void;
    onLoadRefutation: () => void;
    onAnalyze: () => void;
    onTryAgain: () => void;
}) {
    if (!visible) return null;

    return (
        <div className="absolute inset-x-3 bottom-3 z-[100] rounded-lg border bg-card/95 p-4 shadow-lg backdrop-blur-sm">
            <div className="text-sm font-medium">Not the best move</div>
            <div className="mt-1 text-sm text-muted-foreground">
                Choose how you want to learn from it. Nothing will autoplay.
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={onHint}>
                    <Lightbulb className="mr-2 h-4 w-4" />
                    Hint
                </Button>
                <Button
                    type="button"
                    variant="outline"
                    onClick={onLoadRefutation}
                    disabled={refutationLoading}
                >
                    {refutationLoading ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                        <Play className="mr-2 h-4 w-4" />
                    )}
                    Play refutation
                </Button>
                <Button type="button" onClick={onAnalyze}>
                    Analyze
                </Button>
                <Button type="button" variant="outline" onClick={onTryAgain}>
                    Try again
                </Button>
            </div>
        </div>
    );
}

export function PuzzleTrainerDialogs({
    promotionChoices,
    disclosurePrompt,
    onClosePromotion,
    onChoosePromotion,
    onCloseDisclosure,
    onConfirmDisclosure,
}: {
    promotionChoices: Array<'q' | 'r' | 'b' | 'n'> | null;
    disclosurePrompt: 'solution' | 'analyze' | null;
    onClosePromotion: () => void;
    onChoosePromotion: (piece: 'q' | 'r' | 'b' | 'n') => void;
    onCloseDisclosure: () => void;
    onConfirmDisclosure: () => void;
}) {
    return (
        <>
            <ModalDialog
                open={promotionChoices !== null}
                onOpenChange={(open) => {
                    if (!open) onClosePromotion();
                }}
                title="Promote pawn to"
                description="Choose the piece for this legal promotion."
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
                        .filter(([piece]) => promotionChoices?.includes(piece))
                        .map(([piece, label]) => (
                            <Button
                                key={piece}
                                type="button"
                                variant="outline"
                                onClick={() => onChoosePromotion(piece)}
                                aria-label={`Promote to ${label}`}
                            >
                                {label}
                            </Button>
                        ))}
                </div>
            </ModalDialog>

            <ModalDialog
                open={disclosurePrompt !== null}
                onOpenChange={(open) => {
                    if (!open) onCloseDisclosure();
                }}
                title="Reveal this puzzle?"
                description={
                    disclosurePrompt === 'analyze'
                        ? 'Opening analysis can expose the answer. Counted as revealed in this session.'
                        : 'Showing the solution is counted as revealed in this session.'
                }
            >
                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <Button type="button" variant="outline" onClick={onCloseDisclosure}>
                        Keep solving
                    </Button>
                    <Button type="button" onClick={onConfirmDisclosure}>
                        {disclosurePrompt === 'analyze'
                            ? 'Reveal and analyze'
                            : 'Reveal solution'}
                    </Button>
                </div>
            </ModalDialog>
        </>
    );
}

export function PuzzleTrainerBoardFeedback({
    localOutcome,
    attemptFeedback,
    hintLevel,
    viewMode,
    attemptResult,
    showSolution,
    showRealMove,
    refutationLength,
    refutationStep,
    refutationError,
    onRefutationStepChange,
}: {
    localOutcome: LocalOutcome;
    attemptFeedback: AttemptFeedback;
    hintLevel: number;
    viewMode: TrainerViewMode;
    attemptResult: AttemptResult;
    showSolution: boolean;
    showRealMove: boolean;
    refutationLength: number;
    refutationStep: number;
    refutationError: string | null;
    onRefutationStepChange: (step: number) => void;
}) {
    return (
        <>
            <div
                className="mt-3 min-h-10 rounded-lg border bg-card px-3 py-2 text-sm"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {(localOutcome === 'revealed' || localOutcome === 'skipped') &&
                (attemptFeedback === 'best' || attemptFeedback === 'accepted') ? (
                    <span className="font-medium text-amber-700 dark:text-amber-300">
                        Good practice move. This puzzle remains{' '}
                        {localOutcome === 'revealed' ? 'Revealed' : 'Skipped'}.
                    </span>
                ) : attemptFeedback === 'best' ? (
                    <span className="font-medium text-emerald-700 dark:text-emerald-300">
                        Best move — well found.
                    </span>
                ) : attemptFeedback === 'accepted' ? (
                    <span className="font-medium text-emerald-700 dark:text-emerald-300">
                        Correct alternative. It works, though another accepted line is ranked best.
                    </span>
                ) : attemptFeedback === 'wrong' ? (
                    <span className="font-medium text-red-700 dark:text-red-300">
                        Not the best move. Try again, ask for a hint, inspect the refutation, or analyze.
                    </span>
                ) : hintLevel > 0 ? (
                    <span className="text-amber-700 dark:text-amber-300">
                        Hint: focus on the highlighted piece.
                    </span>
                ) : (
                    <span className="text-muted-foreground">
                        Make a move when you are ready.
                    </span>
                )}
            </div>

            {viewMode === 'solve' &&
            (attemptResult || showSolution || showRealMove) ? (
                <div
                    className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground"
                    aria-label="Board arrow legend"
                >
                    <span>
                        <span aria-hidden="true" className="mr-1 text-emerald-500">●</span>
                        Accepted move
                    </span>
                    {attemptResult === 'incorrect' ? (
                        <span>
                            <span aria-hidden="true" className="mr-1 text-red-500">●</span>
                            Your move
                        </span>
                    ) : null}
                    {showRealMove ? (
                        <span>
                            <span aria-hidden="true" className="mr-1 text-amber-500">●</span>
                            Source-game move
                        </span>
                    ) : null}
                </div>
            ) : null}

            {refutationLength > 1 ? (
                <div className="mt-3 rounded-lg border bg-card p-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="font-medium">Refutation line</span>
                        <span className="text-muted-foreground">
                            Step {refutationStep} / {refutationLength - 1}
                        </span>
                    </div>
                    <input
                        type="range"
                        min={0}
                        max={Math.max(0, refutationLength - 1)}
                        value={refutationStep}
                        onChange={(event) =>
                            onRefutationStepChange(Number(event.target.value))
                        }
                        className="mt-2 w-full accent-primary"
                        aria-label="Refutation line step"
                    />
                    <div className="mt-2 flex justify-between gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                onRefutationStepChange(Math.max(0, refutationStep - 1))
                            }
                            disabled={refutationStep <= 0}
                        >
                            Previous move
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                                onRefutationStepChange(
                                    Math.min(refutationLength - 1, refutationStep + 1)
                                )
                            }
                            disabled={refutationStep >= refutationLength - 1}
                        >
                            Next move
                        </Button>
                    </div>
                </div>
            ) : refutationError ? (
                <div className="mt-3 text-sm text-red-700 dark:text-red-300" role="alert">
                    {refutationError}
                </div>
            ) : null}
        </>
    );
}

export function PuzzleTrainerBoardControls({
    viewMode,
    canStepPrev,
    canStepNext,
    onStepPrev,
    onStepNext,
    hasRealSourceMove,
    reviewUnlocked,
    contextHintsEnabled,
    showRealMove,
    onToggleSourceMove,
    onRevealSolution,
    canReset,
    onReset,
    analysisHistoryIdx,
    analysisHistoryLength,
    onUndo,
    onRedo,
    boardFlipped,
    onFlipBoard,
    idx,
    loadingNext,
    onPreviousPuzzle,
    onNextPuzzle,
}: {
    viewMode: TrainerViewMode;
    canStepPrev: boolean;
    canStepNext: boolean;
    onStepPrev: () => void;
    onStepNext: () => void;
    hasRealSourceMove: boolean;
    reviewUnlocked: boolean;
    contextHintsEnabled: boolean;
    showRealMove: boolean;
    onToggleSourceMove: () => void;
    onRevealSolution: () => void;
    canReset: boolean;
    onReset: () => void;
    analysisHistoryIdx: number;
    analysisHistoryLength: number;
    onUndo: () => void;
    onRedo: () => void;
    boardFlipped: boolean;
    onFlipBoard: () => void;
    idx: number;
    loadingNext: boolean;
    onPreviousPuzzle: () => void;
    onNextPuzzle: () => void;
}) {
    return (
        <>
            <div className="mt-2 grid w-full grid-cols-[44px_minmax(0,1fr)_44px] items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11"
                    onClick={onStepPrev}
                    disabled={!canStepPrev}
                    aria-label="Previous line move"
                    title="Previous line move"
                >
                    <ChevronLeft className="h-5 w-5" />
                </Button>

                <div className="flex min-w-0 items-center justify-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        className="hidden h-10 px-2 text-xs sm:inline-flex sm:px-3 sm:text-sm"
                        onClick={onToggleSourceMove}
                        disabled={
                            !hasRealSourceMove ||
                            (!reviewUnlocked && !contextHintsEnabled)
                        }
                    >
                        {showRealMove ? 'Hide source move' : 'Show source move'}
                    </Button>
                    {viewMode === 'solve' ? (
                        <Button
                            type="button"
                            variant="outline"
                            className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                            onClick={onRevealSolution}
                        >
                            Solution
                        </Button>
                    ) : null}
                    <Button
                        type="button"
                        variant="outline"
                        className="h-10 px-2 text-xs sm:px-3 sm:text-sm"
                        onClick={onReset}
                        disabled={!canReset}
                        aria-label="Reset"
                        title="Reset"
                    >
                        <RotateCcw className="h-4 w-4 sm:mr-2" />
                        <span className="hidden sm:inline">reset</span>
                    </Button>
                </div>

                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11"
                    onClick={onStepNext}
                    disabled={!canStepNext}
                    aria-label="Next line move"
                    title="Next line move"
                >
                    <ChevronRight className="h-5 w-5" />
                </Button>
            </div>

            {viewMode === 'analyze' ? (
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onUndo}
                        disabled={analysisHistoryIdx <= 0}
                    >
                        <Undo2 className="mr-2 h-4 w-4" />
                        Undo
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onRedo}
                        disabled={analysisHistoryIdx >= analysisHistoryLength - 1}
                    >
                        <Redo2 className="mr-2 h-4 w-4" />
                        Redo
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onFlipBoard}
                        aria-pressed={boardFlipped}
                    >
                        <FlipHorizontal2 className="mr-2 h-4 w-4" />
                        Flip board
                    </Button>
                </div>
            ) : null}

            <div className="sticky bottom-3 z-30 mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-2 rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur lg:hidden">
                <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    onClick={onPreviousPuzzle}
                    disabled={idx <= 0}
                >
                    Previous
                </Button>
                <Button
                    type="button"
                    className="h-11 w-full"
                    onClick={onNextPuzzle}
                    disabled={loadingNext}
                >
                    {loadingNext ? 'Loading next puzzle…' : 'Next puzzle'}
                </Button>
            </div>
        </>
    );
}
