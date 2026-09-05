import { describe, expect, it } from 'vitest';

import type { LandingPuzzleDto } from '@/lib/onboarding/contracts';
import { landingOnboardingReducer } from '@/lib/onboarding/state';
import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';

const identity = { provider: 'lichess', username: 'public-player' } as const;
const personalPuzzle: LandingPuzzleDto = {
    ...WARMUP_PUZZLE,
    id: 'personal:verified-position',
    context: {
        ...WARMUP_PUZZLE.context,
        kind: 'PERSONAL',
        headline: 'A position you actually played',
    },
};

function initial() {
    return {
        activePuzzle: WARMUP_PUZZLE,
        masterTerminal: false,
        activePuzzleInteracted: false,
        personal: { status: 'IDLE' as const },
        handoff: 'HIDDEN' as const,
    };
}

describe('landing dual-onboarding state', () => {
    it('shows the personal puzzle immediately when the introduction is untouched', () => {
        const searching = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED', runId: 'run-current', identity,
        });
        const ready = landingOnboardingReducer(searching, {
            type: 'PERSONAL_READY', runId: 'run-current', puzzle: personalPuzzle,
        });
        expect(ready.activePuzzle.id).toBe(personalPuzzle.id);
        expect(ready.handoff).toBe('HIDDEN');
        expect(ready.personal.status).toBe('READY');
    });

    it('offers an immediate switch without interrupting a started puzzle', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED', runId: 'run-current', identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PUZZLE_INTERACTED', puzzleId: WARMUP_PUZZLE.id,
        });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY', runId: 'run-current', puzzle: personalPuzzle,
        });
        expect(state.activePuzzle.id).toBe(WARMUP_PUZZLE.id);
        expect(state.masterTerminal).toBe(false);
        expect(state.handoff).toBe('OFFERED');
        state = landingOnboardingReducer(state, { type: 'ACCEPT_HANDOFF' });
        expect(state.activePuzzle.id).toBe(personalPuzzle.id);
        expect(state.activePuzzleInteracted).toBe(false);
        expect(state.handoff).toBe('HIDDEN');
    });

    it('keeps the switch available while reviewing a finished introduction', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED', runId: 'run-current', identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PUZZLE_INTERACTED', puzzleId: WARMUP_PUZZLE.id,
        });
        state = landingOnboardingReducer(state, { type: 'MASTER_TERMINAL' });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY', runId: 'run-current', puzzle: personalPuzzle,
        });
        expect(state.activePuzzle.id).toBe(WARMUP_PUZZLE.id);
        expect(state.handoff).toBe('OFFERED');
    });

    it('ignores results from an obsolete search run', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED',
            runId: 'run-old',
            identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'SEARCH_STARTED',
            runId: 'run-new',
            identity,
        });
        const unchanged = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY',
            runId: 'run-old',
            puzzle: personalPuzzle,
        });
        expect(unchanged).toBe(state);
    });

    it('does not replace the displayed personal puzzle with a late master response', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED', runId: 'run-current', identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY', runId: 'run-current', puzzle: personalPuzzle,
        });
        const unchanged = landingOnboardingReducer(state, {
            type: 'RESET_MASTER', puzzle: { ...WARMUP_PUZZLE, id: 'master:late' },
        });
        expect(unchanged).toBe(state);
    });

    it('does not replace a started warm-up with a late master response', () => {
        const state = landingOnboardingReducer(initial(), {
            type: 'PUZZLE_INTERACTED', puzzleId: WARMUP_PUZZLE.id,
        });
        expect(landingOnboardingReducer(state, {
            type: 'RESET_MASTER', puzzle: { ...WARMUP_PUZZLE, id: 'master:late' },
        })).toBe(state);
    });

    it('does not interrupt a personal puzzle when a second scan finishes', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED',
            runId: 'run-first',
            identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY',
            runId: 'run-first',
            puzzle: personalPuzzle,
        });
        state = landingOnboardingReducer(state, { type: 'MASTER_TERMINAL' });
        state = landingOnboardingReducer(state, { type: 'ACCEPT_HANDOFF' });
        const firstPersonalId = state.activePuzzle.id;

        state = landingOnboardingReducer(state, {
            type: 'SEARCH_STARTED',
            runId: 'run-second',
            identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY',
            runId: 'run-second',
            puzzle: { ...personalPuzzle, id: 'personal:second' },
        });

        expect(state.activePuzzle.id).toBe(firstPersonalId);
        expect(state.handoff).toBe('OFFERED');

        state = landingOnboardingReducer(state, { type: 'MASTER_TERMINAL' });
        expect(state.handoff).toBe('OFFERED');
    });
});
