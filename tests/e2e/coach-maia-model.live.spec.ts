import { expect, test } from '@playwright/test';

import { MAIA_MODEL } from '@/lib/coach/maia/metadata';
import { COACH_OFFLINE_ACCESS_STORAGE_KEY } from '@/lib/coach/offlineAccess';
import { COACH_OFFLINE_OWNER_STORAGE_KEY } from '@/lib/coach/offlineOwner';

const runLiveMaiaBrowser =
    process.env.RUN_MAIA_BROWSER_SMOKE === '1';

test.skip(
    !runLiveMaiaBrowser,
    'Set RUN_MAIA_BROWSER_SMOKE=1 to download and exercise the pinned Maia model.'
);

test('plays and resumes a real Maia move after a cold offline start', async ({
    context,
    page,
}) => {
    test.setTimeout(300_000);
    const onlineConsoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
        if (message.type() === 'error') {
            onlineConsoleErrors.push(message.text());
        }
    });
    page.on('pageerror', (error) => {
        pageErrors.push(error.message);
    });
    await page.addInitScript(
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
            'maia-live-user',
        ]
    );

    await page.goto('/~offline/coach');
    expect(
        await page.evaluate(() => window.crossOriginIsolated)
    ).toBe(false);
    await page.evaluate(async () => {
        await navigator.serviceWorker.ready;
    });
    await expect(page.getByText('Offline assets saved')).toBeVisible();

    await page.getByLabel('Opponent model').click();
    await page
        .getByRole('option', { name: /^Maia 3 · human-like/ })
        .click();
    await expect(page.locator('[data-maia-phase="idle"]')).toBeVisible();
    await page
        .getByRole('button', { name: /Download Maia ·/ })
        .click();
    await expect(
        page.locator(
            '[data-maia-phase="ready"], [data-maia-phase="error"]'
        )
    ).toBeVisible({ timeout: 180_000 });
    if (
        await page
            .locator('[data-maia-phase="error"]')
            .isVisible()
    ) {
        throw new Error(
            `Initial Maia install failed: ${await page
                .locator('[data-maia-phase="error"]')
                .innerText()}`
        );
    }
    await expect(
        page.getByText('Human-like opponent saved offline')
    ).toBeVisible();
    const runtimeCacheUrls = await page.evaluate(async (cacheName) => {
        const cache = await caches.open(cacheName);
        return (await cache.keys()).map((request) => request.url);
    }, MAIA_MODEL.runtimeCacheName);
    expect(runtimeCacheUrls).toHaveLength(3);
    expect(runtimeCacheUrls).toEqual(
        expect.arrayContaining([
            expect.stringContaining('backranq-maia.worker.js'),
            expect.stringContaining('ort-wasm-simd-threaded.mjs'),
            expect.stringContaining('ort-wasm-simd-threaded.wasm'),
        ])
    );
    expect(onlineConsoleErrors).toEqual([]);

    await page.getByLabel('Centipawn loss threshold').fill('500');
    await page.getByLabel('Your color').click();
    await page.getByRole('option', { name: 'Black' }).click();
    await page
        .getByRole('button', { name: 'Start coach game' })
        .click();
    await expect(page.locator('[data-coach-phase="player"]')).toBeVisible({
        timeout: 60_000,
    });
    const firstMove = page.locator('[data-coach-move-ply="0"]');
    await expect(firstMove).toHaveText(/^\S+$/);
    const firstMoveText = await firstMove.textContent();
    expect(firstMoveText).toBeTruthy();

    const unexpectedLocalLoadRequests: string[] = [];
    const recordMaiaRequest = (request: { url(): string }) => {
        const url = request.url();
        if (
            url.includes('/vendor/maia/') ||
            url === MAIA_MODEL.sourceUrl
        ) {
            unexpectedLocalLoadRequests.push(url);
        }
    };
    page.on('request', recordMaiaRequest);
    await page.reload();
    await expect(page.getByText('Continue your saved game')).toBeVisible({
        timeout: 30_000,
    });
    await page
        .getByRole('button', { name: 'Load Maia from this device' })
        .click();
    await expect(
        page.locator('[data-maia-phase="ready"]')
    ).toBeVisible({ timeout: 60_000 });
    page.off('request', recordMaiaRequest);
    expect(unexpectedLocalLoadRequests).toEqual([]);

    await context.setOffline(true);
    await page.goto('/play');
    await expect(page.getByText('Continue your saved game')).toBeVisible({
        timeout: 30_000,
    });
    await page
        .getByRole('button', { name: 'Load Maia from this device' })
        .click();
    await expect(
        page.locator('[data-maia-phase="ready"]')
    ).toBeVisible({ timeout: 60_000 });
    await page
        .getByRole('button', { name: 'Continue game' })
        .click();
    await expect(page.locator('[data-coach-phase="player"]')).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.locator('[data-coach-move-ply="0"]')).toHaveText(
        firstMoveText!
    );

    await page.getByLabel('Keyboard move').fill('e5');
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('[data-coach-move-ply="2"]')).toBeVisible({
        timeout: 60_000,
    });
    await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();

    await context.setOffline(false);
    await page.getByRole('button', { name: 'New game' }).click();
    await page
        .getByRole('button', { name: 'Start a new game' })
        .click();
    await page.evaluate(async ({ cacheName, runtimeUrl }) => {
        const cache = await caches.open(cacheName);
        await cache.put(
            runtimeUrl,
            new Response('not valid JavaScript', {
                headers: { 'Content-Type': 'text/javascript' },
            })
        );
    }, {
        cacheName: MAIA_MODEL.runtimeCacheName,
        runtimeUrl:
            '/vendor/maia/ort-wasm-simd-threaded.mjs?v=' +
            encodeURIComponent(MAIA_MODEL.engineRevision),
    });
    await page.getByLabel('Opponent model').click();
    await page
        .getByRole('option', { name: /^Stockfish/ })
        .click();
    await page.getByLabel('Opponent model').click();
    await page
        .getByRole('option', { name: /^Maia 3 · human-like/ })
        .click();
    await page
        .getByRole('button', { name: 'Load Maia from this device' })
        .click();
    await expect(
        page.locator('[data-maia-phase="error"]')
    ).toBeVisible({ timeout: 60_000 });
    await page
        .getByRole('button', {
            name: /Download Maia again ·/,
        })
        .click();
    await expect(
        page.locator('[data-maia-phase="ready"]')
    ).toBeVisible({ timeout: 180_000 });

    await expect(
        page.getByRole('button', {
            name: 'Remove Maia data',
        })
    ).toBeVisible();
    await page
        .getByRole('button', { name: 'Remove Maia data' })
        .click();
    await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Remove Maia data' })
        .click();
    await expect(
        page.getByRole('button', { name: /Download Maia ·/ })
    ).toBeVisible();
    expect(
        await page.evaluate(async () => ({
            maiaCaches: (await caches.keys()).filter((name) =>
                name.startsWith('coach-maia-runtime-')
            ),
            maiaDatabase: (await indexedDB.databases()).some(
                (database) => database.name === 'backranq-maia'
            ),
        }))
    ).toEqual({
        maiaCaches: [],
        maiaDatabase: false,
    });
    expect(pageErrors).toEqual([]);
});
