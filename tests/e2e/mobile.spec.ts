import { expect, test } from '@playwright/test';

import { waitForBoard } from './support/board';
import {
    E2E_TRAINING_MOMENTS,
    practicePath,
} from './support/fixtures';

test('mobile trainer keeps one reachable navigation surface without overflow', async ({
    page,
}) => {
    await page.goto(
        practicePath(E2E_TRAINING_MOMENTS.wrongMove)
    );
    await waitForBoard(page);

    await expect(
        page.getByText('White to move — find the best move')
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Flip board' })).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Reveal', exact: true })
    ).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);

    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(
        page.getByRole('link', { name: 'Practice', exact: true })
    ).toBeVisible();
    await expect(
        page.getByRole('link', { name: 'Train', exact: true })
    ).toHaveCount(0);
});

test('mobile game sync and history import stay inside the viewport', async ({
    page,
}) => {
    await page.goto('/games');

    await expect(
        page.getByRole('button', { name: 'Sync now' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Import older games' }).click();
    const dialog = page.getByRole('dialog', {
        name: 'Import older games',
    });
    await expect(dialog).toBeVisible();
    await expect(
        dialog.getByRole('button', { name: 'Find older games' })
    ).toBeVisible();
    await expect(dialog.getByText(/Syncing is free/)).toBeVisible();

    const overflow = await page.evaluate(() => {
        const dialog = document.querySelector(
            '[role="dialog"]'
        ) as HTMLElement | null;
        return {
            page:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth + 1,
            dialog: dialog
                ? dialog.scrollWidth > dialog.clientWidth + 1
                : true,
        };
    });
    expect(overflow.page).toBe(false);
    expect(overflow.dialog).toBe(false);
});
