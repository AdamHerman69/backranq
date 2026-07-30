import { describe, expect, it } from 'vitest';

import {
    controlStateForPracticeFilters,
    filtersForPracticeFocus,
    filtersForReviewAgain,
    hasEffectivePracticeFocus,
} from '@/components/training/TrainingFocusControls';

describe('position focus controls', () => {
    it('keeps the saved source mix implicit while applying user intent', () => {
        expect(
            filtersForPracticeFocus({
                source: 'SAVED',
                impact: 'ALL',
                phase: 'ALL',
                history: 'ALL',
            })
        ).toEqual({ focus: 'ALL' });
    });

    it('maps a focused practice feed without exposing engine thresholds', () => {
        expect(
            filtersForPracticeFocus({
                source: 'MISSED_CHANCES',
                impact: 'MAJOR',
                phase: 'ENDGAME',
                history: 'FRESH',
            })
        ).toEqual({
            focus: 'MAJOR',
            sourceKinds: ['MISSED_OPPORTUNITY'],
            phases: ['ENDGAME'],
            includeAttempted: false,
        });
    });

    it('reviews fresh-only positions again without changing other focus filters', () => {
        const reviewFilters = filtersForReviewAgain({
            focus: 'MAJOR',
            sourceKinds: ['MY_MISTAKE'],
            phases: ['ENDGAME'],
            includeAttempted: false,
        });

        expect(reviewFilters).toEqual({
            focus: 'MAJOR',
            sourceKinds: ['MY_MISTAKE'],
            phases: ['ENDGAME'],
        });
        expect(
            controlStateForPracticeFilters(reviewFilters).history
        ).toBe('ALL');
    });

    it('derives truthful controls from the requested practice filters', () => {
        expect(
            controlStateForPracticeFilters({
                focus: 'MAJOR',
                sourceKinds: ['MISSED_OPPORTUNITY'],
                phases: ['ENDGAME'],
                includeAttempted: false,
            })
        ).toEqual({
            source: 'MISSED_CHANCES',
            impact: 'MAJOR',
            phase: 'ENDGAME',
            history: 'FRESH',
        });
        expect(controlStateForPracticeFilters({})).toEqual({
            source: 'SAVED',
            impact: 'ALL',
            phase: 'ALL',
            history: 'ALL',
        });
    });

    it('treats an effective saved source restriction as a filtered feed', () => {
        expect(
            hasEffectivePracticeFocus(
                {},
                { sourceKinds: ['MY_MISTAKE'] }
            )
        ).toBe(true);
        expect(hasEffectivePracticeFocus({}, {})).toBe(false);
    });
});
