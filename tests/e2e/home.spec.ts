import { expect, test } from '@playwright/test';
import { E2E_USER } from './support/fixtures';
import { square, waitForBoard } from './support/board';

test('Home keeps available Practice when sync status is unavailable', async ({
    page,
}) => {
    await page.route('**/api/training/due', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                availableCount: 3,
                availableCountIsExact: true,
                dueCount: 0,
                dueCountIsExact: true,
                newCount: 3,
                newCountIsExact: true,
                earliestDueAt: null,
            }),
        });
    });
    await page.route('**/api/sync/status', async (route) => {
        await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'sync status unavailable' }),
        });
    });

    await page.goto('/home');

    const practiceLink = page.getByRole('link', { name: 'Practice now' });
    await expect(practiceLink).toBeVisible();
    await expect(practiceLink).toHaveAttribute('href', '/practice');
    await expect(page.getByText('3 practice positions ready')).toBeVisible();
    await expect(
        page.getByText('Could not load source sync status.')
    ).toBeVisible();
});

test('Home shows one dominant connection action when no account is linked', async ({
    page,
}) => {
    await page.route('**/api/training/due', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                availableCount: 0,
                availableCountIsExact: true,
                dueCount: 0,
                dueCountIsExact: true,
                newCount: 0,
                newCountIsExact: true,
                earliestDueAt: null,
            }),
        });
    });
    await page.route('**/api/games?**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ games: [], total: 0 }),
        });
    });
    await page.route('**/api/sync/status', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ownerId: E2E_USER.id,
                linked: {
                    lichessUsername: null,
                    chesscomUsername: null,
                },
                lastSync: { lichess: null, chesscom: null },
                gameAutomation: {
                    paused: true,
                    rules: {
                        lichess: { rapid: 'IMPORT_ONLY' },
                        chesscom: { rapid: 'IMPORT_ONLY' },
                    },
                    schedule: '0 3 * * *',
                    states: { lichess: null, chesscom: null },
                },
                analysisJobs: { queued: 0, running: 0, failed: 0 },
            }),
        });
    });

    await page.goto('/home');

    await expect(page.getByText('Link a chess account')).toBeVisible();
    await expect(
        page.getByRole('link', { name: 'Open settings' })
    ).toHaveCount(1);
    await expect(
        page.getByRole('link', { name: 'Connect account' })
    ).toHaveCount(0);
    await expect(
        page.getByRole('button', { name: 'Sync now' })
    ).toHaveCount(0);
});

test('Home links a scheduled review count to the due-only queue', async ({
    page,
}) => {
    await page.route('**/api/training/due', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                availableCount: 6,
                availableCountIsExact: true,
                dueCount: 3,
                dueCountIsExact: true,
                newCount: 3,
                newCountIsExact: true,
                earliestDueAt: '2026-08-01T09:00:00.000Z',
            }),
        });
    });

    await page.goto('/home');

    await expect(page.getByText('3 reviews due')).toBeVisible();
    await expect(
        page.getByRole('link', { name: 'Review due positions' })
    ).toHaveAttribute('href', '/practice?mode=review');
});

test('Home never presents future-reviewed inventory as ready', async ({
    page,
}) => {
    await page.route('**/api/training/due', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                availableCount: 0,
                availableCountIsExact: true,
                dueCount: 0,
                dueCountIsExact: true,
                newCount: 0,
                newCountIsExact: true,
                earliestDueAt: null,
            }),
        });
    });

    await page.goto('/home');

    await expect(page.getByText(/practice position.*ready/i)).toHaveCount(0);
    await expect(page.getByText('Analyze your imported games')).toBeVisible();
});

test('public root stays a marketing landing for signed-in visitors', async ({
    page,
}) => {
    await page.goto('/');

    await expect(
        page.getByRole('heading', {
            level: 1,
            name: /Stop solving random puzzles.*Practice your decisions/i,
        })
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open app' }).first()).toHaveAttribute(
        'href',
        '/home'
    );
    await expect(page.getByText(/Welcome back/)).toHaveCount(0);
    await expect(
        page.getByRole('button', { name: 'Sync now' })
    ).toHaveCount(0);
});

test.describe('signed-out IA', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('public root offers sign-in without rendering the dashboard', async ({
        page,
    }) => {
        await page.goto('/');

        await expect(
            page.getByRole('link', { name: 'Sign in', exact: true })
        ).toHaveAttribute('href', '/login?callbackUrl=%2Fhome');
        await expect(page.getByRole('link', { name: 'Open app' })).toHaveCount(0);
        await expect(page.getByText(/Welcome back/)).toHaveCount(0);
    });

    test('landing animates the played move before revealing its quality on the board', async ({
        page,
    }) => {
        await page.goto('/');
        await waitForBoard(page);
        const board = page.locator('[data-board-stage]').first();
        const decisionFen = await board.getAttribute('data-board-fen');

        await square(page, 'f7').click();
        await expect(board).toHaveAttribute(
            'data-board-selected-square',
            'f7'
        );
        await expect(
            board.locator('[data-legal-move-target="f8"]')
        ).toBeVisible();

        await square(page, 'f8').click();

        await expect(board).toHaveAttribute('data-board-last-move', 'f7f8');
        expect(await board.getAttribute('data-board-fen')).not.toBe(
            decisionFen
        );
        await expect(board).not.toHaveAttribute('data-board-marker', /.+/);
        await expect(board).toHaveAttribute('data-board-marker', 'BEST');
        await expect(
            board.getByRole('img', { name: 'Best move on f8' })
        ).toBeVisible();
    });

    test('protected Home redirects to login with the Home callback', async ({
        page,
    }) => {
        await page.goto('/home');

        await expect(page).toHaveURL(/\/login\?/);
        expect(new URL(page.url()).searchParams.get('callbackUrl')).toBe(
            '/home'
        );
    });
});
