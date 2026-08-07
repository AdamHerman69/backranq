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
        page.getByText('Invitation email is not configured')
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Send invitation' })
    ).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Weekly Master' })).toBeVisible();

    await page.goto('/settings');
    await expect(page.getByText('PRO', { exact: true })).toBeVisible();
    await expect(page.getByText('Status: administrator access')).toBeVisible();
});
