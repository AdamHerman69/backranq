import { describe, expect, it } from 'vitest';
import {
    autoAnalysisRulesFromPreferences,
    evaluateAutoAnalysisEligibility,
} from '@/lib/services/analysisEligibility';
import { defaultPreferences } from '@/lib/preferences';

const longLoss = {
    provider: 'lichess' as const,
    result: '0-1',
    timeClass: 'rapid' as const,
    rated: true,
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 0-1',
    white: { name: 'Ada' },
    black: { name: 'Bob' },
};

describe('auto analysis eligibility', () => {
    it('is disabled by default', () => {
        const rules = autoAnalysisRulesFromPreferences(defaultPreferences());
        expect(rules.enabled).toBe(false);

        const result = evaluateAutoAnalysisEligibility({
            preferences: defaultPreferences(),
            game: longLoss,
            username: 'Ada',
        });

        expect(result).toMatchObject({ eligible: false, reason: 'disabled' });
    });

    it('accepts matching losses and draws when explicitly enabled', () => {
        const preferences = {
            ...defaultPreferences(),
            autoAnalysis: {
                enabled: true,
                resultScope: 'draws',
                ratedOnly: true,
                minPlies: 10,
                providers: { lichess: true, chesscom: false },
                timeControls: { rapid: true },
            },
        };

        const result = evaluateAutoAnalysisEligibility({
            preferences,
            game: longLoss,
            username: 'Ada',
        });

        expect(result.eligible).toBe(true);
        expect(result.priority).toBeGreaterThan(0);
    });

    it('rejects games outside provider, time, rated, and length rules', () => {
        const preferences = {
            ...defaultPreferences(),
            autoAnalysis: {
                enabled: true,
                resultScope: 'all',
                ratedOnly: true,
                minPlies: 20,
                providers: { lichess: true, chesscom: false },
                timeControls: { rapid: true },
            },
        };

        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, provider: 'chesscom' },
                username: 'Ada',
            }).reason
        ).toBe('provider');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, timeClass: 'bullet' },
                username: 'Ada',
            }).reason
        ).toBe('time-control');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, rated: false },
                username: 'Ada',
            }).reason
        ).toBe('rated-only');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, pgn: '1. e4 e5 0-1' },
                username: 'Ada',
            }).reason
        ).toBe('min-plies');
    });

    it('keeps analysis providers independent from sync providers', () => {
        const preferences = {
            ...defaultPreferences(),
            autoSyncProviders: { lichess: false, chesscom: true },
            autoAnalysis: {
                ...defaultPreferences().autoAnalysis,
                enabled: true,
                backlogMode: 'all' as const,
                providers: { lichess: true, chesscom: false },
                timeControls: {
                    ...defaultPreferences().autoAnalysis.timeControls,
                    rapid: true,
                },
                minPlies: 10,
            },
        };

        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: longLoss,
                usernameByProvider: { lichess: 'Ada' },
            }).eligible
        ).toBe(true);
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, provider: 'chesscom' },
                usernameByProvider: { chesscom: 'Ada' },
            }).reason
        ).toBe('provider');
    });

    it('uses enabledAt only for the new-games backlog mode', () => {
        const enabledAt = '2026-07-10T00:00:00.000Z';
        const base = {
            ...defaultPreferences(),
            autoAnalysis: {
                ...defaultPreferences().autoAnalysis,
                enabled: true,
                enabledAt,
                providers: { lichess: true, chesscom: false },
                minPlies: 10,
            },
        };

        expect(
            evaluateAutoAnalysisEligibility({
                preferences: {
                    ...base,
                    autoAnalysis: {
                        ...base.autoAnalysis,
                        backlogMode: 'new',
                    },
                },
                game: {
                    ...longLoss,
                    createdAt: '2026-07-09T23:59:59.000Z',
                },
                username: 'Ada',
            }).reason
        ).toBe('before-enabled');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences: {
                    ...base,
                    autoAnalysis: {
                        ...base.autoAnalysis,
                        backlogMode: 'all',
                    },
                },
                game: {
                    ...longLoss,
                    createdAt: '2026-07-09T23:59:59.000Z',
                },
                username: 'Ada',
            }).eligible
        ).toBe(true);
    });

    it('does not classify a draw until provider identity matches a player', () => {
        const preferences = {
            ...defaultPreferences(),
            autoAnalysis: {
                ...defaultPreferences().autoAnalysis,
                enabled: true,
                backlogMode: 'all' as const,
                resultScope: 'draws' as const,
                ratedOnly: false,
                minPlies: 0,
            },
        };

        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: {
                    ...longLoss,
                    result: '1/2-1/2',
                },
                username: 'SomeoneElse',
            }).reason
        ).toBe('result-scope');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: {
                    ...longLoss,
                    result: '1/2-1/2',
                },
                username: 'Ada',
            }).eligible
        ).toBe(true);
    });
});
