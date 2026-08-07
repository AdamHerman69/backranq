import { describe, expect, it } from 'vitest';

import {
    BOARD_GRADE_DWELL_MS,
    BOARD_MOVE_ANIMATION_MS,
    boardPresentationDelay,
    boardPresentationReducer,
    initialBoardPresentation,
    trainingMoveQuality,
} from '@/lib/training/boardPresentation';
import { ATTEMPT_GRADES } from '@/lib/training/contracts';

describe('board presentation', () => {
    it('keeps the submitted move visible before revealing its grade', () => {
        const started = boardPresentationReducer(
            initialBoardPresentation(4),
            {
                type: 'USER_MOVE',
                sequenceId: 4,
                moveUci: 'f1c4',
            }
        );

        expect(started).toMatchObject({
            stage: 'USER_MOVE',
            lastMove: { from: 'f1', to: 'c4' },
            marker: null,
        });

        const graded = boardPresentationReducer(started, {
            type: 'GRADE_REVEAL',
            sequenceId: 4,
            moveUci: 'f1c4',
            grade: 'REPEATED_MISTAKE',
        });

        expect(graded).toMatchObject({
            stage: 'GRADE_REVEAL',
            lastMove: { from: 'f1', to: 'c4' },
            marker: {
                grade: 'REPEATED_MISTAKE',
                square: 'c4',
                tone: 'negative',
            },
        });
    });

    it('clears the user marker while presenting the opponent reply', () => {
        const graded = boardPresentationReducer(
            initialBoardPresentation(8),
            {
                type: 'GRADE_REVEAL',
                sequenceId: 8,
                moveUci: 'g1f3',
                grade: 'BEST',
            }
        );
        const opponent = boardPresentationReducer(graded, {
            type: 'OPPONENT_MOVE',
            sequenceId: 8,
            moveUci: 'b8c6',
        });

        expect(opponent).toMatchObject({
            stage: 'OPPONENT_MOVE',
            lastMove: { from: 'b8', to: 'c6' },
            marker: null,
        });
    });

    it('ignores stale events from a replaced position', () => {
        const current = initialBoardPresentation(12);
        const stale = boardPresentationReducer(current, {
            type: 'GRADE_REVEAL',
            sequenceId: 11,
            moveUci: 'e2e4',
            grade: 'BEST',
        });

        expect(stale).toBe(current);
    });

    it('provides an accessible visual token for every training grade', () => {
        for (const grade of ATTEMPT_GRADES) {
            const quality = trainingMoveQuality(grade);
            expect(quality.grade).toBe(grade);
            expect(quality.label.length).toBeGreaterThan(0);
            expect(quality.symbol.length).toBeGreaterThan(0);
            expect(['positive', 'warning', 'negative']).toContain(
                quality.tone
            );
        }
    });

    it('keeps discrete stages but removes waits for reduced motion', () => {
        expect(boardPresentationDelay('MOVE', false)).toBe(
            BOARD_MOVE_ANIMATION_MS
        );
        expect(boardPresentationDelay('GRADE', false)).toBe(
            BOARD_GRADE_DWELL_MS
        );
        expect(boardPresentationDelay('MOVE', true)).toBe(0);
        expect(boardPresentationDelay('GRADE', true)).toBe(0);
    });
});
