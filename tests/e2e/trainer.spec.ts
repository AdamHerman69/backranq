import { expect, test } from '@playwright/test';

import { clickMove, dragMove, square, waitForBoard } from './support/board';
import { resetE2eTrainingAttempts } from './support/database';
import {
    E2E_USER,
    E2E_TRAINING_MOMENTS,
    practicePath,
} from './support/fixtures';

test.describe('authenticated personal decision practice', () => {
    test.beforeEach(async () => {
        await resetE2eTrainingAttempts();
    });

    test('does not retain the legacy training route', async ({ page }) => {
        const response = await page.goto('/training');

        expect(response?.status()).toBe(404);
        expect(new URL(page.url()).pathname).toBe('/training');
    });

    test('always shows legal destinations after selecting a piece', async ({
        page,
    }) => {
        await page.goto(practicePath(E2E_TRAINING_MOMENTS.wrongMove));
        await waitForBoard(page);

        const board = page.locator('[data-board-stage]');
        await square(page, 'g1').click();

        await expect(board).toHaveAttribute(
            'data-board-selected-square',
            'g1'
        );
        await expect(
            board.locator('[data-legal-move-target="f3"]')
        ).toBeVisible();
        await expect(
            board.locator('[data-legal-move-target="h3"]')
        ).toBeVisible();
        await expect(
            board.locator('[data-legal-move-target="e2"]')
        ).toBeVisible();
    });

    test('keeps every training prompt neutral and discloses context only after grading', async ({
        page,
    }) => {
        await page.goto(practicePath(E2E_TRAINING_MOMENTS.wrongMove));
        await expect(
            page.getByRole('heading', { name: 'Practice', exact: true })
        ).toBeVisible();
        await expect(
            page.getByText('White to move — find the best move')
        ).toBeVisible();
        await expect(page.getByText("King's Pawn Game")).toHaveCount(0);
        await expect(page.getByText(/mistake/i)).toHaveCount(0);
        await expect(page.getByText(/quiet move/i)).toHaveCount(0);

        const board = page.getByRole('group', {
            name: 'White to move — find the best move',
        });
        const decisionFen = await board.getAttribute('data-board-fen');

        await clickMove(page, 'f1', 'c4');

        await expect(board).toHaveAttribute(
            'data-board-marker',
            'REPEATED_MISTAKE'
        );
        await expect(board).toHaveAttribute(
            'data-board-marker-square',
            'c4'
        );
        await expect(
            board.getByRole('img', { name: 'Repeated mistake on c4' })
        ).toBeVisible();
        await expect(board).toHaveAttribute('data-board-last-move', 'f1c4');
        expect(await board.getAttribute('data-board-fen')).not.toBe(
            decisionFen
        );
        await expect(
            page.getByText('That repeats the mistake from the game.')
        ).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Position review' })
        ).toBeVisible();
        await expect(page.getByText('Your game mistake')).toBeVisible();
        await expect(
            page
                .getByRole('region', { name: 'Position review' })
                .getByText('Nf3', { exact: true })
                .first()
        ).toBeVisible();

        await page
            .getByRole('button', { name: 'Show best', exact: true })
            .first()
            .click();
        await expect(board).toHaveAttribute(
            'data-board-stage',
            'REVIEW_DECISION'
        );
        await expect(board).toHaveAttribute(
            'data-board-fen',
            decisionFen ?? ''
        );
    });

    test('grades a downloaded move before background history sync completes', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.wrongMove;
        let releaseRequest!: () => void;
        const requestReleased = new Promise<void>((resolve) => {
            releaseRequest = resolve;
        });
        await page.route(
            `**/api/training/moments/${momentId}/attempts`,
            async (route) => {
                await requestReleased;
                await route.continue();
            }
        );
        await page.goto(practicePath(momentId));

        await dragMove(page, 'g1', 'f3');

        await expect(
            page.getByText('Best move — well found.')
        ).toBeVisible();
        releaseRequest();
    });

    test('replays a downloaded opponent move and finishes the line locally', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.dragMove;
        let requestCount = 0;
        await page.route(
            `**/api/training/moments/${momentId}/attempts`,
            async (route) => {
                requestCount += 1;
                await route.continue();
            }
        );

        await page.goto(practicePath(momentId));
        const board = page.getByRole('group', {
            name: 'White to move — find the best move',
        });
        await dragMove(page, 'g1', 'f3');
        await expect(
            page.getByText('Opponent replied. Find the best move.')
        ).toBeVisible();
        await expect(board).toHaveAttribute('data-board-last-move', 'b8c6');
        await expect(board).not.toHaveAttribute('data-board-marker', /.+/);
        await expect(page.getByText(/step \d+ \/ \d+/i)).toHaveCount(0);
        await expect(page.getByText(/moves? remaining/i)).toHaveCount(0);
        expect(requestCount).toBe(0);

        await dragMove(page, 'f1', 'b5');
        await expect(board).toHaveAttribute('data-board-marker', 'BEST');
        await expect(
            board.getByRole('img', { name: 'Best move on b5' })
        ).toBeVisible();
        await expect(
            page.getByText('Best move — well found.')
        ).toBeVisible();
        await expect.poll(() => requestCount).toBe(1);
    });

    test('requires confirmation before reveal', async ({ page }) => {
        const momentId = E2E_TRAINING_MOMENTS.reveal;
        await page.goto(practicePath(momentId));
        await waitForBoard(page);

        await page.getByRole('button', { name: 'Reveal', exact: true }).click();
        const dialog = page.getByRole('dialog', {
            name: 'Reveal this position?',
        });
        await expect(dialog).toBeVisible();
        await expect(page.getByText('Best move', { exact: true })).toHaveCount(
            0
        );

        const recorded = page.waitForResponse(
            (response) =>
                response.url().includes(
                    `/api/training/moments/${momentId}/attempts`
                ) && response.request().method() === 'POST'
        );
        await dialog
            .getByRole('button', { name: 'Reveal solution' })
            .click();

        await expect(
            page.getByText('Solution revealed. Review the decision below.')
        ).toBeVisible();
        await expect(page.getByText('Best move', { exact: true })).toBeVisible();
        await expect((await recorded).ok()).toBe(true);
    });

    test('marks pre-move analysis as revealed and keeps sandbox moves out of the attempt', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.reveal;
        await page.goto(practicePath(momentId));
        await waitForBoard(page);

        const analyzeTab = page.getByRole('tab', {
            name: 'Analyze',
        });
        await analyzeTab.click();

        const dialog = page.getByRole('dialog', {
            name: 'Analyze this position?',
        });
        await expect(dialog).toBeVisible();
        await expect(
            page.getByRole('heading', {
                name: 'Analyze the position',
            })
        ).toHaveCount(0);

        await dialog
            .getByRole('button', { name: 'Keep solving' })
            .click();
        await expect(dialog).toHaveCount(0);
        await expect(
            page.getByRole('tab', { name: 'Solve' })
        ).toHaveAttribute('data-state', 'active');

        await analyzeTab.click();
        const recordedRequest = page.waitForRequest(
            (request) =>
                request.url().includes(
                    `/api/training/moments/${momentId}/attempts`
                ) && request.method() === 'POST'
        );
        const recordedResponse = page.waitForResponse(
            (response) =>
                response.url().includes(
                    `/api/training/moments/${momentId}/attempts`
                ) && response.request().method() === 'POST'
        );
        await dialog
            .getByRole('button', {
                name: 'Reveal and analyze',
            })
            .click();

        const request = await recordedRequest;
        expect(request.postDataJSON()).toMatchObject({
            status: 'REVEALED',
            steps: [],
        });
        expect((await recordedResponse).ok()).toBe(true);
        await expect(
            page.getByRole('heading', {
                name: 'Analyze the position',
            })
        ).toBeVisible();
        await expect(
            page.getByRole('region', {
                name: 'Position review',
            })
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { name: 'Live engine' })
        ).toHaveCount(0);
        await expect(
            page.getByRole('tab', { name: 'Review', exact: true })
        ).toHaveAttribute('data-state', 'active');
        await expect(page).toHaveURL(/view=analyze/);

        const analysisBoard = page.getByRole('group', {
            name: 'Interactive analysis board',
        });
        await expect(analysisBoard).toHaveAttribute(
            'data-analysis-position-context',
            'decision'
        );
        await expect(
            analysisBoard.getByText('Decision position')
        ).toBeVisible();

        await page.getByRole('tab', { name: 'Moves', exact: true }).click();
        await page.locator('[data-analysis-move-uci="f1c4"]').click();
        await expect(analysisBoard).toHaveAttribute(
            'data-analysis-position-context',
            'source'
        );
        await expect(
            analysisBoard.getByText('Original game')
        ).toBeVisible();
        await analysisBoard
            .getByRole('button', { name: 'Back to decision' })
            .click();
        await expect(analysisBoard).toHaveAttribute(
            'data-analysis-position-context',
            'decision'
        );

        await clickMove(page, 'd2', 'd4');
        await expect(analysisBoard).toHaveAttribute(
            'data-analysis-position-context',
            'analysis'
        );
        await expect(
            analysisBoard.getByText('Analysis variation')
        ).toBeVisible();
        await expect(
            page.locator('[data-analysis-move-uci="d2d4"]')
        ).toBeVisible();
        await expect(
            page.getByRole('button', { name: 'Previous move' })
        ).toBeEnabled();

        await page.getByRole('button', { name: 'Previous move' }).click();
        await clickMove(page, 'c2', 'c4');
        await expect(
            page.locator('[data-analysis-move-uci="d2d4"]')
        ).toBeVisible();
        await expect(
            page.locator('[data-analysis-move-uci="c2c4"]')
        ).toBeVisible();

        await page.locator('[data-analysis-move-uci="d2d4"]').click();
        await page.getByRole('button', { name: 'Previous move' }).click();
        await page.getByRole('button', { name: 'Next move' }).click();
        await expect(
            page.locator('[data-analysis-move-uci="d2d4"]')
        ).toHaveAttribute('aria-current', 'step');

        const threats = page.getByRole('button', { name: 'Threats' });
        await threats.click();
        await expect(threats).toHaveAttribute('aria-pressed', 'true');
        await expect(
            page.getByRole('heading', { name: 'Opponent threats' })
        ).toBeVisible();
        await expect(
            page.getByText(
                /^(Finding threats|Threat scan complete)/
            )
        ).toBeVisible({ timeout: 15_000 });
        await page.getByRole('button', { name: 'Previous move' }).click();
        await expect(threats).toHaveAttribute('aria-pressed', 'false');
        await expect(
            page.getByRole('heading', { name: 'Live engine' })
        ).toBeVisible();

        await page.getByRole('tab', { name: 'Solve' }).click();
        await expect(
            page.getByText(
                'Solution revealed. Review the decision below.'
            )
        ).toBeVisible();
        await page.getByRole('tab', { name: 'Analyze' }).click();
        await expect(dialog).toHaveCount(0);
        await expect(
            page.getByRole('heading', {
                name: 'Analyze the position',
            })
        ).toBeVisible();
        await page.getByRole('tab', { name: 'Moves', exact: true }).click();
        await expect(
            page.locator('[data-analysis-move-uci="d2d4"]')
        ).toBeVisible();
        await expect(
            page.locator('[data-analysis-move-uci="c2c4"]')
        ).toBeVisible();

        await expect(
            page.getByText('Saved on this device')
        ).toBeVisible();
        await page.reload();
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
        await page.getByRole('tab', { name: 'Moves', exact: true }).click();
        await expect(
            page.locator('[data-analysis-move-uci="d2d4"]')
        ).toBeVisible();
        await expect(
            page.locator('[data-analysis-move-uci="c2c4"]')
        ).toBeVisible();
    });

    test('honors a direct analysis link without bypassing reveal confirmation', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.reveal;
        await page.goto(
            `${practicePath(momentId)}&view=analyze`
        );

        await expect(
            page.getByRole('dialog', {
                name: 'Analyze this position?',
            })
        ).toBeVisible();
        await expect(
            page.getByRole('heading', {
                name: 'Analyze the position',
            })
        ).toHaveCount(0);
    });

    test('grades offline and queues only the history sync', async ({
        page,
        context,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.offline;
        await page.goto(practicePath(momentId));
        await waitForBoard(page);
        await context.setOffline(true);

        await dragMove(page, 'g1', 'f3');
        await expect(
            page.getByText('Best move — well found.')
        ).toBeVisible();
        await expect(
            page.getByText('1 result waiting to sync')
        ).toBeVisible();

        const graded = page.waitForResponse(
            (response) =>
                response.url().includes(
                    `/api/training/moments/${momentId}/attempts`
                ) && response.request().method() === 'POST'
        );
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect((await graded).ok()).toBe(true);
        await expect(
            page.getByText('1 result waiting to sync')
        ).toHaveCount(0);
    });

    test('keeps a permanently rejected history write visible across reload', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.wrongMove;
        await page.route(
            `**/api/training/moments/${momentId}/attempts`,
            async (route) => {
                expect(
                    route.request().headers()['x-backranq-owner-id']
                ).toBe(E2E_USER.id);
                await route.fulfill({
                    status: 422,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        error: 'This result can no longer be recorded.',
                        code: 'STALE_REVISION',
                    }),
                });
            }
        );

        await page.goto(practicePath(momentId));
        await dragMove(page, 'g1', 'f3');
        await expect(page.getByText('Best move — well found.')).toBeVisible();
        await expect(
            page
                .getByRole('alert')
                .filter({ hasText: 'This result can no longer be recorded.' })
        ).toBeVisible();
        await expect(
            page.getByText('1 result needs attention')
        ).toBeVisible();

        await page.reload();
        await expect(
            page
                .getByRole('alert')
                .filter({ hasText: 'This result can no longer be recorded.' })
        ).toBeVisible();
        const storedState = await page.evaluate((ownerId) => {
            const raw = window.localStorage.getItem(
                `backranq:training-attempts:v3:${ownerId}`
            );
            return raw ? JSON.parse(raw)[0]?.state : null;
        }, E2E_USER.id);
        expect(storedState).toBe('NEEDS_ATTENTION');
    });

    test('retries a rate-limited history write without losing it', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.dragMove;
        let writes = 0;
        await page.route(
            `**/api/training/moments/${momentId}/attempts`,
            async (route) => {
                writes += 1;
                if (writes === 1) {
                    await route.fulfill({
                        status: 429,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            error: 'Try again shortly.',
                            code: 'INVALID_REQUEST',
                        }),
                    });
                    return;
                }
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        attemptId:
                            '40000000-0000-4000-8000-00000000e2e1',
                        status: 'RECORDED',
                    }),
                });
            }
        );

        await page.goto(practicePath(momentId));
        await dragMove(page, 'g1', 'f3');
        await expect(
            page.getByText('Opponent replied. Find the best move.')
        ).toBeVisible();
        await dragMove(page, 'f1', 'b5');

        await expect.poll(() => writes).toBe(2);
        await expect(
            page.getByText(/result waiting to sync/)
        ).toHaveCount(0);
        expect(
            await page.evaluate((ownerId) =>
                window.localStorage.getItem(
                    `backranq:training-attempts:v3:${ownerId}`
                ), E2E_USER.id)
        ).toBeNull();
    });

    test('offers every legal promotion choice before submitting', async ({
        page,
    }) => {
        await page.goto(
            practicePath(E2E_TRAINING_MOMENTS.promotion)
        );
        await dragMove(page, 'a7', 'a8');

        const dialog = page.getByRole('dialog', { name: 'Promote pawn to' });
        for (const piece of ['Queen', 'Rook', 'Bishop', 'Knight']) {
            await expect(
                dialog.getByRole('button', {
                    name: `Promote to ${piece}`,
                })
            ).toBeVisible();
        }

        const knightChoice = dialog.getByRole('button', {
            name: 'Promote to Knight',
        });
        await expect(knightChoice).toBeEnabled();
        await knightChoice.click();
        await expect(page.getByText('Best move — well found.')).toBeVisible();
    });

    test('applies a practice focus without changing extraction settings', async ({
        page,
    }) => {
        await page.route('**/api/training/feed?**', async (route) => {
            const url = new URL(route.request().url());
            if (
                url.searchParams.get('sourceKind') !==
                    'MISSED_OPPORTUNITY' ||
                url.searchParams.get('focus') !== 'major'
            ) {
                await route.continue();
                return;
            }
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    items: [],
                    nextCursor: null,
                    appliedFilters: {
                        sourceKinds: ['MISSED_OPPORTUNITY'],
                        focus: 'MAJOR',
                        mode: 'RECOMMENDED',
                    },
                }),
            });
        });
        await page.goto('/practice');
        await page
            .getByRole('combobox', { name: 'Position source' })
            .click();
        await page
            .getByRole('option', { name: 'Missed chances' })
            .click();
        await page
            .getByRole('combobox', { name: 'Position impact' })
            .click();
        await page
            .getByRole('option', { name: 'Major positions' })
            .click();

        const focusedRequest = page.waitForRequest((request) => {
            const url = new URL(request.url());
            return (
                url.pathname === '/api/training/feed' &&
                url.searchParams.get('sourceKind') ===
                    'MISSED_OPPORTUNITY' &&
                url.searchParams.get('focus') === 'major'
            );
        });
        await page
            .getByRole('button', { name: 'Apply focus' })
            .click();

        await focusedRequest;
        await expect(
            page.getByRole('combobox', { name: 'Position source' })
        ).toContainText('Missed chances');
        await expect(
            page.getByRole('combobox', { name: 'Position impact' })
        ).toContainText('Major positions');
        await expect(
            page.getByText('No positions are ready for this focus')
        ).toBeVisible();
    });
});
