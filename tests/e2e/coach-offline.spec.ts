import { expect, test } from '@playwright/test';

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
});
