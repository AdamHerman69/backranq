import { expect, test } from '@playwright/test';
import { E2E_USER } from './support/fixtures';

test('Home keeps available Practice when sync status is unavailable', async ({
    page,
}) => {
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
    await expect(page.getByText('Your positions are ready')).toBeVisible();
    await expect(
        page.getByText('Could not load source sync status.')
    ).toBeVisible();
});

test('Home shows one dominant connection action when no account is linked', async ({
    page,
}) => {
    await page.route('**/api/training/feed?**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ items: [] }),
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
                autoSync: {
                    enabled: false,
                    providers: { lichess: true, chesscom: true },
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
            page.getByRole('button', { name: 'Get started with Google' }).first()
        ).toBeVisible();
        await expect(page.getByRole('link', { name: 'Open app' })).toHaveCount(0);
        await expect(page.getByText(/Welcome back/)).toHaveCount(0);
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
