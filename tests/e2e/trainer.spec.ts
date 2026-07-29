import { expect, test } from '@playwright/test';

import { clickMove, dragMove, waitForBoard } from './support/board';
import { resetE2eTrainingAttempts } from './support/database';
import {
    E2E_TRAINING_MOMENTS,
    trainingPath,
} from './support/fixtures';

test.describe('authenticated personal decision trainer', () => {
    test.beforeEach(async () => {
        await resetE2eTrainingAttempts();
    });

    test('keeps every training prompt neutral and discloses context only after grading', async ({
        page,
    }) => {
        await page.goto(trainingPath(E2E_TRAINING_MOMENTS.wrongMove));
        await expect(
            page.getByText('White to move — find the best move')
        ).toBeVisible();
        await expect(page.getByText("King's Pawn Game")).toHaveCount(0);
        await expect(page.getByText(/mistake/i)).toHaveCount(0);
        await expect(page.getByText(/quiet move/i)).toHaveCount(0);

        await clickMove(page, 'f1', 'c4');

        await expect(
            page.getByText('That repeats the mistake from the game.')
        ).toBeVisible();
        await expect(
            page.getByRole('region', { name: 'Training review' })
        ).toBeVisible();
        await expect(page.getByText('Your game mistake')).toBeVisible();
        await expect(
            page
                .getByRole('region', { name: 'Training review' })
                .getByText('Nf3', { exact: true })
                .first()
        ).toBeVisible();
    });

    test('accepts a correct drag move only after the server grades it', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.dragMove;
        await page.goto(trainingPath(momentId));
        const graded = page.waitForResponse(
            (response) =>
                response.url().includes(
                    `/api/training/moments/${momentId}/attempts`
                ) && response.request().method() === 'POST'
        );

        await dragMove(page, 'g1', 'f3');

        await expect(page.getByText('Checking your move…')).toBeVisible();
        await expect((await graded).ok()).toBe(true);
        await expect(page.getByText('Best move — well found.')).toBeVisible();
    });

    test('replays one server-provided opponent move and asks for another decision without a length hint', async ({
        page,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.dragMove;
        let requestCount = 0;
        await page.route(
            `**/api/training/moments/${momentId}/attempts`,
            async (route) => {
                requestCount += 1;
                const request = route.request().postDataJSON() as {
                    kind: 'START' | 'STEP';
                };
                if (request.kind === 'START') {
                    await route.fulfill({
                        status: 200,
                        contentType: 'application/json',
                        body: JSON.stringify({
                            attemptId:
                                '50000000-0000-4000-8000-00000000e2e1',
                            status: 'AWAITING_CONTINUATION',
                            nextStepIndex: 1,
                            opponentMove: {
                                moveUci: 'b8c6',
                                fenAfter:
                                    'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
                            },
                        }),
                    });
                    return;
                }
                await route.fulfill({
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        attemptId:
                            '50000000-0000-4000-8000-00000000e2e1',
                        status: 'GRADED',
                        grade: 'GOOD',
                        accepted: true,
                        review: reviewFixture('f1b5'),
                    }),
                });
            }
        );

        await page.goto(trainingPath(momentId));
        await dragMove(page, 'g1', 'f3');
        await expect(
            page.getByText('Opponent replied. Find the best move.')
        ).toBeVisible();
        await expect(page.getByText(/step \d+ \/ \d+/i)).toHaveCount(0);
        await expect(page.getByText(/moves? remaining/i)).toHaveCount(0);

        await dragMove(page, 'f1', 'b5');
        await expect(
            page.getByText('Good move — this solution is accepted.')
        ).toBeVisible();
        expect(requestCount).toBe(2);
    });

    test('requires confirmation before reveal', async ({ page }) => {
        const momentId = E2E_TRAINING_MOMENTS.reveal;
        await page.goto(trainingPath(momentId));
        await waitForBoard(page);

        await page.getByRole('button', { name: 'Reveal', exact: true }).click();
        const dialog = page.getByRole('dialog', {
            name: 'Reveal this position?',
        });
        await expect(dialog).toBeVisible();
        await expect(page.getByText('Best move', { exact: true })).toHaveCount(
            0
        );

        const revealed = page.waitForResponse(
            (response) =>
                response.url().includes(
                    `/api/training/moments/${momentId}/reveal`
                ) && response.request().method() === 'POST'
        );
        await dialog
            .getByRole('button', { name: 'Reveal solution' })
            .click();

        await expect((await revealed).ok()).toBe(true);
        await expect(
            page.getByText('Solution revealed. Review the decision below.')
        ).toBeVisible();
        await expect(page.getByText('Best move', { exact: true })).toBeVisible();
    });

    test('queues an offline move as pending without claiming it is correct', async ({
        page,
        context,
    }) => {
        const momentId = E2E_TRAINING_MOMENTS.offline;
        await page.goto(trainingPath(momentId));
        await waitForBoard(page);
        await context.setOffline(true);

        await dragMove(page, 'g1', 'f3');
        await expect(
            page.getByText(
                'Move saved on this device. Waiting for authoritative grading.'
            )
        ).toBeVisible();
        await expect(page.getByText('Best move — well found.')).toHaveCount(0);

        const graded = page.waitForResponse(
            (response) =>
                response.url().includes(
                    `/api/training/moments/${momentId}/attempts`
                ) && response.request().method() === 'POST'
        );
        await context.setOffline(false);
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await expect((await graded).ok()).toBe(true);
        await expect(page.getByText('Best move — well found.')).toBeVisible();
    });

    test('offers every legal promotion choice before submitting', async ({
        page,
    }) => {
        await page.goto(
            trainingPath(E2E_TRAINING_MOMENTS.promotion)
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

        await dialog
            .getByRole('button', { name: 'Promote to Knight' })
            .click();
        await expect(page.getByText('Best move — well found.')).toBeVisible();
    });

    test('starts a focused session without changing extraction settings', async ({
        page,
    }) => {
        await page.goto('/training');
        await page
            .getByRole('combobox', { name: 'Training source' })
            .click();
        await page
            .getByRole('option', { name: 'Missed chances' })
            .click();
        await page
            .getByRole('combobox', { name: 'Training impact' })
            .click();
        await page
            .getByRole('option', { name: 'Major moments' })
            .click();

        const focusedRequest = page.waitForRequest((request) => {
            const url = new URL(request.url());
            return (
                url.pathname === '/api/training/session' &&
                url.searchParams.get('sourceKind') ===
                    'MISSED_OPPORTUNITY' &&
                url.searchParams.get('focus') === 'major'
            );
        });
        await page
            .getByRole('button', { name: 'Start focused session' })
            .click();

        await focusedRequest;
        await expect(
            page.getByText('No moments match this focus')
        ).toHaveCount(0);
    });
});

function reviewFixture(submittedMoveUci: string) {
    return {
        trainingSide: 'w',
        originalMoveUci: 'f1c4',
        submittedMoveUci,
        bestMoveUci: 'g1f3',
        acceptedMovesUci: ['g1f3', 'f1b5'],
        acceptedMovesComplete: true,
        bestLineUci: ['g1f3', 'b8c6', 'f1b5'],
        scoreAtStart: { kind: 'cp', cp: 85, pov: 'WHITE' },
        originalDecision: {
            scoreBefore: { kind: 'cp', cp: 85, pov: 'WHITE' },
            scoreAfter: { kind: 'cp', cp: -45, pov: 'WHITE' },
            cpLoss: 130,
            winChanceLoss: 0.22,
        },
        comparison: null,
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['IMPROVE_POSITION'],
        themes: ['development'],
        source: {
            gameId: '10000000-0000-4000-8000-00000000e2e1',
            provider: 'lichess',
            playedAt: '2026-07-20T12:00:00.000Z',
            decisionPly: 2,
        },
    };
}
