import { expect, test } from '@playwright/test';

import { waitForBoard } from './support/board';
import {
    E2E_TRAINING_MOMENTS,
    trainingPath,
} from './support/fixtures';

test('mobile trainer keeps one reachable navigation surface without overflow', async ({
    page,
}) => {
    await page.goto(
        trainingPath(E2E_TRAINING_MOMENTS.wrongMove)
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
});
