import { expect, test } from '@playwright/test';

import { waitForBoard } from './support/board';
import { E2E_PUZZLES, puzzlePath } from './support/fixtures';

test('mobile trainer keeps one reachable navigation surface without overflow', async ({
    page,
}) => {
    await page.goto(puzzlePath(E2E_PUZZLES.wrongMove));
    await waitForBoard(page);

    await expect(
        page.getByText('White to move — find the best move')
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Previous', exact: true })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Next puzzle', exact: true })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Next puzzle', exact: true })
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Filters' })).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);
});
