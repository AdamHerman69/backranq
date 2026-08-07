import { expect, test } from '@playwright/test';

test('administrator sees the invitation portal and automatic Pro access', async ({
    page,
}) => {
    await page.goto('/admin/premium');

    await expect(
        page.getByRole('heading', { name: 'Premium', exact: true })
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Invite to Pro' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Invitation email' })).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Send invitation' })
    ).toBeEnabled();
    await expect(page.getByRole('link', { name: 'Weekly Master' })).toBeVisible();

    let commandRequests = 0;
    await page.route('**/api/admin/premium/commands', async (route) => {
        commandRequests += 1;
        await route.abort();
    });
    page.once('dialog', async (dialog) => {
        expect(dialog.message()).toContain(
            'The previously delivered link will stop working.'
        );
        await dialog.dismiss();
    });
    await page
        .getByRole('row', { name: /invited-friend@example\.com/ })
        .getByRole('button', { name: 'Resend' })
        .click();
    await expect.poll(() => commandRequests).toBe(0);

    await page.goto('/settings');
    const access = page.getByLabel('Access');
    await expect(access).toContainText('Pro — Administrator access');
    await expect(page.getByLabel('Paid subscription')).toContainText('None');
});
