import path from 'node:path';

export const E2E_USER = {
    id: '00000000-0000-4000-8000-00000000e2e1',
    email: 'playwright-e2e@backranq.local',
    name: 'Backranq E2E',
    username: 'E2EHero',
} as const;

export const E2E_GAMES = {
    standard: '10000000-0000-4000-8000-00000000e2e1',
    promotion: '10000000-0000-4000-8000-00000000e2e2',
} as const;

export const E2E_PUZZLES = {
    wrongMove: '20000000-0000-4000-8000-00000000e2e1',
    dragMove: '20000000-0000-4000-8000-00000000e2e2',
    reveal: '20000000-0000-4000-8000-00000000e2e3',
    offline: '20000000-0000-4000-8000-00000000e2e4',
    promotion: '20000000-0000-4000-8000-00000000e2e5',
} as const;

export const E2E_AUTH_STATE_PATH = path.join(
    process.cwd(),
    '.playwright',
    'auth',
    'e2e-user.json'
);

export function puzzlePath(id: string) {
    return `/puzzles?puzzleId=${encodeURIComponent(id)}`;
}
