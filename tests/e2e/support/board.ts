import { expect, type Page } from '@playwright/test';

export function square(page: Page, name: string) {
    return page.locator(`[data-square="${name}"]`).filter({ visible: true });
}

export async function waitForBoard(page: Page) {
    await expect(square(page, 'e4')).toBeVisible({
        timeout: 15_000,
    });
}

export async function clickMove(page: Page, from: string, to: string) {
    await waitForBoard(page);
    await square(page, from).click();
    await square(page, to).click();
}

export async function dragMove(page: Page, from: string, to: string) {
    await waitForBoard(page);
    const source = square(page, from);
    const target = square(page, to);
    await expect(source).toBeVisible();
    await expect(target).toBeVisible();

    // Authenticated E2E runs disable unrelated background-analysis polling, so
    // the board remains stable while we use real pointer events for dnd-kit.
    await source.hover();
    await page.mouse.down();
    const targetBox = await target.boundingBox();
    if (!targetBox) {
        await page.mouse.up();
        throw new Error(`Could not measure chess move ${from}-${to}.`);
    }
    await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 12 }
    );
    await page.mouse.up();
}
