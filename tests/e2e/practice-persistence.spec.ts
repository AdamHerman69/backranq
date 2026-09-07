import { expect, test } from '@playwright/test';
import { PrismaClient } from '@prisma/client';

import { dragMove, waitForBoard } from './support/board';
import { resetE2eTrainingAttempts } from './support/database';
import { E2E_TRAINING_MOMENTS, E2E_USER, practicePath } from './support/fixtures';
import { trainingQueueStorageKey } from '../../src/lib/training/offlineQueue';
import type { RecordPlayedMoveRequest, TrainingAttemptWriteRequest } from '../../src/lib/training/attemptApi';

test('replays the same played event after navigation aborts its first POST', async ({ page }) => {
    await resetE2eTrainingAttempts();
    const momentId = E2E_TRAINING_MOMENTS.offline;
    const attemptPath = `/api/training/moments/${momentId}/attempts`;
    const storageKey = trainingQueueStorageKey(E2E_USER.id);
    const sentPayloads: TrainingAttemptWriteRequest[] = [];
    const playedRecords = () => sentPayloads.filter((payload): payload is RecordPlayedMoveRequest => payload.kind === 'RECORD');
    page.on('request', (request) => {
        if (new URL(request.url()).pathname === attemptPath && request.method() === 'POST') {
            sentPayloads.push(request.postDataJSON());
        }
    });
    let releaseFirstRequest!: () => void;
    let finishFirstRequest!: () => void;
    const heldRequest = new Promise<void>((resolve) => {
        releaseFirstRequest = resolve;
    });
    const firstRequestFinished = new Promise<void>((resolve) => {
        finishFirstRequest = resolve;
    });
    await page.route(`**${attemptPath}`, async (route) => {
        await heldRequest;
        try {
            await route.abort();
        } finally {
            finishFirstRequest();
        }
    });

    const playedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await page.clock.setFixedTime(playedAt);
    await page.goto(practicePath(momentId));
    await waitForBoard(page);
    await dragMove(page, 'g1', 'f3');
    await expect(page.getByText('Best move — well found.')).toBeVisible();
    await expect.poll(() => playedRecords().length).toBe(1);
    const firstPayload = playedRecords()[0];
    expect(firstPayload).toMatchObject({ kind: 'RECORD', stepIndex: 0, resolution: 'RESOLVED', playedAt: playedAt.toISOString() });
    await expect.poll(() => page.evaluate((key) => {
        const entries = JSON.parse(localStorage.getItem(key) ?? '[]') as Array<{
            request: { clientAttemptId: string };
        }>;
        return entries.map((entry) => entry.request.clientAttemptId);
    }, storageKey)).toEqual([firstPayload.clientAttemptId]);

    await page.getByRole('link', { name: 'Progress', exact: true }).first().click();
    await expect(page).toHaveURL(/\/progress(?:\?|$)/);
    releaseFirstRequest();
    await firstRequestFinished;
    await page.unroute(`**${attemptPath}`);

    const prisma = new PrismaClient();
    try {
        const where = {
            userId: E2E_USER.id,
            clientAttemptId: firstPayload.clientAttemptId,
        };
        expect(await prisma.trainingAttempt.count({ where })).toBe(0);
        const replay = page.waitForResponse((response) =>
            new URL(response.url()).pathname === attemptPath && response.request().method() === 'POST' && response.request().postDataJSON()?.kind === 'RECORD'
        );
        await page.goto(practicePath(momentId));
        expect((await replay).ok()).toBe(true);
        await expect.poll(() => page.evaluate(
            (key) => localStorage.getItem(key), storageKey
        )).toBeNull();
        expect(playedRecords()).toHaveLength(2);
        expect(playedRecords()[1]).toEqual(firstPayload);
        await expect.poll(() => prisma.trainingAttempt.count({ where })).toBe(1);
        const recorded = await prisma.trainingAttempt.findFirstOrThrow({ where });
        expect(recorded.completedAt).toEqual(playedAt);
        expect(recorded.attemptedAt).toEqual(playedAt);
        expect(await prisma.trainingAttemptStep.count({ where: { attemptId: recorded.id } })).toBe(1);
        const event = await prisma.trainingAttemptStatusEvent.findFirstOrThrow({ where: { attemptId: recorded.id, eventKey: 'record:0' } });
        expect(event.occurredAt).toEqual(playedAt);
        expect(event.recordedAt.getTime() - playedAt.getTime())
            .toBeGreaterThan(24 * 60 * 60_000);
        await page.reload();
        await waitForBoard(page);
        expect(playedRecords()).toHaveLength(2);
        await expect.poll(() => prisma.trainingAttempt.count({ where })).toBe(1);
    } finally {
        await prisma.$disconnect();
    }
});
