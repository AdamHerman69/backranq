import { describe, expect, it } from 'vitest';

import type { TrainingReviewDto } from '@/lib/training/api';
import {
    feedbackForTrainingState,
    reviewFromTrainingResponse,
} from '@/lib/training/trainerState';

const review = {
    trainingSide: 'w',
    originalMoveUci: 'e2e3',
    submittedMoveUci: 'e2e4',
    bestMoveUci: 'e2e4',
    acceptedMovesUci: ['e2e4'],
    acceptedMovesComplete: true,
    bestLineUci: ['e2e4', 'e7e5'],
    scoreAtStart: { kind: 'cp', cp: 25, pov: 'WHITE' },
    originalDecision: {
        scoreBefore: { kind: 'cp', cp: 25, pov: 'WHITE' },
        scoreAfter: { kind: 'cp', cp: -80, pov: 'WHITE' },
        cpLoss: 105,
        winChanceLoss: 0.2,
    },
    comparison: null,
    sourceKinds: ['MY_MISTAKE'],
    lessonKinds: ['AVOID_MISTAKE'],
    themes: ['center'],
    source: {
        gameId: 'game-id',
        provider: 'lichess',
        playedAt: '2026-07-20T12:00:00.000Z',
        decisionPly: 2,
    },
} satisfies TrainingReviewDto;

describe('canonical training trainer state', () => {
    it('describes local analysis and completed grades', () => {
        expect(
            feedbackForTrainingState({ phase: 'SUBMITTING' })
        ).toEqual({
            tone: 'neutral',
            message: 'Checking this alternative on your device…',
        });
        expect(
            feedbackForTrainingState({
                phase: 'GRADED',
                grade: 'BEST',
            }).message
        ).toBe('Best move — well found.');
        expect(
            feedbackForTrainingState({
                phase: 'GRADED',
                grade: 'REPEATED_MISTAKE',
            }).message
        ).toBe('That repeats the mistake from the game.');
    });

    it('keeps review metadata sealed for unresolved and continuation responses', () => {
        expect(
            reviewFromTrainingResponse({
                attemptId: 'attempt',
                status: 'UNRESOLVED',
                reason: 'ENGINE_UNAVAILABLE',
            })
        ).toBeNull();
        expect(
            reviewFromTrainingResponse({
                attemptId: 'attempt',
                status: 'AWAITING_CONTINUATION',
                nextStepIndex: 1,
                opponentMove: {
                    moveUci: 'e7e5',
                    fenAfter: 'continuation-fen',
                },
            })
        ).toBeNull();
        expect(
            reviewFromTrainingResponse({
                attemptId: 'attempt',
                status: 'GRADED',
                grade: 'GOOD',
                accepted: true,
                review,
            })
        ).toBe(review);
    });

});
