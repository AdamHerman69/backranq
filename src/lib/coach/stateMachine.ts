import type { CoachGamePhase } from '@/lib/coach/types';

const ACTIVE_PHASES: readonly CoachGamePhase[] = [
    'starting',
    'preparing',
    'player',
    'checking',
    'confirming',
    'bot',
    'mistake',
    'analysis',
    'gameover',
    'recovering',
];

const TRANSITIONS: Record<CoachGamePhase, readonly CoachGamePhase[]> = {
    setup: ['starting', 'recovering', 'error'],
    starting: ['preparing', 'bot', 'gameover', 'error', 'setup'],
    preparing: ['player', 'gameover', 'error', 'setup'],
    player: ['checking', 'gameover', 'error', 'setup'],
    checking: [
        'confirming',
        'bot',
        'mistake',
        'gameover',
        'error',
        'setup',
    ],
    confirming: ['bot', 'mistake', 'gameover', 'error', 'setup'],
    bot: ['preparing', 'gameover', 'error', 'setup'],
    mistake: ['player', 'analysis', 'bot', 'gameover', 'error', 'setup'],
    analysis: ['mistake', 'error', 'setup'],
    gameover: ['starting', 'setup'],
    recovering: [
        'preparing',
        'checking',
        'bot',
        'mistake',
        'gameover',
        'error',
        'setup',
    ],
    error: ['recovering', 'setup'],
};

export function canTransitionCoachPhase(
    from: CoachGamePhase,
    to: CoachGamePhase
): boolean {
    if (from === to) return true;
    if (to === 'error' && ACTIVE_PHASES.includes(from)) return true;
    return TRANSITIONS[from].includes(to);
}

export function assertCoachPhaseTransition(
    from: CoachGamePhase,
    to: CoachGamePhase
): CoachGamePhase {
    if (!canTransitionCoachPhase(from, to)) {
        throw new Error(`Invalid coach phase transition: ${from} -> ${to}`);
    }
    return to;
}
