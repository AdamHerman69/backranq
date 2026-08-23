import { expect, test, type Response } from '@playwright/test';

import { waitForBoard } from './support/board';

test.use({ storageState: { cookies: [], origins: [] } });

test('keeps the personal extraction and Stockfish runtime out of the initial landing load', async ({
    page,
}) => {
    const scriptResponses: Response[] = [];
    const stockfishRequests: string[] = [];
    page.on('response', (response) => {
        const url = new URL(response.url());
        if (
            url.pathname.startsWith('/_next/static/chunks/') &&
            url.pathname.endsWith('.js')
        ) {
            scriptResponses.push(response);
        }
    });
    page.on('request', (request) => {
        if (request.url().includes('/vendor/stockfish/')) {
            stockfishRequests.push(request.url());
        }
    });

    await page.goto('/');
    await waitForBoard(page);
    await page.waitForTimeout(500);

    const initialScripts = await Promise.all(
        scriptResponses.map(async (response) =>
            (await response.body()).toString('utf8')
        )
    );
    expect(initialScripts).not.toEqual([]);
    expect(
        initialScripts.some((script) =>
            script.includes('crypto-browserify')
        )
    ).toBe(false);
    expect(stockfishRequests).toEqual([]);
    await expect(
        page.getByRole('button', {
            name: 'Find a position from my games',
        })
    ).toBeVisible();
});
