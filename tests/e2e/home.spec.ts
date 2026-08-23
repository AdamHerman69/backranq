import { expect, test } from '@playwright/test';
import { E2E_USER } from './support/fixtures';
import { square, waitForBoard } from './support/board';

test('Home paints its server snapshot without dashboard mount requests', async ({
    page,
}) => {
    await page.addInitScript((ownerId) => {
        sessionStorage.setItem(
            `backranq.app-open-sync:${encodeURIComponent(ownerId)}`,
            String(Date.now())
        );
    }, E2E_USER.id);
    const dashboardRequests: string[] = [];
    for (const pattern of [
        '**/api/training/due',
        '**/api/games?**',
        '**/api/sync/status',
    ]) {
        await page.route(pattern, async (route) => {
            dashboardRequests.push(route.request().url());
            await route.continue();
        });
    }

    await page.goto('/home');

    await expect(
        page.getByRole('heading', { level: 1, name: 'Welcome back, Backranq' })
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Practice now' })).toHaveAttribute(
        'href',
        '/practice'
    );
    await expect(page.getByText('Loading your next step')).toHaveCount(0);
    expect(dashboardRequests).toEqual([]);
});

test('Home and Games share one owner-scoped sync snapshot with the global bar', async ({
    page,
}) => {
    test.setTimeout(30_000);
    await page.addInitScript((ownerId) => {
        sessionStorage.setItem(
            `backranq.app-open-sync:${encodeURIComponent(ownerId)}`,
            String(Date.now())
        );
    }, E2E_USER.id);
    const statusRequests: string[] = [];
    await page.route('**/api/sync/status', async (route) => {
        statusRequests.push(route.request().url());
        await route.continue();
    });

    await page.goto('/home');
    await expect(
        page.locator('[data-background-analysis-host="true"]')
    ).toHaveCount(1);
    await page.waitForTimeout(16_000);
    expect(statusRequests).toEqual([]);

    await page.getByRole('link', { name: 'Games', exact: true }).first().click();
    await expect(page).toHaveURL(/\/games$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect
        .poll(() => statusRequests.length, { timeout: 5_000 })
        .toBe(1);
    await page.waitForTimeout(1_000);
    expect(statusRequests).toHaveLength(1);
});

test('a hard-loaded Games page singleflights widget and active-batch status reads', async ({
    page,
}) => {
    await page.addInitScript((ownerId) => {
        const now = new Date().toISOString();
        localStorage.setItem(
            `backranq.analysis.serverRequests.v3:${encodeURIComponent(ownerId)}`,
            JSON.stringify([
                {
                    id: 'e2e-active-batch',
                    requestId: 'e2e-active-request',
                    status: 'QUEUED',
                    requested: 1,
                    planning: 0,
                    queued: 1,
                    running: 0,
                    succeeded: 0,
                    failed: 0,
                    skipped: 0,
                    completedAt: null,
                    ownerId,
                    payloadFingerprint: 'e2e-active-fingerprint',
                    createdAt: now,
                    updatedAt: now,
                },
            ])
        );
    }, E2E_USER.id);
    let statusRequests = 0;
    let batchRequests = 0;
    await page.route('**/api/sync/status', async (route) => {
        statusRequests += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.continue();
    });
    await page.route('**/api/analysis/batches?**', async (route) => {
        batchRequests += 1;
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                batch: {
                    id: 'e2e-active-batch',
                    requestId: 'e2e-active-request',
                    status: 'QUEUED',
                    counts: {
                        total: 1,
                        pending: 0,
                        queued: 1,
                        running: 0,
                        succeeded: 0,
                        failed: 0,
                        skipped: 0,
                    },
                    completedAt: null,
                },
            }),
        });
    });

    await page.goto('/games');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect.poll(() => batchRequests).toBeGreaterThan(0);
    await expect.poll(() => statusRequests).toBe(1);
    await page.waitForTimeout(500);
    expect(statusRequests).toBe(1);
});

test('silent app-open sync publishes once without foreground job polling', async ({
    page,
}) => {
    await page.addInitScript((ownerId) => {
        sessionStorage.removeItem(
            `backranq.app-open-sync:${encodeURIComponent(ownerId)}`
        );
    }, E2E_USER.id);
    let syncPosts = 0;
    let activityReads = 0;
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname !== '/api/sync') return;
        if (request.method() === 'POST') syncPosts += 1;
        if (request.method() === 'GET') activityReads += 1;
    });
    await page.route('**/api/sync', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.continue();
            return;
        }
        await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
                ownerId: E2E_USER.id,
                requested: ['lichess'],
                providers: [
                    {
                        provider: 'lichess',
                        queued: true,
                        jobId: 'e2e-silent-sync-job',
                        skippedReason: null,
                        queuePublished: true,
                        jobStatus: 'QUEUED',
                    },
                ],
                active: {
                    ownerId: E2E_USER.id,
                    providers: [],
                    requestedJobs: [],
                },
            }),
        });
    });

    await page.goto('/home');
    await expect.poll(() => syncPosts).toBe(1);
    await page.waitForTimeout(1_500);

    expect(syncPosts).toBe(1);
    expect(activityReads).toBe(0);
});

test('Home hydrates linked-source controls from the server snapshot', async ({
    page,
}) => {
    await page.addInitScript((ownerId) => {
        sessionStorage.setItem(
            `backranq.app-open-sync:${encodeURIComponent(ownerId)}`,
            String(Date.now())
        );
    }, E2E_USER.id);

    await page.goto('/home');

    await expect(page.getByText('Lichess', { exact: true })).toBeVisible();
    await expect(page.getByText('Chess.com', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sync now' })).toBeVisible();
    await expect(
        page.getByRole('link', { name: 'Connect account' })
    ).toHaveCount(0);
});

test('Home summary links the server-owned library snapshot', async ({ page }) => {
    await page.addInitScript((ownerId) => {
        sessionStorage.setItem(
            `backranq.app-open-sync:${encodeURIComponent(ownerId)}`,
            String(Date.now())
        );
    }, E2E_USER.id);

    await page.goto('/home');

    const summary = page.getByRole('region', {
        name: 'Your library at a glance',
    });
    await expect(summary).toBeVisible();
    await expect(summary.getByRole('link', { name: /Games/ })).toHaveAttribute(
        'href',
        '/games'
    );
    await expect(
        summary.getByRole('link', { name: /Ready to practice/ })
    ).toHaveAttribute('href', '/practice');
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
