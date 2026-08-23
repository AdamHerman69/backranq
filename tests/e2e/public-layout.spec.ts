import { expect, test } from '@playwright/test';

test.describe('public layout boundary', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const path of [
        '/',
        '/login',
        '/privacy',
        '/terms',
        '/support',
        '/invite/not-a-real-token',
    ]) {
        test(`${path} stays outside the authenticated client shell`, async ({
            page,
        }) => {
            const sessionRequests: string[] = [];
            page.on('request', (request) => {
                if (new URL(request.url()).pathname === '/api/auth/session') {
                    sessionRequests.push(request.url());
                }
            });

            await page.goto(path);
            await expect(page.locator('[data-app-shell]')).toHaveCount(0);

            // Give mount effects a chance to expose an accidentally restored
            // root-level NextAuth SessionProvider read.
            await page.waitForTimeout(250);
            expect(sessionRequests).toEqual([]);
        });
    }
});
