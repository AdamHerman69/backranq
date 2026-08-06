import type {
    RevealedPracticeResult,
    TrainingComparisonDto,
    TrainingReviewDto,
} from '@/lib/training/api';

/**
 * Public onboarding must always end in a useful review. If a legal move cannot
 * be graded confidently on the device, preserve the submitted move and move
 * directly to the canonical review instead of exposing engine terminology or
 * asking a first-time visitor to retry infrastructure.
 */
export function publicPuzzleReviewFallback(args: {
    review: TrainingReviewDto;
    submittedMoveUci: string;
    comparison?: TrainingComparisonDto | null;
}): RevealedPracticeResult {
    return {
        attemptId: 'public-local',
        status: 'REVEALED',
        review: {
            ...args.review,
            submittedMoveUci: args.submittedMoveUci,
            comparison: args.comparison ?? null,
        },
    };
}
