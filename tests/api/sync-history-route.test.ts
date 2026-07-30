import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    setMockUserId,
} from '../helpers/route-mocks';

const getHistoryImportSnapshotMock = vi.fn();
const importHistoricalGamesMock = vi.fn();
class TestConcurrencyError extends Error {}
class TestProviderTimeoutError extends Error {}
class TestRateLimitError extends Error {
    readonly retryAfterMs = 1_500;
}
class TestCursorError extends Error {
    readonly httpStatus = 409;
    readonly resetRequired = true;
}
class TestProviderFetchError extends Error {
    constructor(
        message: string,
        readonly httpStatus: number,
        readonly sourceStatus: number | null,
        readonly retryable: boolean
    ) {
        super(message);
    }
}

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/services/historyImport', () => ({
        HISTORY_IMPORT_BODY_LIMIT_BYTES: 8_000_000,
        HISTORY_IMPORT_REQUEST_LIMIT: 200,
        HISTORY_CURSOR_MAX_LENGTH: 16_384,
        HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES: 6_000_000,
        HistoryImportConfigurationError: class extends Error {},
        HistoryImportConcurrencyError: TestConcurrencyError,
        HistoryImportCursorError: TestCursorError,
        HistoryImportProviderFetchError: TestProviderFetchError,
        HistoryImportProviderNotLinkedError: class extends Error {},
        HistoryImportProviderTimeoutError: TestProviderTimeoutError,
        HistoryImportRateLimitError: TestRateLimitError,
        getHistoryImportSnapshot: getHistoryImportSnapshotMock,
        importHistoricalGames: importHistoricalGamesMock,
    }));
    return import('@/app/api/sync/history/route');
}

function getRequest(query: string, ownerId = 'user-1') {
    return new Request(`http://localhost/api/sync/history${query}`, {
        headers: { [EXPECTED_OWNER_HEADER]: ownerId },
    });
}

function postRequest(body: unknown, ownerId = 'user-1') {
    return createJsonRequest(
        'http://localhost/api/sync/history',
        body,
        {
            method: 'POST',
            headers: { [EXPECTED_OWNER_HEADER]: ownerId },
        }
    );
}

