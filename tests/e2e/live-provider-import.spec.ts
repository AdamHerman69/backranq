import { expect, test } from '@playwright/test';
import { E2E_USER } from './support/fixtures';

const RUN_LIVE_PROVIDER_TESTS =
    process.env.BACKRANQ_RUN_LIVE_PROVIDER_TESTS === 'true';
const CHESSCOM_USERNAME =
    process.env.BACKRANQ_LIVE_CHESSCOM_USERNAME ?? 'adam1a4';
const LICHESS_USERNAME =
    process.env.BACKRANQ_LIVE_LICHESS_USERNAME ?? 'aldicigg';
const OWNER_HEADERS = {
    'x-backranq-owner-id': E2E_USER.id,
};

type HistorySnapshot = {
    ownerId: string;
    provider: 'chesscom' | 'lichess';
    rows: Array<{ game: { timeClass: string; rated?: boolean }; ticket: string }>;
    allowance: { limit: number; used: number; remaining: number };
    existingCount: number;
    truncatedReason:
        | 'allowance'
        | 'response-size'
        | 'provider-page'
        | null;
    providerComplete: boolean;
    nextCursor: string | null;
    page: number;
};

test.skip(!RUN_LIVE_PROVIDER_TESTS, 'opt-in live provider verification');

test('imports signed snapshots from both real provider accounts in the isolated E2E database', async ({
    page,
}) => {
    test.setTimeout(3 * 60_000);

    const profile = await page.request.patch('/api/user/profile', {
        headers: OWNER_HEADERS,
        data: {
            chesscomUsername: CHESSCOM_USERNAME,
            lichessUsername: LICHESS_USERNAME,
        },
    });
    expect(profile.status()).toBe(200);

    const chesscomCapResponse = await page.request.get(
        '/api/sync/history?provider=chesscom',
        { headers: OWNER_HEADERS }
    );
    expect(chesscomCapResponse.status()).toBe(200);
    const chesscomCap =
        (await chesscomCapResponse.json()) as HistorySnapshot;
    expect(chesscomCap.ownerId).toBe(E2E_USER.id);
    expect(chesscomCap.provider).toBe('chesscom');
    expect(chesscomCap.rows.length).toBeGreaterThan(0);
    expect(chesscomCap.rows.length).toBeLessThanOrEqual(2_000);
    expect(
        Buffer.byteLength(JSON.stringify(chesscomCap), 'utf8')
    ).toBeLessThanOrEqual(6_000_000);
    expect(chesscomCap.allowance).toEqual({
        limit: 2_000,
        used: 0,
        remaining: 2_000,
    });

    const chesscomEmptyResponse = await page.request.get(
        '/api/sync/history?provider=chesscom&rated=casual&since=2026-02-01&until=2026-07-30',
        { headers: OWNER_HEADERS }
    );
    expect(chesscomEmptyResponse.status()).toBe(200);
    const chesscomEmpty =
        (await chesscomEmptyResponse.json()) as HistorySnapshot;
    expect(chesscomEmpty.rows).toHaveLength(0);

    const chesscomRapidResponse = await page.request.get(
        '/api/sync/history?provider=chesscom&rated=rated&timeClass=rapid&since=2026-02-01&until=2026-07-30',
        { headers: OWNER_HEADERS }
    );
    expect(chesscomRapidResponse.status()).toBe(200);
    const chesscomRapid =
        (await chesscomRapidResponse.json()) as HistorySnapshot;
    expect(chesscomRapid.rows.length).toBeGreaterThan(0);
    expect(
        chesscomRapid.rows.every(
            ({ game }) =>
                game.timeClass === 'rapid' && game.rated === true
        )
    ).toBe(true);

    const lichessCapResponse = await page.request.get(
        '/api/sync/history?provider=lichess',
        { headers: OWNER_HEADERS }
    );
    expect(lichessCapResponse.status()).toBe(200);
    const lichessCap =
        (await lichessCapResponse.json()) as HistorySnapshot;
    expect(lichessCap.ownerId).toBe(E2E_USER.id);
    expect(lichessCap.provider).toBe('lichess');
    expect(lichessCap.rows.length).toBeGreaterThan(0);
    expect(lichessCap.rows.length).toBeLessThanOrEqual(200);
    expect(lichessCap.allowance).toEqual({
        limit: 2_000,
        used: 0,
        remaining: 2_000,
    });

    for (const snapshot of [chesscomRapid, lichessCap]) {
        const items = snapshot.rows.slice(0, 3);
        const expectedCount = items.length;
        expect(expectedCount).toBeGreaterThan(0);
        const firstImport = await page.request.post('/api/sync/history', {
            headers: OWNER_HEADERS,
            data: {
                provider: snapshot.provider,
                items,
            },
        });
        expect(firstImport.status()).toBe(200);
        const firstResult = (await firstImport.json()) as {
            imported: number;
            duplicates: number;
            failed: number;
            capRejected: number;
            allowance: {
                limit: number;
                used: number;
                remaining: number;
            };
        };
        expect(firstResult).toMatchObject({
            imported: expectedCount,
            duplicates: 0,
            failed: 0,
            capRejected: 0,
            allowance: {
                limit: 2_000,
                used: expectedCount,
                remaining: 2_000 - expectedCount,
            },
        });

        const duplicateImport = await page.request.post(
            '/api/sync/history',
            {
                headers: OWNER_HEADERS,
                data: {
                    provider: snapshot.provider,
                    items,
                },
            }
        );
        expect(duplicateImport.status()).toBe(200);
        await expect(duplicateImport.json()).resolves.toMatchObject({
            imported: 0,
            duplicates: expectedCount,
            failed: 0,
            capRejected: 0,
            allowance: {
                limit: 2_000,
                used: expectedCount,
                remaining: 2_000 - expectedCount,
            },
        });
    }

    console.info(
        JSON.stringify({
            liveHistoryImport: {
                chesscom: {
                    previewRows: chesscomCap.rows.length,
                    truncatedReason: chesscomCap.truncatedReason,
                },
                lichess: {
                    previewRows: lichessCap.rows.length,
                    truncatedReason: lichessCap.truncatedReason,
                    usedDateFallback: false,
                },
            },
        })
    );

    await page.route('**/api/sync', async (route) => {
        if (route.request().method() === 'POST') {
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({
                    ownerId: E2E_USER.id,
                    status: 'UP_TO_DATE',
                }),
            });
            return;
        }
        await route.continue();
    });
    await page.goto('/games');
    await page.getByRole('button', { name: 'Import older games' }).click();

    const dialog = page.getByRole('dialog', {
        name: 'Import older games',
    });
    await expect(dialog).toBeVisible();
    await expect(
        dialog.getByRole('checkbox', { name: /Lichess/ })
    ).toBeChecked();
    await expect(
        dialog.getByRole('checkbox', { name: /Chess\.com/ })
    ).toBeChecked();
    await dialog
        .getByRole('checkbox', { name: /Lichess/ })
        .uncheck();
    await dialog.getByLabel('Since').fill('2026-07-01');
    await dialog.getByLabel('Until').fill('2026-07-30');
    await dialog
        .getByRole('button', { name: 'Find older games' })
        .click();

    await expect(dialog.getByText(/New:\s*\d+/)).toBeVisible({
        timeout: 45_000,
    });
    await expect(
        dialog.getByText(
            new RegExp(
                `Chess\\.com: ${2_000 - Math.min(3, chesscomRapid.rows.length)} of 2000`
            )
        )
    ).toBeVisible();
    await expect(
        dialog.getByRole('button', { name: 'Import selected' })
    ).toBeEnabled();
});
