import { expect, test } from '@playwright/test';

import { COACH_OFFLINE_ACCESS_STORAGE_KEY } from '@/lib/coach/offlineAccess';
import { COACH_OFFLINE_OWNER_STORAGE_KEY } from '@/lib/coach/offlineOwner';

test('locks an open online coach when another tab revokes access', async ({
    context,
    page,
}) => {
    await page.goto('/play');
    await expect(
        page.getByRole('heading', { name: 'Set up your game' })
    ).toBeVisible();

    const signOutTab = await context.newPage();
    await signOutTab.goto('/home');
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
            name: 'Coach locked after sign-out',
        })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Start coach game' })
    ).toHaveCount(0);
});
