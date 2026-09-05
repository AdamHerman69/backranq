import { expect, test, type Page } from '@playwright/test';

import type { OnboardingGamesResponse } from '../../src/lib/onboarding/contracts';
import { WARMUP_PUZZLE } from '../../src/lib/onboarding/warmupPuzzle';
import { clickMove, waitForBoard } from './support/board';

test.use({ storageState: { cookies: [], origins: [] } });

// A short, legal game with one unambiguous missed mate. The actual browser
// Stockfish worker and extraction pipeline run; only provider I/O is stubbed.
const gamesResponse: OnboardingGamesResponse = {
    requestId: 'landing-handoff-test',
    identity: { provider: 'chesscom', username: 'public-player' },
    games: [{
        id: 'chesscom:landing-missed-mate',
        provider: 'chesscom',
        url: 'https://www.chess.com/game/live/1',
        playedAt: '2026-09-01T00:00:00Z',
        timeClass: 'blitz',
        white: { name: 'opponent' },
        black: { name: 'public-player' },
        provenance: { username: 'public-player', userSide: 'black' },
        pgn: '[White "opponent"]\n[Black "public-player"]\n[Result "*"]\n\n1. f3 e5 2. g4 Nc6 3. Nc3 Nf6 *',
    }],
};

async function prepare(page: Page) {
    const events: string[] = [];
    await page.route('**/api/onboarding/events', async (route) => {
        events.push(route.request().postDataJSON().eventName);
        await route.fulfill({ json: { ok: true } });
    });
    await page.route('**/api/onboarding/games', (route) =>
        route.fulfill({ json: gamesResponse })
    );
    return events;
}

async function findPosition(page: Page) {
    await page.getByRole('combobox', { name: 'Chess provider' })
        .selectOption('chesscom');
    await page.getByRole('textbox', { name: 'Public chess username' })
        .fill('public-player');
    await page.getByRole('button', { name: 'Find a position from my games' }).click();
}

test('shows the personal result automatically and ignores a late master response', async ({ page }) => {
    const events = await prepare(page);
    let releaseMaster!: () => void;
    const masterGate = new Promise<void>((resolve) => { releaseMaster = resolve; });
    await page.route('**/api/master-puzzle', async (route) => {
        await masterGate;
        await route.fulfill({ json: {
            state: 'ready',
            publication: {
                id: 'late-master',
                headline: 'Late master position',
                prompt: WARMUP_PUZZLE.prompt,
            },
        } });
    });
    try {
        await page.goto('/');
        await waitForBoard(page);
        await findPosition(page);
        await expect(page.getByRole('heading', { name: 'A position you actually played' }))
            .toBeVisible({ timeout: 30_000 });
        await expect.poll(() => events.filter((event) => event === 'PERSONAL_PUZZLE_SHOWN').length)
            .toBe(1);
        expect(events).not.toContain('PERSONAL_READY_NOTICE_SHOWN');
        const masterResponse = page.waitForResponse('**/api/master-puzzle');
        releaseMaster();
        await masterResponse;
        // Finish a real move after the late fetch, proving that the personal
        // player stayed mounted and still grades the generated solution.
        await clickMove(page, 'd8', 'h4');
        await expect(page.getByText('Best move — well found.')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'A position you actually played' })).toBeVisible();
        expect(events).not.toContain('MASTER_PUZZLE_SHOWN');
    } finally {
        releaseMaster();
    }
});

test('offers a visible switch without discarding unfinished warm-up input', async ({ page }) => {
    const events = await prepare(page);
    await page.route('**/api/master-puzzle', (route) =>
        route.fulfill({ json: { state: 'unavailable' } })
    );
    await page.goto('/');
    await waitForBoard(page);
    await page.getByText('Enter a move with the keyboard', { exact: true }).click();
    const moveInput = page.getByRole('textbox', { name: 'Chess move in SAN or coordinate notation' });
    await moveInput.fill('Qe7');
    await findPosition(page);
    await expect(page.getByRole('button', { name: 'Solve my position' }))
        .toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Quick warm-up: find the clean finish' })).toBeVisible();
    await expect(moveInput).toHaveValue('Qe7');
    await expect.poll(() => events.filter((event) => event === 'PERSONAL_READY_NOTICE_SHOWN').length)
        .toBe(1);
    expect(events).not.toContain('PERSONAL_PUZZLE_SHOWN');
    await page.getByRole('button', { name: 'Solve my position' }).click();
    await expect(page.getByRole('heading', { name: 'A position you actually played' })).toBeVisible();
    await clickMove(page, 'd8', 'h4');
    await expect(page.getByText('Best move — well found.')).toBeVisible();
    await expect.poll(() => events.filter((event) => event === 'PERSONAL_PUZZLE_SHOWN').length)
        .toBe(1);
});
