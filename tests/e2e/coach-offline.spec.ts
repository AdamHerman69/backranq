import { expect, test } from '@playwright/test';

import { COACH_OFFLINE_ACCESS_STORAGE_KEY } from '@/lib/coach/offlineAccess';
import { COACH_OFFLINE_OWNER_STORAGE_KEY } from '@/lib/coach/offlineOwner';

test('cold-starts the saved coach game offline with the real Stockfish runtime', async ({
    page,
    context,
}) => {
    await page.goto('/');
    await expect
        .poll(() =>
            page.evaluate(async () =>
                (await navigator.serviceWorker.getRegistrations()).length
            )
        )
        .toBe(0);
    await page.evaluate(
        ([ownerKey, accessKey, ownerId]) => {
            window.localStorage.setItem(ownerKey, ownerId);
            window.localStorage.setItem(
                accessKey,
                JSON.stringify({
                    version: 1,
                    ownerId,
                    grantedAt: Date.now(),
                })
            );
        },
        [
            COACH_OFFLINE_OWNER_STORAGE_KEY,
            COACH_OFFLINE_ACCESS_STORAGE_KEY,
            'e2e-authenticated-user',
        ]
    );

    await page.goto('/~offline/coach');
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
    });

    // The first worker is intentionally not allowed to take over an active
    // game. Reload once online so the newly active worker controls the page.
    await page.reload();
    await expect
        .poll(() =>
            page.evaluate(() => Boolean(navigator.serviceWorker.controller))
        )
        .toBe(true);
    await expect(page.getByText('Offline assets saved')).toBeVisible();

    await page
        .getByRole('button', { name: 'Start coach game' })
        .click();
    await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
    await page.getByLabel('Keyboard move').fill('e4');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
    await page.waitForTimeout(250);

    await context.setOffline(true);
    await page.goto('/play');
    await expect(page.getByText('Continue your saved game')).toBeVisible();
    await page
        .getByRole('button', { name: 'Continue game' })
        .click();

    await expect(page.locator('[data-coach-phase="player"]')).toBeVisible({
        timeout: 30_000,
    });
    await expect(page.locator('[data-coach-move-ply="0"]')).toHaveText(
        'e4'
    );

    await page.goto('/home');
    await expect(page.getByText('Continue your saved game')).toBeVisible();
});

test('does not expose the static coach shell before authenticated enrollment', async ({
    page,
}) => {
    await page.goto('/~offline/coach');
    await expect(
        page.getByRole('heading', {
            name: 'Open Coach online first',
        })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Start coach game' })
    ).toHaveCount(0);
    await expect
        .poll(() =>
            page.evaluate(async () =>
                (await navigator.serviceWorker.getRegistrations()).length
            )
        )
        .toBe(0);
});

test('locks an open offline coach when another tab revokes enrollment', async ({
    context,
    page,
}) => {
    await page.goto('/');
    await page.evaluate(
        ([ownerKey, accessKey, ownerId]) => {
            localStorage.setItem(ownerKey, ownerId);
            localStorage.setItem(
                accessKey,
                JSON.stringify({
                    version: 1,
                    ownerId,
                    grantedAt: Date.now(),
                })
            );
        },
        [
            COACH_OFFLINE_OWNER_STORAGE_KEY,
            COACH_OFFLINE_ACCESS_STORAGE_KEY,
            'e2e-authenticated-user',
        ]
    );
    await page.goto('/~offline/coach');
    await expect(
        page.getByRole('button', { name: 'Start coach game' })
    ).toBeVisible();

    const signOutTab = await context.newPage();
    await signOutTab.goto('/');
    await signOutTab.evaluate(
        ([ownerKey, accessKey]) => {
            localStorage.removeItem(accessKey);
            localStorage.removeItem(ownerKey);
        },
        [
            COACH_OFFLINE_OWNER_STORAGE_KEY,
            COACH_OFFLINE_ACCESS_STORAGE_KEY,
        ]
    );

    await expect(
        page.getByRole('heading', {
            name: 'Open Coach online first',
        })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Start coach game' })
    ).toHaveCount(0);
});
