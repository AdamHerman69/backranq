import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import {
    E2E_GAMES,
    E2E_TRAINING_MOMENTS,
    practicePath,
} from './support/fixtures';

const enabled = process.env.RUN_UI_VISUAL_AUDIT === 'true';
const artifactDirectory = path.join(
    process.cwd(),
    'artifacts',
    'ui-visual-audit'
);

const routes = [
    ['home', '/home'],
    ['practice', practicePath(E2E_TRAINING_MOMENTS.wrongMove)],
    ['play', '/play'],
    ['games', '/games'],
    ['game-review', `/games/${E2E_GAMES.standard}`],
    ['progress', '/progress'],
    ['settings', '/settings'],
    ['profile', '/profile'],
    ['admin', '/admin'],
    ['admin-premium', '/admin/premium'],
    ['admin-weekly-master', '/admin/weekly-master'],
] as const;

const publicRoutes = [
    ['landing', '/'],
    ['login', '/login'],
    ['privacy', '/privacy'],
    ['terms', '/terms'],
    ['support', '/support'],
] as const;

async function captureRoute(
    page: import('@playwright/test').Page,
    viewportName: string,
    name: string,
    route: string
) {
    await page.goto(route);
    await expect(page.locator('main').first()).toBeVisible();
    await page.waitForTimeout(1_800);
    await page.screenshot({
        path: path.join(
            artifactDirectory,
            `after-${viewportName}-${name}.png`
        ),
        fullPage: false,
    });

    const overflow = await page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
    );
    expect.soft(
        overflow,
        `${name} must not overflow horizontally`
    ).toBeLessThanOrEqual(1);

    const headingCount = await page.locator('h1').count();
    expect.soft(
        headingCount,
        `${name} should expose one clear page heading`
    ).toBe(1);

    if (viewportName === 'mobile') {
        const undersizedControls = await page.evaluate(() => {
            const selector = [
                'button',
                '[role="button"]',
                '[role="tab"]',
                'summary',
                'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
                'select',
                'textarea',
            ].join(',');
            return Array.from(
                document.querySelectorAll<HTMLElement>(selector)
            )
                .filter((element) => {
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return (
                        style.visibility !== 'hidden' &&
                        style.display !== 'none' &&
                        rect.width > 0 &&
                        rect.height > 0 &&
                        !element.closest('[aria-hidden="true"]') &&
                        (rect.width < 40 || rect.height < 40)
                    );
                })
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    const label =
                        element.getAttribute('aria-label') ??
                        element.textContent?.trim().replace(/\s+/g, ' ') ??
                        element.tagName;
                    return `${label.slice(0, 64)} (${Math.round(rect.width)}×${Math.round(rect.height)})`;
                });
        });
        expect.soft(
            undersizedControls,
            `${name} mobile controls should provide a reliable touch target`
        ).toEqual([]);
    }
}

test.describe('authenticated visual audit', () => {
    test.skip(!enabled, 'Run explicitly with RUN_UI_VISUAL_AUDIT=true.');

    for (const viewport of [
        { name: 'desktop', width: 1440, height: 1000 },
        { name: 'mobile', width: 390, height: 844 },
    ] as const) {
        test(`${viewport.name} route inventory`, async ({ page }) => {
            await mkdir(artifactDirectory, { recursive: true });
            await page.setViewportSize({
                width: viewport.width,
                height: viewport.height,
            });

            for (const [name, route] of routes) {
                await captureRoute(
                    page,
                    viewport.name,
                    name,
                    route
                );
            }
        });

        test(`${viewport.name} public route inventory`, async ({ page }) => {
            await mkdir(artifactDirectory, { recursive: true });
            await page.context().clearCookies();
            await page.setViewportSize({
                width: viewport.width,
                height: viewport.height,
            });

            for (const [name, route] of publicRoutes) {
                await captureRoute(
                    page,
                    viewport.name,
                    name,
                    route
                );
            }
        });
    }
});
