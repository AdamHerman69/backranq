import { describe, expect, it } from 'vitest';

import { filtersForTrainingFocus } from '@/components/training/TrainingFocusControls';

describe('training focus controls', () => {
    it('keeps the saved source mix implicit while applying user intent', () => {
        expect(
            filtersForTrainingFocus({
                source: 'SAVED',
                impact: 'ALL',
                phase: 'ALL',
                history: 'ALL',
            })
        ).toEqual({ focus: 'ALL' });
    });

    it('maps a focused session without exposing engine thresholds', () => {
        expect(
            filtersForTrainingFocus({
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
});
