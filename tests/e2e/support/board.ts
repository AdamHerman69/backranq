import { expect, type Page } from '@playwright/test';

export function square(page: Page, name: string) {
    return page.locator(`[data-square="${name}"]`);
}

export async function waitForBoard(page: Page) {
    await expect(square(page, 'e4')).toBeVisible();
}

export async function clickMove(page: Page, from: string, to: string) {
    await waitForBoard(page);
    await square(page, from).click();
    await square(page, to).click();
}

export async function dragMove(page: Page, from: string, to: string) {
    await waitForBoard(page);
    const source = await square(page, from).boundingBox();
    const target = await square(page, to).boundingBox();
    if (!source || !target) {
        throw new Error(`Could not measure chess move ${from}-${to}.`);
    }

    await page.mouse.move(
        source.x + source.width / 2,
        source.y + source.height / 2
    );
    await page.mouse.down();
    await page.mouse.move(
        target.x + target.width / 2,
        target.y + target.height / 2,
        { steps: 12 }
    );
    await page.mouse.up();
}
