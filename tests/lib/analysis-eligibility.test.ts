import { describe, expect, it } from 'vitest';
import {
    autoAnalysisRulesFromPreferences,
    evaluateAutoAnalysisEligibility,
} from '@/lib/services/analysisEligibility';
import { defaultPreferences, mergePreferences } from '@/lib/preferences';

const longLoss = {
    provider: 'lichess' as const,
    result: '0-1',
    timeClass: 'rapid' as const,
    rated: true,
    pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 0-1',
    white: { name: 'Ada' },
    black: { name: 'Bob' },
    sourceUsername: 'Ada',
    userSide: 'WHITE' as const,
};

function enabledPreferences() {
    return mergePreferences(defaultPreferences(), {
        gameAutomation: {
            rules: {
                lichess: { rapid: 'AUTO_ANALYZE' },
            },
            analysis: {
                resultScope: 'draws',
                ratedOnly: true,
                minPlies: 10,
                existingGames: 'all',
            },
        },
    });
}

describe('auto analysis eligibility', () => {
    it('is disabled by default', () => {
        const rules = autoAnalysisRulesFromPreferences(defaultPreferences());
        expect(rules.enabled).toBe(false);
        expect(
            evaluateAutoAnalysisEligibility({
                preferences: defaultPreferences(),
                game: longLoss,
            })
        ).toMatchObject({ eligible: false, reason: 'disabled' });
    });

    it('accepts matching losses when the exact cell is Import + analyze', () => {
        const result = evaluateAutoAnalysisEligibility({
            preferences: enabledPreferences(),
            game: longLoss,
        });
        expect(result.eligible).toBe(true);
        expect(result.priority).toBeGreaterThan(0);
    });

    it('rejects Import only and provider-specific mismatches', () => {
        const preferences = enabledPreferences();
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, timeClass: 'blitz' },
            }).reason
        ).toBe('automation-mode');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, provider: 'chesscom' },
            }).reason
        ).toBe('automation-mode');
    });

    it('rejects games outside rated and length rules', () => {
        const preferences = enabledPreferences();
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, rated: false },
            }).reason
        ).toBe('rated-only');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences,
                game: { ...longLoss, pgn: '1. e4 e5 0-1' },
            }).reason
        ).toBe('min-plies');
    });

    it('uses enabledAt only for new imported games', () => {
        const enabledAt = '2026-07-10T00:00:00.000Z';
        const base = mergePreferences(enabledPreferences(), {
            gameAutomation: {
                analysis: { enabledAt, existingGames: 'new' },
            },
        });
        const game = {
            ...longLoss,
            createdAt: '2026-07-09T23:59:59.000Z',
        };

        expect(
            evaluateAutoAnalysisEligibility({
                preferences: base,
                game,
            }).reason
        ).toBe('before-enabled');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences: mergePreferences(base, {
                    gameAutomation: {
                        analysis: { existingGames: 'all' },
                    },
                }),
                game,
            }).eligible
        ).toBe(true);
    });

    it('does not classify a draw until provider identity matches a player', () => {
        const game = { ...longLoss, result: '1/2-1/2' };
        expect(
            evaluateAutoAnalysisEligibility({
                preferences: enabledPreferences(),
                game: { ...game, sourceUsername: 'SomeoneElse' },
            }).reason
        ).toBe('result-scope');
        expect(
            evaluateAutoAnalysisEligibility({
                preferences: enabledPreferences(),
                game,
            }).eligible
        ).toBe(true);
    });
});
