import { describe, expect, it } from 'vitest';

import {
    TRAINING_COVERAGE_OPTION_LABELS,
    analysisDefaultsAreValid,
} from '@/components/analysis/AnalysisDefaultsFields';
import {
    defaultPreferences,
    pickAnalysisDefaults,
} from '@/lib/preferences';
import { analysisDefaultsEqual } from '@/components/settings/AnalysisDefaultsCard';

describe('analysis defaults field validation', () => {
    it('describes HIGH_CONFIDENCE as major-moment coverage', () => {
        expect(TRAINING_COVERAGE_OPTION_LABELS.HIGH_CONFIDENCE).toBe(
            'Major moments only'
        );
    });

    it('accepts the bounded application defaults', () => {
        expect(
            analysisDefaultsAreValid(
                pickAnalysisDefaults(defaultPreferences())
            )
        ).toBe(true);
    });

    it('rejects invalid advanced analysis budgets', () => {
        const defaults = pickAnalysisDefaults(defaultPreferences());

        expect(
            analysisDefaultsAreValid({
                ...defaults,
                analysisNodesPerPosition: '999',
            })
        ).toBe(false);
        expect(
            analysisDefaultsAreValid({
                ...defaults,
                confirmationNodes: '20000001',
            })
        ).toBe(false);
        expect(
            analysisDefaultsAreValid({
                ...defaults,
                themeLookaheadPlies: '3.5',
            })
        ).toBe(false);
    });

    it('allows confirmation to be disabled with a blank value', () => {
        expect(
            analysisDefaultsAreValid({
                ...pickAnalysisDefaults(defaultPreferences()),
                confirmationNodes: '',
            })
        ).toBe(true);
    });

    it('detects dirty analysis defaults before enabling persistence', () => {
        const defaults = pickAnalysisDefaults(defaultPreferences());
        expect(analysisDefaultsEqual(defaults, { ...defaults })).toBe(true);
        expect(
            analysisDefaultsEqual(defaults, {
                ...defaults,
                trainingCoveragePreset: 'HIGH_CONFIDENCE',
            })
        ).toBe(false);
    });
});
