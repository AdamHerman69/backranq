import type { Square } from 'chess.js';

import type { AttemptGrade } from '@/lib/training/contracts';

export type BoardArrowPresentation = {
    startSquare: Square;
    endSquare: Square;
    color: string;
};

export type BoardMove = {
    from: Square;
    to: Square;
};

export type MoveQualityTone = 'positive' | 'warning' | 'negative';

export type TrainingMoveQuality = {
    grade: AttemptGrade;
    label: string;
    shortLabel: string;
    symbol: string;
    tone: MoveQualityTone;
};

export type BoardMoveMarker = TrainingMoveQuality & {
    square: Square;
};

export type BoardPresentationStage =
    | 'READY'
    | 'USER_MOVE'
    | 'CHECKING'
    | 'GRADE_REVEAL'
    | 'OPPONENT_MOVE'
    | 'SETTLED'
    | 'REVIEW_DECISION'
    | 'REVIEW_ATTEMPT';

export type BoardPresentationState = {
    sequenceId: number;
    stage: BoardPresentationStage;
    lastMove: BoardMove | null;
    marker: BoardMoveMarker | null;
};

export type BoardPresentationEvent =
    | { type: 'RESET'; sequenceId: number }
    | { type: 'USER_MOVE'; sequenceId: number; moveUci: string }
    | { type: 'CHECKING'; sequenceId: number }
    | {
          type: 'GRADE_REVEAL';
          sequenceId: number;
          moveUci: string;
          grade: AttemptGrade;
      }
    | { type: 'OPPONENT_MOVE'; sequenceId: number; moveUci: string }
    | { type: 'SETTLE'; sequenceId: number }
    | {
          type: 'REVIEW_DECISION';
          sequenceId: number;
      }
    | {
          type: 'REVIEW_ATTEMPT';
          sequenceId: number;
          moveUci: string;
          grade: AttemptGrade | null;
      };

export const BOARD_MOVE_ANIMATION_MS = 190;
export const BOARD_GRADE_DWELL_MS = 420;

export function initialBoardPresentation(
    sequenceId = 0
): BoardPresentationState {
    return {
        sequenceId,
        stage: 'READY',
        lastMove: null,
        marker: null,
    };
}

export function boardMoveFromUci(moveUci: string): BoardMove | null {
    const move = moveUci.trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return null;
    return {
        from: move.slice(0, 2) as Square,
        to: move.slice(2, 4) as Square,
    };
}

export function trainingMoveQuality(
    grade: AttemptGrade
): TrainingMoveQuality {
    switch (grade) {
        case 'BEST':
            return {
                grade,
                label: 'Best move',
                shortLabel: 'Best',
                symbol: '★',
                tone: 'positive',
            };
        case 'STRONG':
            return {
                grade,
                label: 'Strong move',
                shortLabel: 'Strong',
                symbol: '✦',
                tone: 'positive',
            };
        case 'GOOD':
            return {
                grade,
                label: 'Good move',
                shortLabel: 'Good',
                symbol: '✓',
                tone: 'positive',
            };
        case 'IMPROVED':
            return {
                grade,
                label: 'Improved move',
                shortLabel: 'Improved',
                symbol: '↑',
                tone: 'warning',
            };
        case 'REPEATED_MISTAKE':
            return {
                grade,
                label: 'Repeated mistake',
                shortLabel: 'Repeated',
                symbol: '↻',
                tone: 'negative',
            };
        case 'DIFFERENT_MISTAKE':
            return {
                grade,
                label: 'Different mistake',
                shortLabel: 'Mistake',
                symbol: '!',
                tone: 'negative',
            };
    }
}

function markerForMove(
    moveUci: string,
    grade: AttemptGrade
): BoardMoveMarker | null {
    const move = boardMoveFromUci(moveUci);
    return move
        ? {
              ...trainingMoveQuality(grade),
              square: move.to,
          }
        : null;
}

export function boardPresentationReducer(
    state: BoardPresentationState,
    event: BoardPresentationEvent
): BoardPresentationState {
    if (event.type === 'RESET') {
        return initialBoardPresentation(event.sequenceId);
    }
    if (event.sequenceId !== state.sequenceId) return state;

    switch (event.type) {
        case 'USER_MOVE':
            return {
                ...state,
                stage: 'USER_MOVE',
                lastMove: boardMoveFromUci(event.moveUci),
                marker: null,
            };
        case 'CHECKING':
            return { ...state, stage: 'CHECKING' };
        case 'GRADE_REVEAL':
            return {
                ...state,
                stage: 'GRADE_REVEAL',
                lastMove: boardMoveFromUci(event.moveUci),
                marker: markerForMove(event.moveUci, event.grade),
            };
        case 'OPPONENT_MOVE':
            return {
                ...state,
                stage: 'OPPONENT_MOVE',
                lastMove: boardMoveFromUci(event.moveUci),
                marker: null,
            };
        case 'SETTLE':
            return { ...state, stage: 'SETTLED' };
        case 'REVIEW_DECISION':
            return {
                ...state,
                stage: 'REVIEW_DECISION',
                lastMove: null,
                marker: null,
            };
        case 'REVIEW_ATTEMPT':
            return {
                ...state,
                stage: 'REVIEW_ATTEMPT',
                lastMove: boardMoveFromUci(event.moveUci),
                marker: event.grade
                    ? markerForMove(event.moveUci, event.grade)
                    : null,
            };
    }
}

export function boardPresentationDelay(
    stage: 'MOVE' | 'GRADE',
    reducedMotion: boolean
): number {
    if (reducedMotion) return 0;
    return stage === 'MOVE'
        ? BOARD_MOVE_ANIMATION_MS
        : BOARD_GRADE_DWELL_MS;
}

export function bestMoveReviewArrows(
    moveUci: string | null | undefined
): BoardArrowPresentation[] {
    const move = moveUci?.trim().toLowerCase() ?? '';
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return [];
    return [
        {
            startSquare: move.slice(0, 2) as Square,
            endSquare: move.slice(2, 4) as Square,
            color: 'rgba(16, 185, 129, 0.82)',
        },
    ];
}
