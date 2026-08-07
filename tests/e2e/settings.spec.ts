import { expect, test } from '@playwright/test';
import { E2E_USER } from './support/fixtures';

test('connection changes refresh automation source status', async ({
    page,
}) => {
    let username = 'old-user';
    let preferencesWriteOwner: string | null = null;
    await page.route('**/api/user/preferences', async (route) => {
        if (route.request().method() === 'PUT') {
            preferencesWriteOwner =
                route.request().headers()['x-backranq-owner-id'] ?? null;
        }
        await route.continue();
    });
    await page.route('**/api/sync/status', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ownerId: E2E_USER.id,
                linked: {
                    lichessUsername: username,
                    chesscomUsername: null,
                },
                lastSync: { lichess: null, chesscom: null },
                gameAutomation: {
                    paused: false,
                    rules: {
                        lichess: { rapid: 'IMPORT_ONLY' },
                        chesscom: { rapid: 'IGNORE' },
                    },
                    schedule: '0 3 * * *',
                    states: { lichess: null, chesscom: null },
                },
                analysisJobs: { queued: 0, running: 0, failed: 0 },
            }),
        });
    });

    await page.goto('/settings');
    await expect(page.getByText('@old-user')).toBeVisible();
    const automationPause = page.getByRole('checkbox', {
        name: 'Pause all game automation',
    });
    await expect(automationPause).not.toBeChecked();
    await automationPause.check();
    await expect(
        page.getByText('You have unsaved automation changes.')
    ).toBeVisible();
    username = 'new-user';
    await page.evaluate(() => {
        window.dispatchEvent(
            new CustomEvent('backranq:chess-connections-changed')
        );
    });

    await expect(page.getByText('@new-user')).toBeVisible();
    await expect(automationPause).toBeChecked();
    await expect(
        page.getByText('You have unsaved automation changes.')
    ).toBeVisible();
    await page
        .getByRole('button', { name: 'Save automation' })
        .click();
    await expect(
        page.getByText('Automation settings are up to date.')
    ).toBeVisible();
    expect(preferencesWriteOwner).toBe(E2E_USER.id);
});

test('the newest connection-status request wins', async ({ page }) => {
    let requestCount = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
    });
    const firstReleased = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    await page.route('**/api/sync/status', async (route) => {
        requestCount += 1;
        const currentRequest = requestCount;
        if (currentRequest === 1) {
            markFirstStarted();
            await firstReleased;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ownerId: E2E_USER.id,
                linked: {
                    lichessUsername:
                        currentRequest === 1 ? 'stale-user' : 'current-user',
                    chesscomUsername: null,
                },
                lastSync: { lichess: null, chesscom: null },
                gameAutomation: {
                    paused: false,
                    rules: {
                        lichess: { rapid: 'IMPORT_ONLY' },
                        chesscom: { rapid: 'IGNORE' },
                    },
                    schedule: '0 3 * * *',
                    states: { lichess: null, chesscom: null },
                },
                analysisJobs: { queued: 0, running: 0, failed: 0 },
            }),
        });
    });

    await page.goto('/settings');
    await firstStarted;
    await page.evaluate(() => {
        window.dispatchEvent(
            new CustomEvent('backranq:chess-connections-changed')
        );
    });
    await expect(page.getByText('@current-user')).toBeVisible();

    releaseFirst();
    await expect(page.getByText('@current-user')).toBeVisible();
    await expect(page.getByText('@stale-user')).toHaveCount(0);
});

test('a stale username validation cannot overwrite newer input', async ({
    page,
}) => {
    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => {
        markValidationStarted = resolve;
    });
    const validationReleased = new Promise<void>((resolve) => {
        releaseValidation = resolve;
    });

    await page.route('**/api/user/validate**', async (route) => {
        markValidationStarted();
        await validationReleased;
        try {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, exists: true }),
            });
        } catch {
            // Editing the input aborts the stale browser request.
        }
    });

    await page.goto('/settings');
    const username = page.getByRole('textbox', {
        name: 'Lichess username',
    });
    const account = username.locator(
        'xpath=ancestor::div[contains(@class,"space-y-3")][1]'
    );
    await username.fill('slow-validation');
    await account.getByRole('button', { name: 'Validate' }).click();
    await validationStarted;
    await username.fill('newer-input');
    releaseValidation();

    await expect(username).toHaveValue('newer-input');
    await expect(account.getByText('Username found')).toHaveCount(0);
    await expect(account.getByText('Valid', { exact: true })).toHaveCount(0);
});

test('automation refuses settings returned for another owner', async ({
    page,
}) => {
    await page.route('**/api/user/preferences', async (route) => {
        if (route.request().method() !== 'GET') {
            await route.continue();
            return;
        }
        const response = await route.fetch();
        const body = (await response.json()) as Record<string, unknown>;
        await route.fulfill({
            response,
            json: {
                ...body,
                ownerId: 'different-owner',
            },
        });
    });

    await page.goto('/settings');

    await expect(
        page.getByText('Automation settings unavailable')
    ).toBeVisible();
    await expect(
        page.getByText(/different account/)
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Try again' })
    ).toBeEnabled();
});

test('linked-account updates reject a server owner mismatch', async ({
    page,
}) => {
    let syncRequests = 0;
    await page.route('**/api/sync', async (route) => {
        if (route.request().method() === 'POST') syncRequests += 1;
        await route.continue();
    });
    await page.route('**/api/user/profile', async (route) => {
        if (route.request().method() !== 'PATCH') {
            await route.continue();
            return;
        }
        expect(
            route.request().headers()['x-backranq-owner-id']
        ).toBe(E2E_USER.id);
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                user: {
                    id: 'different-owner',
                    email: 'other@example.test',
                    name: 'Other owner',
                    image: null,
                    lichessUsername: 'replacement-user',
                    chesscomUsername: null,
                },
            }),
        });
    });

    await page.goto('/settings');
    const username = page.getByRole('textbox', {
        name: 'Lichess username',
    });
    const account = username.locator(
        'xpath=ancestor::div[contains(@class,"space-y-3")][1]'
    );
    await username.fill('replacement-user');
    await account.getByRole('button', { name: 'Replace' }).click();

    await expect(
        page
            .getByRole('region', { name: 'Chess sources' })
            .getByRole('alert')
    ).toContainText('signed-in account changed before the update finished');
    expect(syncRequests).toBe(0);
});
