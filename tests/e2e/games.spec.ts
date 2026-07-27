import { expect, test } from '@playwright/test';

test.describe('authenticated games library', () => {
    test('uses the signed-in player perspective for results and filters', async ({
        page,
    }) => {
        await page.goto('/games?result=wins');

        await expect(page).toHaveURL(/\/games\?result=wins/);
        await expect(
            page.getByRole('heading', { name: 'Games', exact: true })
        ).toBeVisible();
        await expect(page.getByText('2 games')).toBeVisible();
        await expect(page.getByText('TacticalTester (1794)')).toBeVisible();
        await expect(page.getByText('PromotionTester (1701)')).toBeVisible();
        await expect(page.getByText('W', { exact: true })).toHaveCount(2);
        await expect(page.getByText('You: Black')).toBeVisible();

        await page.goto('/games?result=losses');
        await expect(page.getByText('0 games')).toBeVisible();
        await expect(page.getByText('TacticalTester (1794)')).toHaveCount(0);
    });

    test('reviews credit and deletion impact before bulk actions', async ({
        page,
    }) => {
        await page.goto('/games');
        await page.getByRole('checkbox', { name: 'Select game' }).first().check();
        await expect(page.getByText('1 selected')).toBeVisible();

        await page.getByRole('button', { name: 'Reevaluate' }).click();
        const reanalyzeDialog = page.getByRole('alertdialog', {
            name: 'Re-analyze 1 selected game?',
        });
        await expect(reanalyzeDialog).toBeVisible();
        await expect(
            reanalyzeDialog.getByText('Requested maximum cost')
        ).toBeVisible();
        await expect(
            reanalyzeDialog.getByText('Current credit balance', { exact: true })
        ).toBeVisible();
        await expect(
            reanalyzeDialog.getByText('Manual reservable capacity')
        ).toBeVisible();
        await expect(reanalyzeDialog.getByText('Safety floor')).toBeVisible();
        await expect(
            reanalyzeDialog.getByText(/Attempt history is preserved/)
        ).toBeVisible();
        await reanalyzeDialog.getByRole('button', { name: 'Cancel' }).click();

        await page.getByRole('button', { name: 'Delete' }).click();
        const deleteDialog = page.getByRole('alertdialog', {
            name: 'Permanently delete 1 selected game?',
        });
        await expect(deleteDialog).toBeVisible();
        await expect(
            deleteDialog.getByText(/permanently removes every associated puzzle/)
        ).toBeVisible();
        await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    });
});