describe('/api/sync/history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        getHistoryImportSnapshotMock.mockResolvedValue({
            ownerId: 'user-1',
            provider: 'lichess',
            username: 'Ada',
            rows: [],
            fetched: 0,
            existingCount: 0,
            truncatedReason: null,
            providerComplete: true,
            nextCursor: null,
            page: 1,
            allowance: { limit: 2_000, used: 20, remaining: 1_980 },
        });
        importHistoricalGamesMock.mockResolvedValue({
            provider: 'lichess',
            imported: 1,
            duplicates: 1,
            failed: 0,
            capRejected: 0,
            ids: { 'lichess:a': 'db-a' },
            errors: [],
            allowance: { limit: 2_000, used: 21, remaining: 1_979 },
        });
    });

    it('owner-fences requests before provider work', async () => {
        const route = await importRoute();

        const response = await route.GET(
            getRequest('?provider=lichess', 'stale-user')
        );

        expect(response.status).toBe(409);
        expect(getHistoryImportSnapshotMock).not.toHaveBeenCalled();
    });

    it('validates and forwards optional snapshot filters', async () => {
        const route = await importRoute();

        const response = await route.GET(
            getRequest(
                '?provider=lichess&timeClass=rapid,classical&rated=rated&since=2026-01-01&until=2026-07-30'
            )
        );

        expect(response.status).toBe(200);
        expect(getHistoryImportSnapshotMock).toHaveBeenCalledWith({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: ['rapid', 'classical'],
                rated: true,
                since: '2026-01-01T00:00:00.000Z',
                until: '2026-07-30T23:59:59.999Z',
            },
            cursor: undefined,
            signal: expect.any(AbortSignal),
        });
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            allowance: { remaining: 1_980 },
        });
    });

    it('forwards one bounded opaque cursor and rejects ambiguous cursors', async () => {
        const route = await importRoute();

        const response = await route.GET(
            getRequest('?provider=lichess&cursor=signed-page')
        );

        expect(response.status).toBe(200);
        expect(getHistoryImportSnapshotMock).toHaveBeenCalledWith(
            expect.objectContaining({ cursor: 'signed-page' })
        );

        getHistoryImportSnapshotMock.mockClear();
        const duplicate = await route.GET(
            getRequest('?provider=lichess&cursor=a&cursor=b')
        );
        expect(duplicate.status).toBe(400);
        expect(getHistoryImportSnapshotMock).not.toHaveBeenCalled();

        const oversized = await route.GET(
            getRequest(
                `?provider=lichess&cursor=${'x'.repeat(16_385)}`
            )
        );
        expect(oversized.status).toBe(400);
        expect(getHistoryImportSnapshotMock).not.toHaveBeenCalled();
    });

    it('rejects invalid filters without contacting a provider', async () => {
        const route = await importRoute();

        const response = await route.GET(
            getRequest(
                '?provider=lichess&timeClass=correspondence&since=2026-07-30&until=2026-01-01'
            )
        );

        expect(response.status).toBe(400);
        expect(getHistoryImportSnapshotMock).not.toHaveBeenCalled();
    });

    it('maps provider rate limits and deadlines to stable retryable responses', async () => {
        const route = await importRoute();
        getHistoryImportSnapshotMock.mockRejectedValueOnce(
            new TestProviderFetchError(
                'Provider rate limited',
                429,
                429,
                true
            )
        );

        const rateLimited = await route.GET(
            getRequest('?provider=lichess')
        );
        expect(rateLimited.status).toBe(429);
        await expect(readJson(rateLimited)).resolves.toMatchObject({
            retryable: true,
            sourceStatus: 429,
        });

        getHistoryImportSnapshotMock.mockRejectedValueOnce(
            new TestProviderTimeoutError('Provider timed out')
        );
        const timedOut = await route.GET(
            getRequest('?provider=lichess')
        );
        expect(timedOut.status).toBe(504);
        await expect(readJson(timedOut)).resolves.toMatchObject({
            retryable: true,
            sourceStatus: null,
        });
    });

    it('maps a concurrent provider-fetch lease to a bounded retry response', async () => {
        const route = await importRoute();
        getHistoryImportSnapshotMock.mockRejectedValueOnce(
            new TestRateLimitError('Provider fetch already running')
        );

        const response = await route.GET(getRequest('?provider=lichess'));

        expect(response.status).toBe(429);
        expect(response.headers.get('retry-after')).toBe('2');
        await expect(readJson(response)).resolves.toMatchObject({
            retryable: true,
            retryAfterMs: 1_500,
        });
    });

    it('does not expose unexpected internal errors to the client', async () => {
        const route = await importRoute();
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        getHistoryImportSnapshotMock.mockRejectedValueOnce(
            new Error('Prisma table and connection details')
        );

        const response = await route.GET(getRequest('?provider=lichess'));

        expect(response.status).toBe(502);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Failed to fetch older games',
        });
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('returns a reset-required response for a stale signed cursor', async () => {
        const route = await importRoute();
        getHistoryImportSnapshotMock.mockRejectedValueOnce(
            new TestCursorError('Start over')
        );

        const response = await route.GET(
            getRequest('?provider=lichess&cursor=stale')
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({
            error: 'Start over',
            resetRequired: true,
        });
    });

    it('caps each commit request at 200 rows before mutation', async () => {
        const route = await importRoute();

        const response = await route.POST(
            postRequest({
                provider: 'lichess',
                items: Array.from({ length: 201 }, (_, index) => ({
                    game: { id: `lichess:${index}` },
                    ticket: `ticket-${index}`,
                })),
            })
        );

        expect(response.status).toBe(413);
        expect(importHistoricalGamesMock).not.toHaveBeenCalled();
    });

    it('returns a truthful server-owned commit summary', async () => {
        const route = await importRoute();
        const item = { game: { id: 'lichess:a' }, ticket: 'ticket-a' };

        const response = await route.POST(
            postRequest({ provider: 'lichess', items: [item] })
        );

        expect(response.status).toBe(200);
        expect(importHistoricalGamesMock).toHaveBeenCalledWith({
            userId: 'user-1',
            provider: 'lichess',
            items: [item],
        });
        await expect(readJson(response)).resolves.toMatchObject({
            ownerId: 'user-1',
            imported: 1,
            duplicates: 1,
            failed: 0,
            allowance: { remaining: 1_979 },
        });
    });
});
