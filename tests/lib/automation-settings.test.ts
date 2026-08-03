import { describe, expect, it } from 'vitest';

import {
    automationDraftFromPreferences,
    automationPreferencesPatch,
    validateAutomationDraft,
} from '@/components/settings/AutoSyncSettingsCard';
import { defaultPreferences } from '@/lib/preferences';

describe('automation settings', () => {
    it('serializes one mode per provider and time control', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.rules.lichess.bullet = 'IGNORE';
        draft.rules.lichess.blitz = 'IMPORT_ONLY';
        draft.rules.lichess.rapid = 'AUTO_ANALYZE';

        expect(automationPreferencesPatch(draft).gameAutomation.rules.lichess)
            .toMatchObject({
                bullet: 'IGNORE',
                blitz: 'IMPORT_ONLY',
                rapid: 'AUTO_ANALYZE',
            });
    });

    it('serializes explicit analysis eligibility, budget and backlog choices', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.analysis = {
            ...draft.analysis,
            resultScope: 'losses',
            ratedOnly: true,
            minPlies: '24',
            dailyCap: '5',
            monthlyCap: '',
            reserveCredits: '12',
            existingGames: 'all',
        };

        expect(validateAutomationDraft(draft)).toBeNull();
        expect(automationPreferencesPatch(draft).gameAutomation.analysis)
            .toMatchObject({
                resultScope: 'losses',
                ratedOnly: true,
                minPlies: 24,
                dailyCap: 5,
                monthlyCap: null,
                reserveCredits: 12,
                existingGames: 'all',
            });
    });

    it('requires a bounded credit reserve', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.analysis.reserveCredits = '';
        expect(validateAutomationDraft(draft)).toContain('Credit reserve');
    });

    it('matches the canonical personal-cap bounds and cross-field rule', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.analysis.dailyCap = '10001';
        expect(validateAutomationDraft(draft)).toContain('Daily personal cap');

        draft.analysis.dailyCap = '100';
        draft.analysis.monthlyCap = '50';
        expect(validateAutomationDraft(draft)).toContain(
            'cannot exceed the monthly'
        );

        draft.analysis.dailyCap = '50';
        draft.analysis.monthlyCap = '100000';
        draft.analysis.reserveCredits = '100000';
        expect(validateAutomationDraft(draft)).toBeNull();
    });

    it('accepts the canonical zero-ply minimum and rejects a blank minimum', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.analysis.minPlies = '0';
        expect(validateAutomationDraft(draft)).toBeNull();

        draft.analysis.minPlies = '';
        expect(validateAutomationDraft(draft)).toContain('Minimum game length');
    });
});
