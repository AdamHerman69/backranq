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

test('replaces started warm-up input with live scan and automatically enables the personal puzzle', async ({ page }) => {
    const events = await prepare(page);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/master-puzzle', (route) =>
        route.fulfill({ json: { state: 'unavailable' } })
    );
    // Only delivery is slowed to make intermediate frames observable; the real
    // browser Stockfish still calculates every position and final answer.
    await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
            set onmessage(handler: ((this: Worker, event: MessageEvent) => unknown) | null) {
                super.onmessage = handler ? (event) => {
                    setTimeout(() => handler.call(this, event), 80);
                } : null;
            }
        };
    });
    await page.goto('/');
    await waitForBoard(page);
    await page.getByText('Enter a move with the keyboard', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Chess move in SAN or coordinate notation' }).fill('Qe7');
    await findPosition(page);
    await expect(page.getByRole('region', { name: 'Interactive chess puzzle' })).toHaveCount(0);
    const scan = page.getByRole('group', { name: 'Game being analyzed' });
    await expect(scan).toBeVisible();
    await expect(scan).toHaveAttribute('data-scan-orientation', 'black');
    await expect(page.getByText('opponent vs public-player', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Pause game playback' }).click();
    const pausedFen = await scan.getAttribute('data-scan-fen');
    await expect(page.getByText('Playback paused · analysis continues')).toBeVisible();
    await page.waitForTimeout(300);
    await expect(scan).toHaveAttribute('data-scan-fen', pausedFen!);
    await page.getByRole('button', { name: 'Resume game playback' }).click();
    await expect(scan).toHaveAttribute('data-scan-phase', 'CONFIRMING', { timeout: 30_000 });
    const decisionFen = await scan.getAttribute('data-scan-fen');
    const persistentBoard = await page.locator('[data-board-fen]').elementHandle();
    const persistentSquare = await page.locator('[data-landing-board] [data-square="a1"]').elementHandle();
    const boardBefore = await page.locator('[data-board-fen]').boundingBox();
    await page.screenshot({ path: 'artifacts/homepage-scan-desktop.png' });
    await expect(page.getByRole('heading', { name: 'A position you actually played' }))
        .toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-board-fen]')).toHaveAttribute('data-board-fen', decisionFen!);
    // The actual board and its squares survive the handoff, with no change to
    // its size or placement. This catches a remount even when FEN is identical.
    expect(await persistentBoard!.evaluate((element) => element.isConnected)).toBe(true);
    expect(await persistentSquare!.evaluate((element) => element.isConnected)).toBe(true);
    const boardAfter = await page.locator('[data-board-fen]').boundingBox();
    expect(boardAfter).toEqual(boardBefore);
    await expect(page.getByRole('button', { name: 'Solve my position' })).toHaveCount(0);
    expect(events).not.toContain('PERSONAL_READY_NOTICE_SHOWN');
    await clickMove(page, 'd8', 'h4');
    await expect(page.getByText('Best move — well found.')).toBeVisible();
    expect(errors).toEqual([]);
});

test('clears the replaced puzzle on empty/error searches and permits retry on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await prepare(page);
    await page.route('**/api/master-puzzle', (route) => route.fulfill({ json: { state: 'unavailable' } }));
    let attempt = 0;
    await page.route('**/api/onboarding/games', (route) => {
        attempt++;
        if (attempt === 2) return route.fulfill({ status: 503, json: { code: 'PROVIDER_UNAVAILABLE', retryable: true } });
        return route.fulfill({ json: attempt === 1 ? { ...gamesResponse, games: [] } : gamesResponse });
    });
    await page.goto('/');
    await findPosition(page);
    await expect(page.getByRole('heading', { name: 'No personal position found' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Interactive chess puzzle' })).toHaveCount(0);
    await findPosition(page);
    await expect(page.getByRole('heading', { name: 'Your search could not finish' })).toBeVisible();
    await findPosition(page);
    await expect(page.getByRole('heading', { name: 'A position you actually played' })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('region', { name: 'Personal game search' })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('[data-board-fen]')).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: 'artifacts/homepage-personal-mobile.png', fullPage: true });
});

test('changing identity cancels the running engine and fences its late result', async ({ page }) => {
    const events = await prepare(page);
    await page.route('**/api/master-puzzle', (route) => route.fulfill({ json: { state: 'unavailable' } }));
    await page.route('**/api/onboarding/games', (route) => route.fulfill({ json:
        route.request().postDataJSON().username === 'another-player'
            ? { ...gamesResponse, games: [] }
            : gamesResponse,
    }));
    await page.addInitScript(() => {
        const NativeWorker = window.Worker;
        const counts = { terminated: 0 };
        Object.assign(window, { landingWorkerCounts: counts });
        window.Worker = class extends NativeWorker {
            set onmessage(handler: ((this: Worker, event: MessageEvent) => unknown) | null) {
                super.onmessage = handler ? (event) => {
                    setTimeout(() => handler.call(this, event), 80);
                } : null;
            }
            terminate() { counts.terminated++; super.terminate(); }
        };
    });
    await page.goto('/');
    await findPosition(page);
    await expect(page.getByRole('group', { name: 'Game being analyzed' })).toBeVisible();
    await page.getByRole('textbox', { name: 'Public chess username' }).fill('another-player');
    await page.getByRole('button', { name: 'Find a position from my games' }).click();
    await expect(page.getByRole('heading', { name: 'No personal position found' })).toBeVisible();
    await expect.poll(() => page.evaluate(() =>
        (window as unknown as { landingWorkerCounts: { terminated: number } }).landingWorkerCounts.terminated
    )).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    await expect(page.getByRole('heading', { name: 'No personal position found' })).toBeVisible();
    expect(events).not.toContain('PERSONAL_PUZZLE_SHOWN');
});

test('the public player evaluates an uncovered answer with real local Stockfish', async ({ page }) => {
    await prepare(page);
    const prompt = structuredClone(WARMUP_PUZZLE.prompt);
    const unknown = 'f7h7';
    prompt.grading.moveAssessments = prompt.grading.moveAssessments.filter(item => item.moveUci !== unknown);
    prompt.grading.answerCoverage.assessedMovesUci = prompt.grading.answerCoverage.assessedMovesUci.filter(move => move !== unknown);
    prompt.grading.solutionTree.acceptedMovesUci = prompt.grading.solutionTree.acceptedMovesUci.filter(move => move !== unknown);
    prompt.grading.solutionTree.branches = prompt.grading.solutionTree.branches.filter(branch => branch.moveUci !== unknown);
    prompt.grading.acceptanceFrontier.moves = prompt.grading.acceptanceFrontier.moves.filter(move => move.moveUci !== unknown);
    prompt.grading.review.acceptedMovesUci = prompt.grading.review.acceptedMovesUci.filter(move => move !== unknown);
    await page.route('**/api/master-puzzle', (route) => route.fulfill({ json: {
        state: 'ready', publication: { id: 'partial-evidence', headline: 'Partial evidence test', prompt },
    } }));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const workers: string[] = [];
    page.on('worker', worker => workers.push(worker.url()));
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Partial evidence test' })).toBeVisible();
    await clickMove(page, 'f7', 'h7');
    await expect(page.getByText('Best move — well found.')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-board-fen]')).toHaveAttribute('data-board-marker', 'BEST');
    expect(workers.some(url => url.includes('stockfish'))).toBe(true);
    expect(errors).toEqual([]);
});
