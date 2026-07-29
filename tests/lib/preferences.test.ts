import { describe, expect, it } from 'vitest';
import {
    analysisDefaultsToExtractOptions,
    defaultPreferences,
    pickAnalysisDefaults,
} from '@/lib/preferences';

describe('analysis preference bounds', () => {
    it('defensively replaces unsafe persisted values with bounded defaults', () => {
        const defaults = pickAnalysisDefaults(defaultPreferences());
        const options = analysisDefaultsToExtractOptions({
            ...defaults,
            analysisNodesPerPosition: '999999999',
            confirmationNodes: '999999999',
            themeLookaheadPlies: 'NaN',
        });

        expect(options).toMatchObject({
            nodesPerPosition: 100_000,
            confirmNodes: null,
            themeLookaheadPlies: 4,
        });
    });

    it('maps user coverage and grading intent to extraction', () => {
        const defaults = pickAnalysisDefaults(defaultPreferences());
        const options = analysisDefaultsToExtractOptions({
            ...defaults,
            confirmationNodes: '',
            trainingCoveragePreset: 'HIGH_CONFIDENCE',
            trainingGradingTolerance: 'STRICT',
        });

        expect(options.confirmNodes).toBeNull();
        expect(options.minWinningChanceLoss).toBe(0.12);
        expect(options.fallbackMinCpLoss).toBe(150);
        expect(options.maxAcceptedWinningChanceLoss).toBe(0.025);
        expect(options.fallbackMaxAcceptedCpLoss).toBe(25);
        expect(options.gradingPolicy?.success).toEqual({
            maxCpLoss: 25,
            maxWinChanceLoss: 0.025,
            preserveOutcome: true,
        });
        expect(options).not.toHaveProperty('maxPuzzlesPerGame');
        expect(options).not.toHaveProperty('puzzleMode');
        expect(options).not.toHaveProperty('uniquenessMarginCp');
        expect(options).not.toHaveProperty('evalBandMinCp');
        expect(options).not.toHaveProperty('evalBandMaxCp');
        expect(options).not.toHaveProperty('requireTactical');
    });

});
