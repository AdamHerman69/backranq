import { expect, test } from '@playwright/test';

import { square, waitForBoard } from './support/board';
import {
    E2E_GAMES,
    E2E_TRAINING_MOMENTS,
    practicePath,
} from './support/fixtures';

test('mobile game review keeps the full board and playback inside the viewport', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/games/${E2E_GAMES.standard}`);

    const summary = page.getByRole('region', { name: 'Game summary' });
    const board = page.locator('[data-game-review-board]');
    const playback = page.getByRole('button', { name: 'Play review' });
    const primaryNav = page.getByRole('navigation', { name: 'Main tabs' });
    await expect(summary).toBeVisible();
    await expect(summary.getByLabel('white pieces')).toBeVisible();
    await expect(summary.getByLabel('black pieces')).toBeVisible();
    await expect(board).toBeVisible();
    await expect(playback).toBeVisible();

    const firstViewport = await Promise.all([
        summary.boundingBox(),
        board.boundingBox(),
        playback.boundingBox(),
        primaryNav.boundingBox(),
    ]);
    const [summaryBox, boardBox, playbackBox, navBox] = firstViewport;
    expect(summaryBox).not.toBeNull();
    expect(boardBox).not.toBeNull();
    expect(playbackBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(summaryBox!.y).toBeGreaterThanOrEqual(0);
    expect(boardBox!.y).toBeGreaterThan(summaryBox!.y + summaryBox!.height - 1);
    expect(boardBox!.y + boardBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
    expect(playbackBox!.y + playbackBox!.height).toBeLessThanOrEqual(navBox!.y + 1);

    await page.getByRole('button', { name: 'Next move' }).click();
    await expect(
        board.locator('[data-game-move-quality="book"]')
    ).toBeVisible();
    await expect(board.getByRole('img', { name: 'Book on e4' })).toBeVisible();

    const layout = await board.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            right: rect.right,
            viewport: window.innerWidth,
            pageOverflow:
                document.documentElement.scrollWidth > window.innerWidth + 1,
        };
    });

    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.pageOverflow).toBe(false);
});

test('mobile coach setup stays readable and reachable without overflow', async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/play');

    await expect(
        page.getByRole('heading', { level: 1, name: 'Play with a coach' })
    ).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Start coach game' })
    ).toBeVisible();
    const startButton = page.getByRole('button', {
        name: 'Start coach game',
    });
    const nav = page.getByRole('navigation', { name: 'Main tabs' });
    const [startBox, navBox] = await Promise.all([
        startButton.boundingBox(),
        nav.boundingBox(),
    ]);
    expect(startBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(startBox!.y + startBox!.height).toBeLessThanOrEqual(
        navBox!.y + 1
    );
    expect(
        await page.evaluate(
            () =>
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth + 1
        )
    ).toBe(false);

    const primaryNav = page.getByRole('navigation', { name: 'Main tabs' });
    await expect(
        primaryNav.getByRole('link', { name: 'Play', exact: true })
    ).toHaveAttribute('aria-current', 'page');
});

test('mobile trainer keeps one reachable navigation surface without overflow', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
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

    const prompt = page.getByText('White to move — find the best move');
    const board = page.locator('[data-board-stage]');
    const reveal = page.getByRole('button', { name: 'Reveal', exact: true });
    const bottomNav = page.getByRole('navigation', { name: 'Main tabs' });
    const [promptBox, boardBox, revealBox, navBox] = await Promise.all([
        prompt.boundingBox(),
        board.boundingBox(),
        reveal.boundingBox(),
        bottomNav.boundingBox(),
    ]);
    expect(promptBox).not.toBeNull();
    expect(boardBox).not.toBeNull();
    expect(revealBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    expect(promptBox!.y).toBeGreaterThanOrEqual(0);
    expect(boardBox!.y).toBeGreaterThan(promptBox!.y);
    expect(boardBox!.y + boardBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
    expect(revealBox!.y + revealBox!.height).toBeLessThanOrEqual(navBox!.y + 1);

    const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);

    await page.getByRole('tab', { name: 'Analyze' }).click();
    await page
        .getByRole('dialog', {
            name: 'Analyze this position?',
        })
        .getByRole('button', {
            name: 'Reveal and analyze',
        })
        .click();
    await expect(
        page.getByRole('heading', {
            name: 'Analyze the position',
        })
    ).toBeVisible();
    await expect(
        page.getByRole('button', {
            name: 'Decision position',
        })
    ).toBeVisible();
    expect(
        await page.evaluate(
            () =>
                document.documentElement.scrollWidth >
                window.innerWidth + 1
        )
    ).toBe(false);

    const primaryNav = page.getByRole('navigation', { name: 'Main tabs' });
    await expect(
        primaryNav.getByRole('link', { name: 'Practice', exact: true })
    ).toHaveAttribute('aria-current', 'page');
    await expect(
        primaryNav.getByRole('link', { name: 'Train', exact: true })
    ).toHaveCount(0);
});

test('mobile trainer treats normal finger jitter as a tap, not an abandoned drag', async ({
    page,
}) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(practicePath(E2E_TRAINING_MOMENTS.wrongMove));
    await waitForBoard(page);

    const source = square(page, 'g1');
    const sourceBox = await source.boundingBox();
    expect(sourceBox).not.toBeNull();

    const x = sourceBox!.x + sourceBox!.width / 2;
    const y = sourceBox!.y + sourceBox!.height / 2;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
            { x: x + 2, y: y + 1, radiusX: 1, radiusY: 1, force: 1 },
        ],
    });
    await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
    });

    const board = page.locator('[data-board-stage]');
    const mobileActions = page.locator('[data-training-mobile-actions]');
    const [boardBox, actionsBox] = await Promise.all([
        board.boundingBox(),
        mobileActions.boundingBox(),
    ]);
    expect(boardBox).not.toBeNull();
    expect(actionsBox).not.toBeNull();
    expect(boardBox!.y + boardBox!.height).toBeLessThanOrEqual(
        actionsBox!.y + 1
    );
    await expect(board).toHaveAttribute('data-board-selected-square', 'g1');
    await expect(
        board.locator('[data-legal-move-target="f3"]')
    ).toBeVisible();
    await square(page, 'f3').tap();
    await expect(board).toHaveAttribute(
        'data-board-last-move',
        'g1f3'
    );
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

test('Progress reflows at 320px with reachable canonical navigation', async ({
    page,
}) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/progress');

    await expect(
        page.getByRole('heading', { level: 1, name: 'Progress' })
    ).toBeVisible();
    await expect(
        page
            .getByRole('form', { name: 'Progress scope' })
            .getByRole('group', { name: 'Time window' })
    ).toBeVisible();
    await expect(
        page.getByRole('heading', { name: 'At a glance' })
    ).toBeVisible();
    await expect(
        page.getByRole('heading', { name: 'Data coverage' })
    ).toBeVisible();

    const hasHorizontalOverflow = await page.evaluate(
        () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth + 1
    );
    expect(hasHorizontalOverflow).toBe(false);

    const primaryNav = page.getByRole('navigation', {
        name: 'Main tabs',
    });
    await expect(
        primaryNav.getByRole('link', {
            name: 'Progress',
            exact: true,
        })
    ).toHaveAttribute('aria-current', 'page');
    await expect(
        primaryNav.getByRole('link', {
            name: 'Stats',
            exact: true,
        })
    ).toHaveCount(0);
});
