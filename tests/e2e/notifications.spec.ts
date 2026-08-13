import { expect, test } from '@playwright/test';

import { E2E_USER } from './support/fixtures';

const notification = {
    id: '30000000-0000-4000-8000-00000000e2e1',
    title: 'Practice ready',
    body: 'One position is ready.',
    href: '/home',
    readAt: null,
    createdAt: '2026-08-13T00:00:00.000Z',
};

test('a stale inbox load cannot resurrect notifications after mark-all', async ({
    page,
}) => {
    let reads = 0;
    let releaseStale!: () => void;
    const staleReleased = new Promise<void>((resolve) => {
        releaseStale = resolve;
    });
    await page.route('**/api/notifications?limit=10', async (route) => {
        reads += 1;
        const current = reads;
        if (current === 2) await staleReleased;
        try {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    notifications:
                        current >= 3
                            ? [{ ...notification, readAt: new Date().toISOString() }]
                            : [notification],
                    unreadCount: current >= 3 ? 0 : 1,
                }),
            });
        } catch {
            // The successful write aborts the stale read generation.
        }
    });
    await page.route('**/api/notifications', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.fallback();
            return;
        }
        expect(route.request().headers()['x-backranq-owner-id']).toBe(
            E2E_USER.id
        );
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ownerId: E2E_USER.id, updated: 1 }),
        });
    });

    await page.goto('/home');
    const trigger = page.getByRole('button', {
        name: 'Notifications, 1 unread',
    });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.getByRole('button', { name: 'Mark all read' }).click();
    releaseStale();

    await expect(
        page.getByRole('menu', { name: 'Notifications' })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: /Notifications, 1 unread/ })
    ).toHaveCount(0);
});

test('a failed notification write restores unread state and reports the error', async ({
    page,
}) => {
    await page.route('**/api/notifications?limit=10', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                ownerId: E2E_USER.id,
                notifications: [notification],
                unreadCount: 1,
            }),
        });
    });
    await page.route('**/api/notifications', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.fallback();
            return;
        }
        await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Could not mark notifications read' }),
        });
    });

    await page.goto('/home');
    const trigger = page.getByRole('button', {
        name: 'Notifications, 1 unread',
    });
    await trigger.click();
    await page.getByRole('button', { name: 'Mark all read' }).click();

    const menu = page.getByRole('menu', { name: /^Notifications/ });
    await expect(menu.getByRole('alert')).toContainText(
        'Could not mark notifications read'
    );
    await expect(
        page.getByRole('menu', { name: 'Notifications, 1 unread' })
    ).toBeVisible();
});
