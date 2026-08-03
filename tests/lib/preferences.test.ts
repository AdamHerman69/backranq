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

    it('uses one mode as the source of truth for import and analysis', () => {
        const preferences = mergePreferences(defaultPreferences(), {
            gameAutomation: {
                rules: {
                    lichess: {
                        bullet: 'IGNORE',
                        rapid: 'AUTO_ANALYZE',
                    },
                },
            },
        });

        expect(preferences.gameAutomation.rules.lichess).toMatchObject({
            bullet: 'IGNORE',
            blitz: 'IMPORT_ONLY',
            rapid: 'AUTO_ANALYZE',
        });
    });

    it('canonicalizes the unified automation policy', () => {
        const preferences = canonicalPreferences({
            gameAutomation: {
                paused: true,
                rules: {
                    lichess: { bullet: 'IGNORE', rapid: 'AUTO_ANALYZE' },
                    chesscom: { blitz: 'AUTO_ANALYZE' },
                },
                analysis: {
                    resultScope: 'losses',
                    ratedOnly: false,
                    minPlies: 14,
                    dailyCap: 3,
                    monthlyCap: 20,
                },
            },
        });

        expect(preferences.gameAutomation).toMatchObject({
            paused: true,
            rules: {
                lichess: {
                    bullet: 'IGNORE',
                    blitz: 'IMPORT_ONLY',
                    rapid: 'AUTO_ANALYZE',
                },
                chesscom: { blitz: 'AUTO_ANALYZE' },
            },
            analysis: {
                resultScope: 'losses',
                ratedOnly: false,
                minPlies: 14,
                dailyCap: 3,
                monthlyCap: 20,
            },
        });
    });

    it('replaces malformed persisted automation values with safe defaults', () => {
        const preferences = canonicalPreferences({
            gameAutomation: {
                paused: 'yes',
                rules: { lichess: { rapid: 'MAYBE' } },
                analysis: {
                    minPlies: -1,
                    dailyCap: 0,
                    monthlyCap: Number.POSITIVE_INFINITY,
                    reserveCredits: -5,
                    existingGames: 'surprise-me',
                    enabledAt: 'not-a-date',
                },
            },
        });

        expect(preferences.gameAutomation).toEqual(
            defaultPreferences().gameAutomation
        );
    });

    it('does not migrate the removed split automation settings', () => {
        const preferences = canonicalPreferences({
            autoSyncEnabled: false,
            autoAnalysis: { enabled: true },
        });

        expect(preferences.gameAutomation).toEqual(
            defaultPreferences().gameAutomation
        );
    });
});
