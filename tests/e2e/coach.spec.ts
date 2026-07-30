import { expect, test, type Page } from '@playwright/test';

import { clickMove } from './support/board';

async function installDeterministicCoachEngine(page: Page) {
    await page.addInitScript(() => {
        type WorkerMessage = {
            type?: string;
            id?: string;
            fen?: string;
            multiPv?: number;
        };

        class DeterministicCoachWorker {
            onmessage:
                | ((event: MessageEvent<Record<string, unknown>>) => void)
                | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            postMessage(raw: unknown) {
                const message = raw as WorkerMessage;
                if (message.type === 'identity') {
                    queueMicrotask(() =>
                        this.onmessage?.(
                            new MessageEvent('message', {
                                data: {
                                    type: 'identity',
                                    identity: {
                                        name: 'Deterministic coach',
                                        source: 'e2e',
                                        options: {},
                                    },
                                },
                            })
                        )
                    );
                    return;
                }
                if (message.type !== 'start') return;

                const fen = String(message.fen ?? '');
                const side = fen.split(' ')[1] === 'b' ? 'b' : 'w';
                const afterF3 =
                    side === 'b' &&
                    fen.startsWith(
                        'rnbqkbnr/pppppppp/8/8/8/5P2/PPPPP1PP/'
                    );
                const afterE4 =
                    side === 'b' &&
                    fen.startsWith(
                        'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/'
                    );
                const roots =
                    side === 'w'
                        ? ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'b1c3']
                        : afterF3 || afterE4
                          ? [
                                'e7e5',
                                'd7d5',
                                'g8f6',
                                'c7c5',
                                'e7e6',
                            ]
                          : [
                                'g8f6',
                                'd7d5',
                                'e7e6',
                                'c7c5',
                                'b8c6',
                            ];
                const baseCp = afterF3 ? 300 : afterE4 ? -30 : 30;
                const baseWdl = afterF3
                    ? { win: 850, draw: 100, loss: 50 }
                    : afterE4
                      ? { win: 100, draw: 400, loss: 500 }
                    : { win: 500, draw: 400, loss: 100 };
                const count = Math.max(
                    1,
                    Math.min(roots.length, Number(message.multiPv) || 1)
                );
                const lines = roots.slice(0, count).map((move, index) => ({
                    multipv: index + 1,
                    score: { type: 'cp', value: baseCp - index * 12 },
                    wdl: baseWdl,
                    pvUci: [move],
                    depth: 16,
                    nodes: 90_000,
                    timeMs: 20,
                }));
                const update = {
                    fen,
                    depth: 16,
                    nodes: 90_000,
                    timeMs: 20,
                    lines,
                };
                queueMicrotask(() => {
                    this.onmessage?.(
                        new MessageEvent('message', {
                            data: {
                                type: 'update',
                                id: message.id,
                                update,
                            },
                        })
                    );
                    this.onmessage?.(
                        new MessageEvent('message', {
                            data: {
                                type: 'done',
                                id: message.id,
                                bestMoveUci: roots[0],
                                final: update,
                            },
                        })
                    );
                });
            }

            terminate() {}
            addEventListener() {}
            removeEventListener() {}
            dispatchEvent() {
                return true;
            }
        }

        Object.defineProperty(window, 'Worker', {
            configurable: true,
            writable: true,
            value: DeterministicCoachWorker,
        });
    });
}

test.describe('offline coach game', () => {
    test.beforeEach(async ({ page }) => {
        await installDeterministicCoachEngine(page);
        await page.goto('/~offline/coach');
    });

    async function startCoach(page: Page) {
        await page
            .getByRole('button', { name: 'Start coach game' })
            .click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
    }

    test('pauses before the bot replies and reuses the Practice analysis workspace', async ({
        page,
    }) => {
        await startCoach(page);
        await clickMove(page, 'f2', 'f3');

        const intervention = page.getByRole('region', {
            name: 'Coach intervention',
        });
        await expect(intervention).toBeVisible();
        await expect(page.locator('[data-coach-phase="mistake"]')).toBeVisible();
        await expect(intervention.getByText('+0.30')).toBeVisible();
        await expect(intervention.getByText('−3.00')).toBeVisible();
        await expect(
            intervention.getByText('W 50% · D 40% · L 10%')
        ).toBeVisible();
        await expect(
            intervention.getByText('W 5% · D 10% · L 85%')
        ).toBeVisible();
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveText('f3');
        await expect(
            page.locator('[data-coach-move-ply="1"]')
        ).toHaveCount(0);

        await intervention.getByRole('button', { name: 'Analyze' }).click();
        await expect(
            page.getByRole('heading', { name: 'Analyze the mistake' })
        ).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Coach mistake review' })
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { name: 'Live engine' })
        ).toBeVisible();
        await expect(
            page.getByRole('group', { name: 'Interactive analysis board' })
        ).toHaveAttribute('data-analysis-position-context', 'decision');

        await page
            .getByRole('button', { name: 'Back to paused game' })
            .click();
        await expect(intervention).toBeVisible();
        await intervention.getByRole('button', { name: 'Try again' }).click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveCount(0);

        await page.getByLabel('Keyboard move').fill('e4');
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Coach intervention' })
        ).toHaveCount(0);
    });

    test('can accept the caught move and lets the bot continue from it', async ({
        page,
    }) => {
        await startCoach(page);
        await clickMove(page, 'f2', 'f3');
        const intervention = page.getByRole('region', {
            name: 'Coach intervention',
        });
        await expect(intervention).toBeVisible();

        await intervention.getByRole('button', { name: 'Continue' }).click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Coach intervention' })
        ).toHaveCount(0);
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveText('f3');
        await expect(
            page.locator('[data-coach-move-ply="1"]')
        ).toBeVisible();
    });

    test('uses the exact user centipawn threshold', async ({ page }) => {
        await page.getByLabel('Centipawn loss threshold').fill('400');
        await startCoach(page);
        await clickMove(page, 'f2', 'f3');

        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Coach intervention' })
        ).toHaveCount(0);
        await expect(
            page.locator('[data-coach-move-ply="1"]')
        ).toBeVisible();
    });

    test('restores a paused decision after reload without letting the bot reply', async ({
        page,
    }) => {
        await startCoach(page);
        await clickMove(page, 'f2', 'f3');
        await expect(
            page.getByRole('region', { name: 'Coach intervention' })
        ).toBeVisible();

        await page.reload();
        const resume = page.getByText('Continue your saved game');
        await expect(resume).toBeVisible();
        await page
            .getByRole('button', { name: 'Continue game' })
            .click();

        await expect(
            page.getByRole('region', { name: 'Coach intervention' })
        ).toBeVisible();
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveText('f3');
        await expect(
            page.locator('[data-coach-move-ply="1"]')
        ).toHaveCount(0);
    });

    test('restores an active game from its local legal-move checkpoint', async ({
        page,
    }) => {
        await startCoach(page);
        await page.getByLabel('Keyboard move').fill('e4');
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();

        await page.reload();
        await expect(page.getByText('Continue your saved game')).toBeVisible();
        await page
            .getByRole('button', { name: 'Continue game' })
            .click();

        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveText('e4');
        await expect(
            page.locator('[data-coach-move-ply="1"]')
        ).toBeVisible();
    });
});
