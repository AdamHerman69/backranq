import { expect, test } from '@playwright/test';

import { E2E_GAMES } from './support/fixtures';

test('desktop game review keeps the board and playback controls in the first viewport', async ({
    page,
}) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/games/${E2E_GAMES.standard}`);

    const board = page.locator('[data-game-review-board]:visible');
    const playback = page.getByRole('button', { name: 'Play review' });
    await expect(board).toBeVisible();
    await expect(playback).toBeVisible();

    const [boardBox, playbackBox] = await Promise.all([
        board.boundingBox(),
        playback.boundingBox(),
    ]);
    expect(boardBox).not.toBeNull();
    expect(playbackBox).not.toBeNull();
    expect(boardBox!.y).toBeGreaterThanOrEqual(0);
    expect(boardBox!.y + boardBox!.height).toBeLessThanOrEqual(940);
    expect(playbackBox!.y + playbackBox!.height).toBeLessThanOrEqual(990);

    await page.getByRole('button', { name: 'Next move' }).click();
    await expect(
        board.locator('[data-game-move-quality="book"]')
    ).toBeVisible();
    await expect(board.getByRole('img', { name: 'Book on e4' })).toBeVisible();
});
