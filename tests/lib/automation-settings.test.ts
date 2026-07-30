import { describe, expect, it } from 'vitest';

import {
    automationDraftFromPreferences,
    automationPreferencesPatch,
    validateAutomationDraft,
} from '@/components/settings/AutoSyncSettingsCard';
import { defaultPreferences } from '@/lib/preferences';

describe('automation settings', () => {
    it('keeps import and server analysis as independent policies', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.autoSyncEnabled = true;
        draft.autoAnalysis.enabled = false;

        expect(automationPreferencesPatch(draft)).toMatchObject({
            autoSyncEnabled: true,
            autoAnalysis: { enabled: false },
        });
    });

    it('serializes explicit analysis eligibility, budget and backlog choices', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.autoAnalysis = {
            ...draft.autoAnalysis,
            enabled: true,
            providers: { lichess: true, chesscom: false },
            resultScope: 'losses',
            ratedOnly: true,
            minPlies: '24',
            dailyCap: '5',
            monthlyCap: '',
            reserveCredits: '12',
            backlogMode: 'all',
        };

        expect(validateAutomationDraft(draft)).toBeNull();
        expect(automationPreferencesPatch(draft).autoAnalysis).toMatchObject({
            enabled: true,
            providers: { lichess: true, chesscom: false },
            resultScope: 'losses',
            ratedOnly: true,
            minPlies: 24,
            dailyCap: 5,
            monthlyCap: null,
            reserveCredits: 12,
            backlogMode: 'all',
        });
    });

    it('rejects accidental unbounded or empty automatic-analysis scopes', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.autoAnalysis.enabled = true;
        draft.autoAnalysis.providers = {
            lichess: false,
            chesscom: false,
        };
        expect(validateAutomationDraft(draft)).toContain('source');

        draft.autoAnalysis.providers.lichess = true;
        draft.autoAnalysis.reserveCredits = '';
        expect(validateAutomationDraft(draft)).toContain('Credit reserve');
    });

    it('matches the canonical personal-cap bounds and cross-field rule', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.autoAnalysis.dailyCap = '10001';
        expect(validateAutomationDraft(draft)).toContain('Daily personal cap');

        draft.autoAnalysis.dailyCap = '100';
        draft.autoAnalysis.monthlyCap = '50';
        expect(validateAutomationDraft(draft)).toContain(
            'cannot exceed the monthly'
        );

        draft.autoAnalysis.dailyCap = '50';
        draft.autoAnalysis.monthlyCap = '100000';
        draft.autoAnalysis.reserveCredits = '100000';
        expect(validateAutomationDraft(draft)).toBeNull();
    });

    it('accepts the canonical zero-ply minimum and rejects a blank minimum', () => {
        const draft = automationDraftFromPreferences(defaultPreferences());
        draft.autoAnalysis.minPlies = '0';
        expect(validateAutomationDraft(draft)).toBeNull();

        draft.autoAnalysis.minPlies = '';
        expect(validateAutomationDraft(draft)).toContain(
            'Minimum game length'
        );
    });
});
