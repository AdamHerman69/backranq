import { expect, test } from '@playwright/test';

test.describe('authenticated Progress', () => {
    test('uses a truthful 90-day view with one dominant next action', async ({
        page,
    }) => {
        const viewedEvent = page.waitForRequest((request) => {
            if (
                request.method() !== 'POST' ||
                !request.url().endsWith('/api/progress/events')
            ) {
                return false;
            }
            return request.postDataJSON().eventName === 'PROGRESS_VIEWED';
        });
        await page.goto('/progress');

        expect((await viewedEvent).postDataJSON()).toMatchObject({
            eventName: 'PROGRESS_VIEWED',
            windowDays: 90,
        });
        await expect(
            page.getByRole('heading', { level: 1, name: 'Progress' })
        ).toBeVisible();
        await expect(
            page.getByRole('form', { name: 'Progress scope' })
        ).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Data coverage' })
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { name: 'From your games' })
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { name: 'In Practice' })
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { name: 'Review and recurrence' })
        ).toBeVisible();

        const primaryNav = page.getByRole('navigation', {
            name: 'Primary',
        });
        await expect(
            primaryNav.getByRole('link', {
                name: 'Progress',
                exact: true,
            })
        ).toHaveAttribute('aria-current', 'page');

        const practiceActions = page.locator(
            'main a[href^="/practice?"]'
        );
        for (const href of await practiceActions.evaluateAll((links) =>
            links.map((link) => link.getAttribute('href') ?? '')
        )) {
            expect(href).toContain('entry=progress');
            expect(href).not.toMatch(
                /(?:theme|source|impact|phase|lesson)=/i
            );
        }

        const actionEvent = page.waitForRequest((request) => {
            if (
                request.method() !== 'POST' ||
                !request.url().endsWith('/api/progress/events')
            ) {
                return false;
            }
            return request.postDataJSON().eventName === 'ACTION_CLICKED';
        });
        await page
            .locator(
                'main [data-progress-action="primary-next-action"]'
            )
            .click();
        expect((await actionEvent).postDataJSON()).toMatchObject({
            eventName: 'ACTION_CLICKED',
            actionKey: 'primary-next-action',
            windowDays: 90,
        });
    });

    test('applies a bounded time window through the URL', async ({ page }) => {
        await page.goto('/progress');

        await page
            .getByLabel('Time window')
            .selectOption('28');
        await page.getByRole('button', { name: 'Apply view' }).click();

        await expect(page).toHaveURL(/\/progress\?scope=28$/);
        await expect(
            page.getByRole('region', { name: 'Data coverage' })
        ).toBeVisible();
    });
});
