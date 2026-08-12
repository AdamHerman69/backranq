import { expect, test } from '@playwright/test';
import { E2E_GAMES, E2E_USER } from './support/fixtures';

test.describe('authenticated games library', () => {
    test('treats disabled automation as an ordinary unanalyzed state, not a credit error', async ({
        page,
    }) => {
        await page.route('**/api/sync/status', async (route) => {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    linked: {
                        lichessUsername: 'e2e-user',
                        chesscomUsername: null,
                    },
                    lastSync: { lichess: null, chesscom: null },
                    gameAutomation: {
                        paused: true,
                        rules: {
                            lichess: { rapid: 'IMPORT_ONLY' },
                            chesscom: { rapid: 'IGNORE' },
                        },
                        schedule: '0 3 * * *',
                        states: { lichess: null, chesscom: null },
                    },
                    analysisJobs: { queued: 0, running: 0, failed: 0 },
                    inventory: {
                        totalImported: 3,
                        analyzed: 1,
                        unanalyzed: 2,
                    },
                    automation: {
                        policy: { enabled: false },
                        backlog: {
                            eligible: 2,
                            eligibleAtLeast: 2,
                            waitingForCredits: 2,
                            waitingForCreditsAtLeast: 2,
                            blockedReason: 'disabled',
                            queued: 0,
                            running: 0,
                            terminalFailed: 0,
                            countsExact: true,
                            scannedCandidates: 2,
                            scanLimit: 250,
                        },
                        capacity: {
                            reservableCredits: 0,
                            currentBalance: 0,
                            creditReserve: 10,
                            dailyRemaining: 10,
                            monthlyRemaining: 50,
                            planMonthlyRemaining: 50,
                            blockingReason: 'credits',
                        },
                    },
                }),
            });
        });

        await page.goto('/games');
        await expect(
            page.getByText(/Automatic server analysis is off/)
        ).toBeVisible();
        await expect(
            page.getByRole('link', { name: 'Manage automation' })
        ).toBeVisible();
        await expect(
            page.getByRole('link', { name: 'Get credits' })
        ).toHaveCount(0);
    });

    test('keeps routine sync compact and separates historical import', async ({
        page,
    }) => {
        await page.goto('/games');

        await expect(
            page.getByRole('button', { name: 'Sync now' })
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Import older games' })
        ).toBeVisible();
        await expect(page.getByText(/^Imported\s+\d+/)).toBeVisible();
        await expect(page.getByText(/^Ready\s+\d+/)).toBeVisible();
        await expect(page.getByText(/^Queued\s+\d+/)).toBeVisible();
        await expect(page.getByText(/^Analyzing\s+\d+/)).toBeVisible();
        await expect(page.getByText(/^Failed\s+\d+/)).toBeVisible();

        await page.getByRole('button', { name: 'Import older games' }).click();
        const historyDialog = page.getByRole('dialog', {
            name: 'Import older games',
        });
        await expect(historyDialog).toBeVisible();
        await expect(
            historyDialog.getByText(
                /up to 2,000 older games per connected source/
            )
        ).toBeVisible();
        await expect(
            historyDialog.getByText(/Syncing is free/)
        ).toBeVisible();
        await expect(
            historyDialog.getByText(/Analysis is separate/)
        ).toBeVisible();
        await historyDialog.getByRole('button', { name: 'Close' }).click();
    });

    test('cancels an in-flight history fetch without trapping the dialog', async ({
        page,
    }) => {
        let releaseFetch!: () => void;
        let markFetchStarted!: () => void;
        const fetchStarted = new Promise<void>((resolve) => {
            markFetchStarted = resolve;
        });
        const fetchReleased = new Promise<void>((resolve) => {
            releaseFetch = resolve;
        });
        await page.route('**/api/sync/history?**', async (route) => {
            markFetchStarted();
            await fetchReleased;
            try {
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        ownerId: E2E_USER.id,
                        provider: 'lichess',
                        username: 'e2e-user',
                        rows: [],
                        fetched: 0,
                        existingCount: 0,
                        truncatedReason: null,
                        providerComplete: true,
                        nextCursor: null,
                        page: 1,
                        allowance: {
                            limit: 2_000,
                            used: 0,
                            remaining: 2_000,
                        },
                    }),
                });
            } catch {
                // The Cancel action aborts this provider request.
            }
        });

        await page.goto('/games');
        await page.getByRole('button', { name: 'Import older games' }).click();
        const dialog = page.getByRole('dialog', {
            name: 'Import older games',
        });
        await dialog
            .getByRole('button', { name: 'Find older games' })
            .click();
        await fetchStarted;

        await expect(
            dialog.getByRole('button', { name: 'Cancel' })
        ).toBeEnabled();
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await expect(dialog).toBeHidden();
        releaseFetch();
    });

    test('makes partial-page skipping explicit and sends the signed continuation cursor', async ({
        page,
    }) => {
        const requestedUrls: string[] = [];
        await page.route('**/api/sync/history?**', async (route) => {
            const url = new URL(route.request().url());
            requestedUrls.push(url.toString());
            const provider = url.searchParams.get('provider');
            const cursor = url.searchParams.get('cursor');
            const isInitialLichess =
                provider === 'lichess' && cursor === null;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    provider,
                    username: 'e2e-user',
                    rows: isInitialLichess
                        ? [
                              {
                                  game: {
                                      id: 'lichess:history-page-one',
                                      provider: 'lichess',
                                      playedAt:
                                          '2026-07-04T12:00:00.000Z',
                                      timeClass: 'rapid',
                                      rated: true,
                                      white: { name: 'e2e-user' },
                                      black: { name: 'Opponent' },
                                      result: '1-0',
                                      pgn: '[Result "1-0"]\\n\\n1. e4 e5 1-0',
                                  },
                                  ticket: 'signed-ticket',
                              },
                          ]
                        : [],
                    fetched: isInitialLichess ? 1 : 0,
                    existingCount: 0,
                    truncatedReason: isInitialLichess
                        ? 'provider-page'
                        : null,
                    providerComplete: !isInitialLichess,
                    nextCursor: isInitialLichess
                        ? 'signed-next-page'
                        : null,
                    page: cursor ? 2 : 1,
                    allowance: {
                        limit: 2_000,
                        used: 0,
                        remaining: 2_000,
                    },
                }),
            });
        });

        await page.goto('/games');
        await page.getByRole('button', { name: 'Import older games' }).click();
        const dialog = page.getByRole('dialog', {
            name: 'Import older games',
        });
        await dialog
            .getByRole('button', { name: 'Find older games' })
            .click();
        await expect(dialog.getByText(/Page 1/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Select none' }).click();
        await dialog
            .getByRole('button', {
                name: 'Skip 1 and continue older',
            })
            .click();

        const confirmation = page.getByRole('alertdialog', {
            name: 'Continue past unimported games?',
        });
        await expect(
            confirmation.getByText(/Start over/)
        ).toBeVisible();
        await confirmation
            .getByRole('button', {
                name: 'Skip 1 and continue',
            })
            .click();

        await expect
            .poll(() =>
                requestedUrls.some((value) =>
                    value.includes('cursor=signed-next-page')
                )
            )
            .toBe(true);
    });

    test('imports a 580-game Chess.com page in bounded batches before offering its continuation', async ({
        page,
    }) => {
        test.setTimeout(60_000);
        const rows = Array.from({ length: 580 }, (_, index) => ({
            game: {
                id: `chesscom:history-${index}`,
                provider: 'chesscom',
                playedAt: new Date(
                    Date.parse('2026-07-30T12:00:00.000Z') - index * 1_000
                ).toISOString(),
                timeClass: 'rapid',
                rated: true,
                white: { name: E2E_USER.username },
                black: { name: `Opponent ${index}` },
                result: '1-0',
                pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
            },
            ticket: `signed-ticket-${index}`,
        }));
        let historyReads = 0;
        const batchSizes: number[] = [];
        let imported = 0;

        await page.route('**/api/sync/history?**', async (route) => {
            historyReads += 1;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    provider: 'chesscom',
                    username: E2E_USER.username,
                    rows,
                    fetched: rows.length,
                    existingCount: 0,
                    truncatedReason: 'provider-page',
                    providerComplete: false,
                    nextCursor: 'signed-older-page',
                    page: 1,
                    allowance: {
                        limit: 2_000,
                        used: 0,
                        remaining: 2_000,
                    },
                }),
            });
        });
        await page.route('**/api/sync/history', async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            const body = route.request().postDataJSON() as {
                items: Array<{ game: { id: string } }>;
            };
            batchSizes.push(body.items.length);
            imported += body.items.length;
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    provider: 'chesscom',
                    imported: body.items.length,
                    duplicates: 0,
                    failed: 0,
                    capRejected: 0,
                    ids: Object.fromEntries(
                        body.items.map((item) => [
                            item.game.id,
                            `db-${item.game.id}`,
                        ])
                    ),
                    errors: [],
                    allowance: {
                        limit: 2_000,
                        used: imported,
                        remaining: 2_000 - imported,
                    },
                }),
            });
        });

        await page.goto('/games');
        await page.getByRole('button', { name: 'Import older games' }).click();
        const dialog = page.getByRole('dialog', {
            name: 'Import older games',
        });
        await dialog.getByRole('checkbox', { name: /Lichess/ }).uncheck();
        await dialog
            .getByRole('button', { name: 'Find older games' })
            .click();
        await expect(dialog.getByText(/New:\s*580/)).toBeVisible();
        await dialog.getByRole('button', { name: 'Import selected' }).click();
        await expect(dialog.getByText('Import complete')).toBeVisible();

        expect(batchSizes).toEqual([200, 200, 180]);
        expect(historyReads).toBe(1);
        await expect(
            dialog.getByRole('button', {
                name: 'Continue to older games',
            })
        ).toBeVisible();
    });

    test('uses the signed-in player perspective for results and filters', async ({
        page,
    }) => {
        await page.goto('/games?result=wins');

        await expect(page).toHaveURL(/\/games\?result=wins/);
        await expect(
            page.getByRole('heading', { name: 'Games', exact: true })
        ).toBeVisible();
        await expect(page.getByText('2 games')).toBeVisible();
        await expect(page.getByText('TacticalTester (1794)')).toBeVisible();
        await expect(page.getByText('PromotionTester (1701)')).toBeVisible();
        await expect(page.getByText('W', { exact: true })).toHaveCount(2);
        await expect(page.getByText('You: Black')).toBeVisible();

        await page.goto('/games?result=losses');
        await expect(
            page.getByRole('main').getByText('0 games', { exact: true })
        ).toBeVisible();
        await expect(page.getByText('TacticalTester (1794)')).toHaveCount(0);
    });

    test('reviews credit and deletion impact before bulk actions', async ({
        page,
    }) => {
        await page.goto('/games');
        await page.getByRole('button', { name: 'Select games' }).click();
        await page.getByRole('checkbox', { name: 'Select game' }).first().check();
        await expect(page.getByText('1 selected')).toBeVisible();

        await page.getByRole('button', { name: 'Reevaluate' }).click();
        const reanalyzeDialog = page.getByRole('alertdialog', {
            name: 'Re-analyze 1 selected game?',
        });
        await expect(reanalyzeDialog).toBeVisible();
        await expect(
            reanalyzeDialog.getByText('Requested maximum cost')
        ).toBeVisible();
        await expect(
            reanalyzeDialog.getByText('Current credit balance', { exact: true })
        ).toBeVisible();
        await expect(
            reanalyzeDialog.getByText('Manual reservable capacity')
        ).toBeVisible();
        await expect(reanalyzeDialog.getByText('Safety floor')).toBeVisible();
        await expect(
            reanalyzeDialog.getByText(/Attempt history is preserved/)
        ).toBeVisible();
        await reanalyzeDialog.getByRole('button', { name: 'Cancel' }).click();

        await page.getByRole('button', { name: 'Delete' }).click();
        const deleteDialog = page.getByRole('alertdialog', {
            name: 'Permanently delete 1 selected game?',
        });
        await expect(deleteDialog).toBeVisible();
        await expect(
            deleteDialog.getByText(
                /permanently removes every associated practice position/
            )
        ).toBeVisible();
        await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
    });

    test('lets a background queue dialog close while the request is pending', async ({
        page,
    }) => {
        let releaseQueue!: () => void;
        let markQueueStarted!: () => void;
        const queueStarted = new Promise<void>((resolve) => {
            markQueueStarted = resolve;
        });
        const queueReleased = new Promise<void>((resolve) => {
            releaseQueue = resolve;
        });
        await page.route('**/api/analysis/batches', async (route) => {
            if (route.request().method() !== 'POST') {
                await route.continue();
                return;
            }
            const request = route.request().postDataJSON() as {
                requestId: string;
            };
            markQueueStarted();
            await queueReleased;
            await route.fulfill({
                status: 202,
                contentType: 'application/json',
                body: JSON.stringify({
                    batch: {
                        id: '00000000-0000-4000-a000-000000000001',
                        requestId: request.requestId,
                        status: 'QUEUED',
                        counts: {
                            total: 1,
                            pending: 0,
                            queued: 1,
                            running: 0,
                            succeeded: 0,
                            failed: 0,
                            jobFailed: 0,
                            skipped: 0,
                        },
                    },
                }),
            });
        });

        await page.goto(`/games/${E2E_GAMES.standard}`);
        await page.getByRole('button', { name: 'More game actions' }).click();
        await page
            .getByRole('menuitem', { name: 'Re-analyze in background' })
            .click();
        const dialog = page.getByRole('alertdialog', {
            name: 'Re-analyze this game on the server?',
        });
        await dialog
            .getByRole('button', { name: 'Queue server re-analysis' })
            .click();
        await queueStarted;

        const closeButton = dialog.getByText('Close', { exact: true });
        await expect(closeButton).toBeEnabled();
        await closeButton.click();
        await expect(dialog).toBeHidden();
        releaseQueue();
    });
});
