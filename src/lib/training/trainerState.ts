import type {
    GradedPracticeResult,
    PracticeResult,
    RevealedPracticeResult,
    TrainingReviewDto,
} from '@/lib/training/api';

export type TrainerAttemptPhase =
    | 'READY'
    | 'SUBMITTING'
    | 'AWAITING_MOVE'
    | 'GRADED'
    | 'REVEALED'
    | 'UNRESOLVED';

export type TrainerFeedback = {
    tone: 'neutral' | 'positive' | 'warning' | 'negative';
    message: string;
};

export function feedbackForTrainingState({
    phase,
    grade,
}: {
    phase: TrainerAttemptPhase;
    grade?: GradedPracticeResult['grade'] | null;
}): TrainerFeedback {
    if (phase === 'SUBMITTING') {
        return {
            tone: 'neutral',
            message: 'Checking this alternative on your device…',
        };
    }
    if (phase === 'AWAITING_MOVE') {
        return {
            tone: 'neutral',
            message: 'Opponent replied. Find the best move.',
        };
    }
    if (phase === 'UNRESOLVED') {
        return {
            tone: 'warning',
            message:
                'This move could not be graded yet. It has not been marked right or wrong.',
        };
    }
    if (phase === 'REVEALED') {
        return {
            tone: 'warning',
            message: 'Solution revealed. Review the decision below.',
        };
    }
    if (phase !== 'GRADED' || !grade) {
        return {
            tone: 'neutral',
            message: 'Make a move when you are ready.',
        };
    }

    switch (grade) {
        case 'BEST':
            return {
                tone: 'positive',
                message: 'Best move — well found.',
            };
        case 'STRONG':
            return {
                tone: 'positive',
                message: 'Strong move — a high-quality solution.',
            };
        case 'GOOD':
            return {
                tone: 'positive',
                message: 'Good move — this solution is accepted.',
            };
        case 'IMPROVED':
            return {
                tone: 'warning',
                message:
                    'Improved on the game, but there was a stronger continuation.',
            };
        case 'REPEATED_MISTAKE':
            return {
                tone: 'negative',
                message: 'That repeats the mistake from the game.',
            };
        case 'DIFFERENT_MISTAKE':
            return {
                tone: 'negative',
                message: 'That is a different mistake. Review the comparison below.',
            };
    }
}

export function reviewFromTrainingResponse(
    response:
        | PracticeResult
        | RevealedPracticeResult
        | null
): TrainingReviewDto | null {
    if (!response) return null;
    if (response.status === 'GRADED' || response.status === 'REVEALED') {
        return response.review;
    }
    return null;
}
