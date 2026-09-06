import { describe, expect, it } from 'vitest';

import type { LandingPuzzleDto, OnboardingAnalysisProgress } from '@/lib/onboarding/contracts';
import { landingOnboardingReducer } from '@/lib/onboarding/state';
import { WARMUP_PUZZLE } from '@/lib/onboarding/warmupPuzzle';

const identity = { provider: 'lichess', username: 'public-player' } as const;
const personalPuzzle: LandingPuzzleDto = {
    ...WARMUP_PUZZLE,
    id: 'personal:verified-position',
    context: { ...WARMUP_PUZZLE.context, kind: 'PERSONAL', headline: 'A position you actually played' },
};
function initial() {
    return {
        activePuzzle: WARMUP_PUZZLE,
        masterTerminal: false,
        activePuzzleInteracted: false,
        personal: { status: 'IDLE' as const },
    };
}
function searching() {
    return landingOnboardingReducer(initial(), { type: 'SEARCH_STARTED', runId: 'run', identity });
}
const progress: OnboardingAnalysisProgress = {
    phase: 'SCANNING', gameIndex: 0, gameCount: 2, ply: 0, plyCount: 10,
    preview: { gameId: 'game', fen: 'before', orientation: 'black', whiteName: 'opponent', blackName: 'public-player', playedAt: '2026-09-01' },
};

describe('landing personal scan state', () => {
    it.each([false, true])('automatically replaces an introduction, interacted=%s', (interacted) => {
        let state = landingOnboardingReducer({ ...initial(), activePuzzleInteracted: interacted }, {
            type: 'SEARCH_STARTED', runId: 'run', identity,
        });
        state = landingOnboardingReducer(state, { type: 'PERSONAL_READY', runId: 'run', puzzle: personalPuzzle });
        expect(state.activePuzzle.id).toBe(personalPuzzle.id);
        expect(state.activePuzzleInteracted).toBe(false);
        expect(state.personal.status).toBe('READY');
    });

    it('replaces an earlier personal puzzle when a new search completes', () => {
        let state = landingOnboardingReducer(searching(), { type: 'PERSONAL_READY', runId: 'run', puzzle: personalPuzzle });
        state = landingOnboardingReducer(state, { type: 'SEARCH_STARTED', runId: 'next', identity });
        state = landingOnboardingReducer(state, { type: 'PERSONAL_READY', runId: 'next', puzzle: { ...personalPuzzle, id: 'next-puzzle' } });
        expect(state.activePuzzle.id).toBe('next-puzzle');
    });

    it('ignores obsolete runs and queued progress after success, failure or empty results', () => {
        const state = searching();
        expect(landingOnboardingReducer(state, { type: 'PERSONAL_READY', runId: 'old', puzzle: personalPuzzle })).toBe(state);
        expect(landingOnboardingReducer(state, { type: 'ANALYSIS_PROGRESS', runId: 'old', progress })).toBe(state);
        const terminals = [
            landingOnboardingReducer(state, { type: 'PERSONAL_READY', runId: 'run', puzzle: personalPuzzle }),
            landingOnboardingReducer(state, { type: 'SEARCH_EMPTY', runId: 'run', reason: 'NO_GAMES' }),
            landingOnboardingReducer(state, { type: 'SEARCH_FAILED', runId: 'run', reason: 'UNKNOWN', retryable: true }),
        ];
        for (const terminal of terminals) {
            expect(landingOnboardingReducer(terminal, { type: 'ANALYSIS_PROGRESS', runId: 'run', progress })).toBe(terminal);
        }
    });

    it('only animates adjacent scanned positions from the same game', () => {
        const state = landingOnboardingReducer(searching(), { type: 'ANALYSIS_PROGRESS', runId: 'run', progress });
        const next: OnboardingAnalysisProgress = { ...progress, ply: 1, preview: { ...progress.preview!, fen: 'after', previousFen: 'before' } };
        const advanced = landingOnboardingReducer(state, { type: 'ANALYSIS_PROGRESS', runId: 'run', progress: next });
        expect(advanced.personal.status === 'ANALYZING' && advanced.personal.animationMs).toBe(100);
        for (const jump of [
            { ...next, ply: 3 },
            { ...next, phase: 'CONFIRMING' as const },
            { ...next, preview: { ...next.preview!, gameId: 'other' } },
        ]) {
            const result = landingOnboardingReducer(state, { type: 'ANALYSIS_PROGRESS', runId: 'run', progress: jump });
            expect(result.personal.status === 'ANALYZING' && result.personal.animationMs).toBe(0);
        }
    });

    it('accepts master loading only before personal search and before interaction', () => {
        const reset = { type: 'RESET_MASTER' as const, puzzle: { ...WARMUP_PUZZLE, id: 'master:late' } };
        expect(landingOnboardingReducer(initial(), reset).activePuzzle.id).toBe('master:late');
        const active = landingOnboardingReducer(initial(), { type: 'PUZZLE_INTERACTED', puzzleId: WARMUP_PUZZLE.id });
        expect(landingOnboardingReducer(active, reset)).toBe(active);
        const state = searching();
        expect(landingOnboardingReducer(state, reset)).toBe(state);
        const ready = landingOnboardingReducer(state, { type: 'PERSONAL_READY', runId: 'run', puzzle: personalPuzzle });
        expect(landingOnboardingReducer(ready, reset)).toBe(ready);
    });
});
