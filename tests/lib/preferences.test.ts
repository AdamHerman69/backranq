import { describe, expect, it } from 'vitest';
import {
    analysisDefaultsToExtractOptions,
    canonicalPreferences,
    defaultPreferences,
    mergePreferences,
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

    it('uses the nested auto-analysis policy as the only enabled flag', () => {
        const preferences = mergePreferences(defaultPreferences(), {
            autoAnalysis: { enabled: false },
        });

        expect(preferences.autoAnalysis.enabled).toBe(false);
    });

    it('canonicalizes the nested auto-analysis policy', () => {
        const preferences = canonicalPreferences({
            autoSyncProviders: { lichess: false, chesscom: true },
            autoAnalysis: {
                enabled: true,
                providers: { lichess: true, chesscom: false },
                timeControls: { rapid: true },
                resultScope: 'losses',
                ratedOnly: false,
                minPlies: 14,
                dailyCap: 3,
                monthlyCap: 20,
            },
        });

        expect(preferences.autoAnalysis).toMatchObject({
            enabled: true,
            providers: { lichess: true, chesscom: false },
            timeControls: {
                bullet: false,
                blitz: false,
                rapid: true,
                classical: true,
                unknown: false,
            },
            resultScope: 'losses',
            ratedOnly: false,
            minPlies: 14,
            dailyCap: 3,
            monthlyCap: 20,
        });
    });

    it('replaces malformed persisted automation values with safe defaults', () => {
        const preferences = canonicalPreferences({
            autoAnalysis: {
                enabled: false,
                providers: 'all',
                timeControls: { rapid: 'yes' },
                minPlies: -1,
                dailyCap: 0,
                monthlyCap: Number.POSITIVE_INFINITY,
                reserveCredits: -5,
                backlogMode: 'surprise-me',
                enabledAt: 'not-a-date',
            },
        });

        expect(preferences.autoAnalysis).toEqual({
            ...defaultPreferences().autoAnalysis,
            enabled: false,
        });
    });

});
