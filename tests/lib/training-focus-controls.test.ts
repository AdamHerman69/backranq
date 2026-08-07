import { describe, expect, it } from 'vitest';

import {
    controlStateForPracticeFilters,
    filtersForPracticeFocus,
    hasEffectivePracticeFocus,
} from '@/components/training/TrainingFocusControls';

describe('position focus controls', () => {
    it('keeps the saved source mix implicit while applying user intent', () => {
        expect(
            filtersForPracticeFocus({
                source: 'SAVED',
                impact: 'ALL',
                phase: 'ALL',
                mode: 'RECOMMENDED',
            })
        ).toEqual({ focus: 'ALL', mode: 'RECOMMENDED' });
    });

    it('maps a focused practice feed without exposing engine thresholds', () => {
        expect(
            filtersForPracticeFocus({
                source: 'MISSED_CHANCES',
                impact: 'MAJOR',
                phase: 'ENDGAME',
                mode: 'NEW',
            })
        ).toEqual({
            focus: 'MAJOR',
            sourceKinds: ['MISSED_OPPORTUNITY'],
            phases: ['ENDGAME'],
            mode: 'NEW',
        });
    });

    it('derives truthful controls from the requested practice filters', () => {
        expect(
            controlStateForPracticeFilters({
                focus: 'MAJOR',
                sourceKinds: ['MISSED_OPPORTUNITY'],
                phases: ['ENDGAME'],
                mode: 'REVIEW',
            })
        ).toEqual({
            source: 'MISSED_CHANCES',
            impact: 'MAJOR',
            phase: 'ENDGAME',
            mode: 'REVIEW',
        });
        expect(controlStateForPracticeFilters({})).toEqual({
            source: 'SAVED',
            impact: 'ALL',
            phase: 'ALL',
            mode: 'RECOMMENDED',
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
