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
        personal: { status: 'IDLE' as const },
        handoff: 'HIDDEN' as const,
    };
}

describe('landing dual-onboarding state', () => {
    it('stores a ready personal puzzle without interrupting the active puzzle', () => {
        const searching = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED',
            runId: 'run-current',
            identity,
        });
        const ready = landingOnboardingReducer(searching, {
            type: 'PERSONAL_READY',
            runId: 'run-current',
            puzzle: personalPuzzle,
        });

        expect(ready.activePuzzle.id).toBe(WARMUP_PUZZLE.id);
        expect(ready.handoff).toBe('ARMED');
        expect(ready.personal.status).toBe('READY');
    });

    it('offers the handoff only at terminal, then swaps on explicit acceptance', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED',
            runId: 'run-current',
            identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY',
            runId: 'run-current',
            puzzle: personalPuzzle,
        });
        state = landingOnboardingReducer(state, { type: 'MASTER_TERMINAL' });
        expect(state.handoff).toBe('OFFERED');
        expect(state.activePuzzle.id).toBe(WARMUP_PUZZLE.id);

        state = landingOnboardingReducer(state, { type: 'ACCEPT_HANDOFF' });
        expect(state.activePuzzle.id).toBe(personalPuzzle.id);
        expect(state.handoff).toBe('HIDDEN');
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

    it('keeps a ready personal puzzle armed when the master puzzle arrives late', () => {
        let state = landingOnboardingReducer(initial(), {
            type: 'SEARCH_STARTED',
            runId: 'run-current',
            identity,
        });
        state = landingOnboardingReducer(state, {
            type: 'PERSONAL_READY',
            runId: 'run-current',
            puzzle: personalPuzzle,
        });

        state = landingOnboardingReducer(state, {
            type: 'RESET_MASTER',
            puzzle: { ...WARMUP_PUZZLE, id: 'master:late' },
        });
        state = landingOnboardingReducer(state, { type: 'MASTER_TERMINAL' });

        expect(state.activePuzzle.id).toBe('master:late');
        expect(state.handoff).toBe('OFFERED');
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
        expect(state.handoff).toBe('ARMED');

        state = landingOnboardingReducer(state, { type: 'MASTER_TERMINAL' });
        expect(state.handoff).toBe('OFFERED');
    });
});
