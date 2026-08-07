import { describe, expect, it } from 'vitest';

import { publicPuzzleReviewFallback } from '@/lib/onboarding/publicPuzzleGrading';
import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';

describe('public puzzle grading fallback', () => {
    it('turns an ungradable legal move into a useful review, never unresolved UI', () => {
        const result = publicPuzzleReviewFallback({
            review: WARMUP_PUZZLE.prompt.grading.review,
            submittedMoveUci: 'b4b5',
            comparison: {
                submittedScoreAfter: null,
                bestGapCp: 120,
                bestGapWinChance: null,
                recoveredCp: null,
                recoveredWinChance: null,
                preservesOutcome: false,
            },
        });

        expect(result.status).toBe('REVEALED');
        expect(result.review.submittedMoveUci).toBe('b4b5');
        expect(result.review.bestMoveUci).toBeTruthy();
        expect(result.review.comparison?.bestGapCp).toBe(120);
    });
});
