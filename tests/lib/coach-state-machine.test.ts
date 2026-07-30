import { describe, expect, it } from 'vitest';

import {
    assertCoachPhaseTransition,
    canTransitionCoachPhase,
} from '@/lib/coach/stateMachine';
import type { CoachGamePhase } from '@/lib/coach/types';

function expectFlow(phases: CoachGamePhase[]) {
    for (let index = 1; index < phases.length; index += 1) {
        expect(
            canTransitionCoachPhase(phases[index - 1]!, phases[index]!)
        ).toBe(true);
    }
}

describe('coach phase state machine', () => {
    it('supports the normal player-first verification and review flow', () => {
        expectFlow([
            'setup',
            'starting',
            'preparing',
            'player',
            'checking',
            'confirming',
            'mistake',
            'analysis',
            'mistake',
            'bot',
            'preparing',
            'player',
        ]);
    });

    it('supports a bot-first game, clean decision, and terminal flow', () => {
        expectFlow([
            'setup',
            'starting',
            'bot',
            'preparing',
            'player',
            'checking',
            'bot',
            'gameover',
            'starting',
        ]);
    });

    it('supports recovery only through explicit safe resume phases', () => {
        for (const target of [
            'preparing',
            'checking',
            'bot',
            'mistake',
            'gameover',
            'error',
            'setup',
        ] satisfies CoachGamePhase[]) {
            expect(canTransitionCoachPhase('recovering', target)).toBe(true);
        }
        expect(canTransitionCoachPhase('error', 'recovering')).toBe(true);
        expect(canTransitionCoachPhase('recovering', 'player')).toBe(false);
        expect(canTransitionCoachPhase('recovering', 'analysis')).toBe(false);
    });

    it('allows errors from active work and setup abandonment', () => {
        for (const phase of [
            'starting',
            'preparing',
            'player',
            'checking',
            'confirming',
            'bot',
            'mistake',
            'analysis',
            'recovering',
        ] satisfies CoachGamePhase[]) {
            expect(canTransitionCoachPhase(phase, 'error')).toBe(true);
            expect(canTransitionCoachPhase(phase, 'setup')).toBe(true);
        }
    });

    it('rejects unsafe shortcuts and reports their exact edge', () => {
        expect(canTransitionCoachPhase('setup', 'player')).toBe(false);
        expect(canTransitionCoachPhase('analysis', 'bot')).toBe(false);
        expect(canTransitionCoachPhase('gameover', 'mistake')).toBe(false);
        expect(canTransitionCoachPhase('error', 'player')).toBe(false);
        expect(() =>
            assertCoachPhaseTransition('analysis', 'bot')
        ).toThrow('Invalid coach phase transition: analysis -> bot');
    });

    it('accepts idempotent transitions and returns the target phase', () => {
        expect(canTransitionCoachPhase('player', 'player')).toBe(true);
        expect(assertCoachPhaseTransition('checking', 'confirming')).toBe(
            'confirming'
        );
    });
});
