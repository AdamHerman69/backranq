import { expect, test, type Page } from '@playwright/test';

import { COACH_OFFLINE_ACCESS_STORAGE_KEY } from '@/lib/coach/offlineAccess';
import { COACH_OFFLINE_OWNER_STORAGE_KEY } from '@/lib/coach/offlineOwner';

import { clickMove, square } from './support/board';

async function installDeterministicCoachEngine(page: Page) {
    await page.addInitScript(() => {
        type WorkerMessage = {
            type?: string;
            id?: string;
            fen?: string;
            multiPv?: number;
            rootMoves?: string[];
            seed?: number;
            maxNodes?: number;
        };

        class DeterministicCoachWorker {
            private readonly maia: boolean;
            onmessage:
                | ((event: MessageEvent<Record<string, unknown>>) => void)
                | null = null;
            onerror: ((event: ErrorEvent) => void) | null = null;

            constructor(url?: string | URL) {
                const workerUrl = String(url ?? '');
                this.maia =
                    workerUrl.includes('backranq-maia') ||
                    workerUrl.startsWith('blob:');
            }

            postMessage(raw: unknown) {
                const message = raw as WorkerMessage;
                if (this.maia) {
                    if (message.type === 'initialize') {
                        const flags = window as typeof window & {
                            __coachMaiaInitErrorOnce?: boolean;
                            __coachMaiaInitDelayMs?: number;
                        };
                        if (flags.__coachMaiaInitErrorOnce) {
                            flags.__coachMaiaInitErrorOnce = false;
                            queueMicrotask(() =>
                                this.onmessage?.(
                                    new MessageEvent('message', {
                                        data: {
                                            type: 'error',
                                            id: message.id,
                                            error: {
                                                code: 'DOWNLOAD_FAILED',
                                                message:
                                                    'Model download failed for the retry test.',
                                                recoverable: true,
                                            },
                                            status: {
                                                phase: 'error',
                                                progress: null,
                                                source: 'network',
                                                message:
                                                    'Model download failed for the retry test.',
                                                errorCode:
                                                    'DOWNLOAD_FAILED',
                                            },
                                        },
                                    })
                                )
                            );
                            return;
                        }
                        const ready = () =>
                            this.onmessage?.(
                                new MessageEvent('message', {
                                    data: {
                                        type: 'initialized',
                                        id: message.id,
                                        status: {
                                            phase: 'ready',
                                            progress: 1,
                                            source: 'cache',
                                            offlineReady: true,
                                            message:
                                                'Maia is ready from cache.',
                                        },
                                    },
                                })
                            );
                        if (flags.__coachMaiaInitDelayMs) {
                            window.setTimeout(
                                ready,
                                flags.__coachMaiaInitDelayMs
                            );
                        } else {
                            queueMicrotask(ready);
                        }
                        return;
                    }
                    if (message.type === 'select-move') {
                        const flags = window as typeof window & {
                            __coachMaiaMoveErrorOnce?: boolean;
                        };
                        if (flags.__coachMaiaMoveErrorOnce) {
                            flags.__coachMaiaMoveErrorOnce = false;
                            window.setTimeout(
                                () =>
                                    this.onmessage?.(
                                        new MessageEvent('message', {
                                            data: {
                                                type: 'error',
                                                id: message.id,
                                                error: {
                                                    code: 'RUNTIME_ERROR',
                                                    message:
                                                        'Maia move failed for the recovery test.',
                                                    recoverable: true,
                                                },
                                                status: {
                                                    phase: 'error',
                                                    progress: null,
                                                    source: 'cache',
                                                    message:
                                                        'Maia move failed for the recovery test.',
                                                    errorCode:
                                                        'RUNTIME_ERROR',
                                                },
                                            },
                                        })
                                    ),
                                100
                            );
                            return;
                        }
                        queueMicrotask(() =>
                            this.onmessage?.(
                                new MessageEvent('message', {
                                    data: {
                                        type: 'move',
                                        id: message.id,
                                        result: {
                                            moveUci: 'e2e4',
                                            probability: 0.32,
                                            candidateCount: 20,
                                            modelId:
                                                'maia3-simplified-browser',
                                            modelVersion:
                                                'maia3-simplified-fp16-v3',
                                            engineRevision:
                                                'maia3-sf16-v3:405bf76c:worker-v8:prep-v1:mulberry32-p95-t1-v1',
                                            samplerVersion:
                                                'mulberry32-top-p-v1',
                                            seed: message.seed,
                                            candidates: [
                                                {
                                                    moveUci: 'e2e4',
                                                    probability: 1,
                                                },
                                            ],
                                        },
                                    },
                                })
                            )
                        );
                        return;
                    }
                }
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
                if ((Number(message.multiPv) || 1) > 1) {
                    const counters = window as typeof window & {
                        __coachStockfishOpponentSearches?: number;
                    };
                    counters.__coachStockfishOpponentSearches =
                        (counters.__coachStockfishOpponentSearches ?? 0) +
                        1;
                }
                if (message.rootMoves?.length) {
                    const counters = window as typeof window & {
                        __coachTacticalGuardSearches?: number;
                    };
                    counters.__coachTacticalGuardSearches =
                        (counters.__coachTacticalGuardSearches ?? 0) +
                        1;
                }
                if (
                    !message.rootMoves?.length &&
                    message.maxNodes === 180_000
                ) {
                    const counters = window as typeof window & {
                        __coachTacticalGuardSeedSearches?: number;
                    };
                    counters.__coachTacticalGuardSeedSearches =
                        (counters.__coachTacticalGuardSeedSearches ??
                            0) + 1;
                }

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
                    message.rootMoves?.length
                        ? message.rootMoves
                        : side === 'w'
                          ? [
                                'e2e4',
                                'd2d4',
                                'g1f3',
                                'c2c4',
                                'b1c3',
                            ]
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
        await page.addInitScript(
            ([ownerKey, accessKey, ownerId]) => {
                window.localStorage.setItem(ownerKey, ownerId);
                window.localStorage.setItem(
                    accessKey,
                    JSON.stringify({
                        version: 1,
                        ownerId,
                        grantedAt: Date.now(),
                    })
                );
            },
            [
                COACH_OFFLINE_OWNER_STORAGE_KEY,
                COACH_OFFLINE_ACCESS_STORAGE_KEY,
                'e2e-coach-user',
            ]
        );
        await page.goto('/~offline/coach');
    });

    async function startCoach(page: Page) {
        await page
            .getByRole('button', { name: 'Start coach game' })
            .click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
    }

    test('mobile coach board treats ordinary finger jitter as an intentional tap', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await startCoach(page);

        const sourceBox = await square(page, 'g1').boundingBox();
        expect(sourceBox).not.toBeNull();
        const x = sourceBox!.x + sourceBox!.width / 2;
        const y = sourceBox!.y + sourceBox!.height / 2;
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
                { x, y, radiusX: 1, radiusY: 1, force: 1 },
            ],
        });
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [
                {
                    x: x + 2,
                    y: y + 1,
                    radiusX: 1,
                    radiusY: 1,
                    force: 1,
                },
            ],
        });
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });

        const board = page.getByRole('group', {
            name: 'Coach game board',
        });
        await expect(board).toHaveAttribute(
            'data-coach-selected-square',
            'g1'
        );
        const targetBox = await square(page, 'f3').boundingBox();
        expect(targetBox).not.toBeNull();
        const targetX = targetBox!.x + targetBox!.width / 2;
        const targetY = targetBox!.y + targetBox!.height / 2;
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [
                {
                    x: targetX,
                    y: targetY,
                    radiusX: 1,
                    radiusY: 1,
                    force: 1,
                },
            ],
        });
        await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchEnd',
            touchPoints: [],
        });
        await expect(page.locator('[data-coach-move-ply="0"]')).toHaveText(
            'Nf3'
        );
    });

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
        await expect(
            page.getByRole('group', { name: 'Coach game board' })
        ).toHaveAttribute('data-coach-marker-square', 'f3');
        await expect(
            page
                .getByRole('group', { name: 'Coach game board' })
                .getByRole('img', { name: 'Coach pause on f3' })
        ).toBeVisible();
        await intervention.getByText('Engine evidence').click();
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
        ).toHaveCount(0);
        await expect(
            page.getByRole('tab', { name: 'Review', exact: true })
        ).toHaveAttribute('data-state', 'active');
        await expect(
            page.getByRole('group', { name: 'Interactive analysis board' })
        ).toHaveAttribute('data-analysis-position-context', 'decision');
        await page.getByRole('tab', { name: 'Moves', exact: true }).click();
        await expect(page.getByText('Session only')).toBeVisible();
        await page.getByRole('tab', { name: 'Engine', exact: true }).click();
        await expect(
            page.getByRole('heading', { name: 'Live engine' })
        ).toBeVisible();
        await page.waitForTimeout(500);
        expect(
            await page.evaluate(async () =>
                (await indexedDB.databases()).some(
                    (database) =>
                        database.name === 'backranq-analysis'
                )
            )
        ).toBe(false);

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

    test('keeps mobile pause actions directly below the board and above app navigation', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await startCoach(page);

        const board = page.getByRole('group', { name: 'Coach game board' });
        const bottomNav = page.getByRole('navigation', { name: 'Main tabs' });
        const [boardBeforeMove, navBeforeMove] = await Promise.all([
            board.boundingBox(),
            bottomNav.boundingBox(),
        ]);
        expect(boardBeforeMove).not.toBeNull();
        expect(navBeforeMove).not.toBeNull();
        expect(boardBeforeMove!.y).toBeGreaterThanOrEqual(0);
        expect(boardBeforeMove!.y + boardBeforeMove!.height).toBeLessThanOrEqual(
            navBeforeMove!.y + 1
        );

        await clickMove(page, 'f2', 'f3');
        const actions = page.getByRole('group', { name: 'Coach pause actions' });
        await expect(actions).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Try again' })).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Analyze' })).toBeVisible();
        await expect(actions.getByRole('button', { name: 'Continue' })).toBeVisible();

        const [boardBox, actionsBox, navBox] = await Promise.all([
            board.boundingBox(),
            actions.boundingBox(),
            bottomNav.boundingBox(),
        ]);
        expect(boardBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(navBox).not.toBeNull();
        expect(actionsBox!.y).toBeGreaterThanOrEqual(
            boardBox!.y + boardBox!.height - 1
        );
        expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(navBox!.y + 1);
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

    test('locks a Maia Elo opponent while Stockfish remains judge-only', async ({
        page,
    }) => {
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia 3 · human-like/,
            })
            .click();
        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();
        await expect(
            page.getByText(
                'Maia 3 · simplified browser model · maia3-simplified-fp16-v3'
            )
        ).toBeVisible();
        await page.getByLabel('Maia opponent Elo').fill('1750');
        await page.getByLabel('Your color').click();
        await page.getByRole('option', { name: 'Black' }).click();

        await page
            .getByRole('button', { name: 'Start coach game' })
            .click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveText('e4');
        await expect(
            page.getByText('Maia 3 · 1750 Elo · stop at ≥ 100 cp')
        ).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (
                        window as typeof window & {
                            __coachStockfishOpponentSearches?: number;
                        }
                    ).__coachStockfishOpponentSearches ?? 0
            )
        ).toBe(0);

        await page.reload();
        await expect(page.getByText('Continue your saved game')).toBeVisible();
        await expect(
            page.getByText(/Maia 3 · 1750 Elo.*100 cp threshold/)
        ).toBeVisible();
        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();
        await page
            .getByRole('button', { name: 'Continue game' })
            .click();
        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.getByText('Maia 3 · 1750 Elo · stop at ≥ 100 cp')
        ).toBeVisible();
    });

    test('offers Maia with a configurable tactical guard and verifies candidates locally', async ({
        page,
    }) => {
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia \+ tactical guard/,
            })
            .click();
        await expect(
            page.getByLabel('Tactical guard centipawn threshold')
        ).toHaveValue('100');
        await page
            .getByLabel('Tactical guard centipawn threshold')
            .fill('120');
        await page.getByLabel('Maia opponent Elo').fill('1650');
        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();
        await page.getByLabel('Your color').click();
        await page.getByRole('option', { name: 'Black' }).click();
        await page
            .getByRole('button', { name: 'Start coach game' })
            .click();

        await expect(page.locator('[data-coach-phase="player"]')).toBeVisible();
        await expect(
            page.getByText(
                'Maia + tactical guard · 1650 Elo · guard at 120 cp · stop at ≥ 100 cp'
            )
        ).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (
                        window as typeof window & {
                            __coachTacticalGuardSearches?: number;
                        }
                    ).__coachTacticalGuardSearches ?? 0
            )
        ).toBe(1);
        expect(
            await page.evaluate(
                () =>
                    (
                        window as typeof window & {
                            __coachTacticalGuardSeedSearches?: number;
                        }
                    ).__coachTacticalGuardSeedSearches ?? 0
            )
        ).toBe(1);
    });

    test('shows a recoverable Maia load error and retries successfully', async ({
        page,
    }) => {
        await page.evaluate(() => {
            (
                window as typeof window & {
                    __coachMaiaInitErrorOnce?: boolean;
                }
            ).__coachMaiaInitErrorOnce = true;
        });
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia 3 · human-like/,
            })
            .click();
        await expect(
            page.locator('[data-maia-phase="error"]')
        ).toBeVisible();
        await expect(
            page.getByText(
                'Model download failed for the retry test.',
                { exact: true }
            )
        ).toBeVisible();
        await page
            .getByRole('button', {
                name: 'Retry Maia preparation',
            })
            .click();

        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Start coach game' })
        ).toBeEnabled();
    });

    test('restarts Maia from local data before resuming an interrupted move', async ({
        page,
    }) => {
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia 3 · human-like/,
            })
            .click();
        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();
        await page.getByLabel('Your color').click();
        await page.getByRole('option', { name: 'Black' }).click();
        await page.evaluate(() => {
            (
                window as typeof window & {
                    __coachMaiaMoveErrorOnce?: boolean;
                }
            ).__coachMaiaMoveErrorOnce = true;
        });

        await page
            .getByRole('button', { name: 'Start coach game' })
            .click();
        await expect(
            page.locator('[data-coach-phase="error"]')
        ).toBeVisible();
        await expect(
            page.getByText(
                /Maia move failed for the recovery test/
            )
        ).toBeVisible();

        await page
            .getByRole('button', { name: 'Restart and resume' })
            .click();
        await expect(
            page.locator('[data-coach-phase="player"]')
        ).toBeVisible();
        await expect(
            page.locator('[data-coach-move-ply="0"]')
        ).toHaveText('e4');
    });

    test('does not resurrect Maia after recovery is abandoned', async ({
        page,
    }) => {
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia 3 · human-like/,
            })
            .click();
        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();
        await page.getByLabel('Your color').click();
        await page.getByRole('option', { name: 'Black' }).click();
        await page.evaluate(() => {
            const flags = window as typeof window & {
                __coachMaiaMoveErrorOnce?: boolean;
                __coachMaiaInitDelayMs?: number;
            };
            flags.__coachMaiaMoveErrorOnce = true;
        });
        await page
            .getByRole('button', { name: 'Start coach game' })
            .click();
        await expect(
            page.locator('[data-coach-phase="error"]')
        ).toBeVisible();
        await page.evaluate(() => {
            (
                window as typeof window & {
                    __coachMaiaInitDelayMs?: number;
                }
            ).__coachMaiaInitDelayMs = 300;
        });

        await page
            .getByRole('button', { name: 'Restart and resume' })
            .click();
        await page.getByRole('button', { name: 'New game' }).click();
        await page
            .getByRole('button', { name: 'Start a new game' })
            .click();

        await expect(
            page.getByRole('button', { name: 'Start coach game' })
        ).toBeVisible();
        await page.waitForTimeout(500);
        await expect(
            page.locator('[data-coach-phase="player"]')
        ).toHaveCount(0);
        await expect(
            page.locator('[data-coach-phase="error"]')
        ).toHaveCount(0);
    });

    test('keeps the Maia setup usable without horizontal overflow on mobile', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia 3 · human-like/,
            })
            .click();
        await expect(
            page.locator('[data-maia-phase="ready"]')
        ).toBeVisible();

        expect(
            await page.evaluate(
                () =>
                    document.documentElement.scrollWidth <=
                    window.innerWidth
            )
        ).toBe(true);
        await expect(
            page.getByLabel('Maia opponent Elo')
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Start coach game' })
        ).toBeVisible();
        const startPosition = await page
            .getByRole('button', { name: 'Start coach game' })
            .evaluate((element) => {
                const rect = element.getBoundingClientRect();
                return {
                    top: rect.top,
                    bottom: rect.bottom,
                    viewportHeight: window.innerHeight,
                };
            });
        expect(startPosition.top).toBeGreaterThanOrEqual(0);
        expect(startPosition.bottom).toBeLessThanOrEqual(
            startPosition.viewportHeight
        );
    });

    test('removes saved Maia data and returns to Stockfish', async ({
        page,
    }) => {
        await page.getByLabel('Opponent model').click();
        await page
            .getByRole('option', {
                name: /^Maia 3 · human-like/,
            })
            .click();
        await expect(
            page.getByText('Human-like opponent saved offline')
        ).toBeVisible();

        await page
            .getByRole('button', {
                name: 'Remove Maia data',
            })
            .click();
        await page
            .getByRole('alertdialog')
            .getByRole('button', { name: 'Remove Maia data' })
            .click();

        await expect(page.getByLabel('Opponent model')).toContainText(
            'Stockfish'
        );
        await expect(page.locator('[data-maia-phase]')).toHaveCount(0);
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

    test('does not recreate a cleared game from a delayed checkpoint save', async ({
        page,
    }) => {
        await startCoach(page);
        await page.getByLabel('Keyboard move').fill('e4');
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await page.getByRole('button', { name: 'New game' }).click();
        await page
            .getByRole('button', { name: 'Start a new game' })
            .click();
        await expect(
            page.getByRole('button', { name: 'Start coach game' })
        ).toBeVisible();

        await page.waitForTimeout(750);
        await page.reload();
        await expect(
            page.getByText('Continue your saved game')
        ).toHaveCount(0);
    });

    test('does not recreate a signed-out owner checkpoint from another open tab', async ({
        page,
        context,
    }) => {
        await startCoach(page);
        const signOutTab = await context.newPage();
        await signOutTab.goto('/~offline/coach');
        await signOutTab.evaluate(async (ownerId) => {
            const broadcastKey =
                'backranq.coach.signOutPersistenceBlock.v1';
            localStorage.setItem(
                broadcastKey,
                JSON.stringify({
                    ownerId,
                    nonce: 'e2e-sign-out',
                })
            );
            localStorage.removeItem(broadcastKey);
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open('backranq-coach', 1);
                request.onerror = () => reject(request.error);
                request.onsuccess = () => {
                    const database = request.result;
                    const transaction = database.transaction(
                        'coach-sessions',
                        'readwrite'
                    );
                    const store =
                        transaction.objectStore('coach-sessions');
                    store.delete(
                        `active:${encodeURIComponent(ownerId)}`
                    );
                    store.put({
                        key: `signed-out:${encodeURIComponent(ownerId)}`,
                        blockedAt: Date.now(),
                    });
                    transaction.oncomplete = () => {
                        database.close();
                        resolve();
                    };
                    transaction.onerror = () =>
                        reject(transaction.error);
                };
            });
        }, 'e2e-coach-user');
        await signOutTab.close();
        await page.waitForTimeout(100);

        await page.getByLabel('Keyboard move').fill('e4');
        await page.getByRole('button', { name: 'Play', exact: true }).click();
        await page.waitForTimeout(500);
        await page.reload();

        await expect(
            page.getByText('Continue your saved game')
        ).toHaveCount(0);
    });
});
