import { expect, test } from '@playwright/test';

import { clickMove, dragMove, waitForBoard } from './support/board';
import { resetE2ePuzzleAttempts } from './support/database';
import { E2E_PUZZLES, puzzlePath } from './support/fixtures';

test.describe('authenticated puzzle trainer', () => {
    test.beforeEach(async () => {
        await resetE2ePuzzleAttempts();
    });

    test('keeps the prompt spoiler-free and gives control after a wrong click move', async ({
        page,
    }) => {
        await page.goto(puzzlePath(E2E_PUZZLES.wrongMove));
        await expect(
            page.getByText('White to move — find the best move')
        ).toBeVisible();
        await expect(page.getByText('Spoiler-free')).toBeVisible();
        await expect(page.getByText('Punish a mistake')).toHaveCount(0);

        await clickMove(page, 'f1', 'c4');

        await expect(
            page.getByText('Choose how you want to learn from it.')
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Hint', exact: true })
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Play refutation' })
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Analyze', exact: true })
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Try again' })
        ).toBeVisible();
        await expect(page.getByText('Refutation line')).toHaveCount(0);

        await page.getByRole('button', { name: 'Try again' }).click();
        await expect(page.getByText('Make a move when you are ready.')).toBeVisible();
        await expect(
            page.getByText('Choose how you want to learn from it.')
        ).toHaveCount(0);
    });

    test('accepts a correct drag move and persists it', async ({ page }) => {
        await page.goto(puzzlePath(E2E_PUZZLES.dragMove));
        const saved = page.waitForResponse(
            (response) =>
                response.url().includes('/api/puzzles/') &&
                response.url().endsWith('/attempt') &&
                response.request().method() === 'POST'
        );

        await dragMove(page, 'g1', 'f3');

        await expect(page.getByText('Best move — well found.')).toBeVisible();
        await expect((await saved).ok()).toBe(true);
        await expect(
            page
                .getByRole('status')
                .filter({ hasText: 'Attempt saved', visible: true })
        ).toHaveCount(1);
    });

    test('requires confirmation before reveal and preserves the revealed outcome', async ({
        page,
    }) => {
        await page.goto(puzzlePath(E2E_PUZZLES.reveal));
        await waitForBoard(page);

        await page.getByRole('button', { name: 'Solution' }).click();
        const dialog = page.getByRole('dialog', {
            name: 'Reveal this puzzle?',
        });
        await expect(dialog).toBeVisible();
        await expect(
            dialog.getByText('Showing the solution is counted as revealed')
        ).toBeVisible();
        const saved = page.waitForResponse(
            (response) =>
                response.url().includes('/api/puzzles/') &&
                response.url().endsWith('/attempt') &&
                response.request().method() === 'POST'
        );
        await dialog.getByRole('button', { name: 'Reveal solution' }).click();

        await expect(page.getByText('Revealed', { exact: true })).toBeVisible();
        await expect((await saved).ok()).toBe(true);
        await page.reload();
        await expect(page.getByText('Revealed', { exact: true })).toBeVisible();
    });

    test('queues an attempt offline and flushes it when connectivity returns', async ({
        page,
        context,
    }) => {
        await page.goto(puzzlePath(E2E_PUZZLES.offline));
        await waitForBoard(page);
        await expect(
            page
                .getByText('E2EHero vs TacticalTester')
                .filter({ visible: true })
        ).toHaveCount(1);
        await context.setOffline(true);

        await dragMove(page, 'g1', 'f3');
        await expect(page.getByText('Best move — well found.')).toBeVisible();
        await expect(
            page
                .getByRole('status')
                .filter({ hasText: '1 attempt queued', visible: true })
        ).toHaveCount(1);

        const saved = page.waitForResponse(
            (response) =>
                response.url().includes('/api/puzzles/') &&
                response.url().endsWith('/attempt') &&
                response.request().method() === 'POST'
        );
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect((await saved).ok()).toBe(true);
        await expect(
            page
                .getByRole('status')
                .filter({ hasText: 'Attempt saved', visible: true })
        ).toHaveCount(1);
    });

    test('offers all legal promotion choices before committing the move', async ({
        page,
    }) => {
        await page.goto(puzzlePath(E2E_PUZZLES.promotion));
        await dragMove(page, 'a7', 'a8');

        const dialog = page.getByRole('dialog', { name: 'Promote pawn to' });
        await expect(dialog).toBeVisible();
        await expect(
            dialog.getByRole('button', { name: 'Promote to Queen' })
        ).toBeVisible();
        await expect(
            dialog.getByRole('button', { name: 'Promote to Rook' })
        ).toBeVisible();
        await expect(
            dialog.getByRole('button', { name: 'Promote to Bishop' })
        ).toBeVisible();
        await expect(
            dialog.getByRole('button', { name: 'Promote to Knight' })
        ).toBeVisible();

        await dialog
            .getByRole('button', { name: 'Promote to Knight' })
            .click();
        await expect(page.getByText('Best move — well found.')).toBeVisible();
    });
});
