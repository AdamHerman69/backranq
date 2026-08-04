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
    it('describes HIGH_CONFIDENCE as major-position coverage', () => {
        expect(TRAINING_COVERAGE_OPTION_LABELS.HIGH_CONFIDENCE).toBe(
            'Major positions only'
        );
    });

    it('accepts the bounded application defaults', () => {
        expect(
            analysisDefaultsAreValid(
                pickAnalysisDefaults(defaultPreferences())
            )
        ).toBe(true);
    });

    it('rejects an unknown quality', () => {
        const defaults = pickAnalysisDefaults(defaultPreferences());
        expect(
            analysisDefaultsAreValid({
                ...defaults,
                analysisQuality: 'DEEP' as never,
            })
        ).toBe(false);
    });

    it('accepts both public quality profiles', () => {
        expect(
            analysisDefaultsAreValid({
                ...pickAnalysisDefaults(defaultPreferences()),
                analysisQuality: 'STANDARD',
            })
        ).toBe(true);
    });

    it('detects dirty analysis defaults before enabling persistence', () => {
        const defaults = pickAnalysisDefaults(defaultPreferences());
        expect(analysisDefaultsEqual(defaults, { ...defaults })).toBe(true);
        expect(
            analysisDefaultsEqual(defaults, {
                ...defaults,
                analysisQuality: 'STANDARD',
            })
        ).toBe(false);
    });
});
