import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ClientRequestTimeoutError,
    fetchHistoricalGames,
    getGameSyncActivity,
    getSyncStatus,
    primeSyncStatusSnapshot,
    readFreshSyncStatusSnapshot,
    requestGameSync,
    saveHistoricalGamesToLibrary,
    syncStatusCacheTestUtils,
    unresolvedHistoryPageGameCount,
    type SyncStatus,
} from '@/lib/services/gameSync';
import type { NormalizedGame } from '@/lib/types/game';

afterEach(() => {
    syncStatusCacheTestUtils.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function makeGame(
    id: string,
    provider: NormalizedGame['provider'] = 'lichess'
): NormalizedGame {
    return {
        id,
        provider,
        playedAt: '2026-07-04T12:00:00.000Z',
        timeClass: 'rapid',
        rated: true,
        white: { name: 'Ada', rating: 1800 },
        black: { name: 'Grace', rating: 1750 },
        result: '1-0',
        termination: 'Normal',
        pgn: '[Event "Test"]\n\n1. e4 e5 1-0',
    };
}

function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
        status,
    });
}

describe('historical game sync client', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    it('counts cap-rejected games only once when continuing a partial page', () => {
        expect(
            unresolvedHistoryPageGameCount({
                newCount: 10,
                selectedCount: 8,
                failed: 3,
            })
        ).toBe(5);
    });

    it('sends owner fencing and preserves the optional history filters', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(
            jsonResponse({
                ownerId: 'user-1',
                provider: 'lichess',
                username: 'Ada',
                rows: [],
                fetched: 0,
                existingCount: 0,
                truncatedReason: 'provider-page',
                providerComplete: false,
                nextCursor: 'next-page',
                page: 2,
                allowance: { limit: 2_000, used: 20, remaining: 1_980 },
            })
        );

        const snapshot = await fetchHistoricalGames({
            ownerId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: ['rapid', 'classical'],
                rated: 'rated',
                since: '2026-01-01',
                until: '2026-07-30',
            },
            cursor: 'current-page',
        });

        expect(snapshot.allowance.remaining).toBe(1_980);
        expect(snapshot.nextCursor).toBe('next-page');
        const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
        expect(String(url)).toContain('provider=lichess');
        expect(String(url)).toContain('timeClass=rapid%2Cclassical');
        expect(String(url)).toContain('rated=rated');
        expect(String(url)).toContain('since=2026-01-01');
        expect(String(url)).toContain('cursor=current-page');
        expect(
            new Headers(init?.headers).get('X-Backranq-Owner-Id')
        ).toBe('user-1');
    });

    it('imports a 580-row Chess.com snapshot in three bounded writes and aggregates every outcome', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                jsonResponse({
                    ownerId: 'user-1',
                    provider: 'chesscom',
                    imported: 200,
                    duplicates: 0,
                    failed: 0,
                    capRejected: 0,
                    ids: { 'chesscom:id-0': 'db-0' },
                    errors: [],
                    allowance: { limit: 2_000, used: 200, remaining: 1_800 },
                })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    ownerId: 'user-1',
                    provider: 'chesscom',
                    imported: 197,
                    duplicates: 2,
                    failed: 1,
                    capRejected: 0,
                    ids: { 'chesscom:id-200': 'db-200' },
                    errors: [
                        {
                            index: 5,
                            id: 'chesscom:id-205',
                            kind: 'validation',
                            error: 'invalid ticket',
                        },
                    ],
                    allowance: { limit: 2_000, used: 397, remaining: 1_603 },
                })
            )
            .mockResolvedValueOnce(
                jsonResponse({
                    ownerId: 'user-1',
                    provider: 'chesscom',
                    imported: 176,
                    duplicates: 1,
                    failed: 3,
                    capRejected: 2,
                    ids: { 'chesscom:id-400': 'db-400' },
                    errors: [
                        {
                            index: 7,
                            id: 'chesscom:id-407',
                            kind: 'save',
                            error: 'save failed',
                        },
                    ],
                    allowance: { limit: 2_000, used: 573, remaining: 1_427 },
                })
            );

        const result = await saveHistoricalGamesToLibrary({
            ownerId: 'user-1',
            items: Array.from({ length: 580 }, (_, index) => ({
                game: makeGame(`chesscom:id-${index}`, 'chesscom'),
                ticket: `ticket-${index}`,
            })),
        });

        expect(fetch).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({
            imported: 573,
            duplicates: 3,
            failed: 4,
            capRejected: 2,
            allowances: {
                chesscom: { used: 573, remaining: 1_427 },
            },
        });
        expect(result.errors.map((error) => error.index)).toEqual([205, 407]);
        const batchSizes = vi.mocked(fetch).mock.calls.map((call) => {
            const body = JSON.parse(call[1]?.body as string) as {
                items: unknown[];
            };
            return body.items.length;
        });
        expect(batchSizes).toEqual([200, 200, 180]);
    });

    it('stops at a failed write batch so an explicit retry cannot skip the remainder', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                jsonResponse({
                    ownerId: 'user-1',
                    provider: 'chesscom',
                    imported: 200,
                    duplicates: 0,
                    failed: 0,
                    capRejected: 0,
                    ids: {},
                    errors: [],
                    allowance: {
                        limit: 2_000,
                        used: 200,
                        remaining: 1_800,
                    },
                })
            )
            .mockResolvedValueOnce(
                jsonResponse({ error: 'temporary failure' }, 503)
            );

        await expect(
            saveHistoricalGamesToLibrary({
                ownerId: 'user-1',
                items: Array.from({ length: 580 }, (_, index) => ({
                    game: makeGame(`chesscom:id-${index}`, 'chesscom'),
                    ticket: `ticket-${index}`,
                })),
            })
        ).rejects.toThrow('temporary failure');
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('bounded status requests', () => {
    const status: SyncStatus = {
        ownerId: 'user-cache',
        inventory: { totalImported: 5, analyzed: 4, unanalyzed: 1 },
        linked: { lichessUsername: 'Ada', chesscomUsername: null },
        lastSync: { lichess: null, chesscom: null },
    };

    it('reuses only a fresh owner-scoped server snapshot', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        primeSyncStatusSnapshot(status, 1_000);

        expect(readFreshSyncStatusSnapshot(status.ownerId, 30_000, 30_999))
            .toBe(status);
        expect(readFreshSyncStatusSnapshot('another-owner', 30_000, 2_000))
            .toBeNull();
        expect(readFreshSyncStatusSnapshot(status.ownerId, 30_000, 31_001))
            .toBeNull();

        primeSyncStatusSnapshot(status);
        await expect(
            getSyncStatus({ ownerId: status.ownerId, preferCached: true })
        ).resolves.toBe(status);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('singleflights abortable and non-abortable reads for one owner', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(status));
        vi.stubGlobal('fetch', fetchMock);
        const controller = new AbortController();

        const [first, second] = await Promise.all([
            getSyncStatus({ ownerId: status.ownerId }),
            getSyncStatus({
                ownerId: status.ownerId,
                signal: controller.signal,
            }),
        ]);

        expect(first).toEqual(status);
        expect(second).toEqual(status);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps caller deadlines independent on a shared transport', async () => {
        vi.useFakeTimers();
        let resolveTransport: (response: Response) => void = () => {
            throw new Error('Transport resolver was not initialized');
        };
        const fetchMock = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    resolveTransport = resolve;
                })
        );
        vi.stubGlobal('fetch', fetchMock);

        const short = getSyncStatus({
            ownerId: status.ownerId,
            timeoutMs: 5,
        });
        const patient = getSyncStatus({
            ownerId: status.ownerId,
            timeoutMs: 100,
        });
        const shortRejection = expect(short).rejects.toBeInstanceOf(
            ClientRequestTimeoutError
        );
        await vi.advanceTimersByTimeAsync(5);
        await shortRejection;
        resolveTransport(jsonResponse(status));
        await vi.advanceTimersByTimeAsync(0);

        await expect(patient).resolves.toEqual(status);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('releases callers when sync status hangs', async () => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn((_input, init) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('Aborted', 'AbortError'))
                    );
                })
            )
        );

        const status = getSyncStatus({ timeoutMs: 5 });
        const rejection = expect(status).rejects.toBeInstanceOf(
            ClientRequestTimeoutError
        );
        await vi.advanceTimersByTimeAsync(5);
        await rejection;
    });
});

describe('owner-bound incremental sync client', () => {
    it('sends the owner fence and accepts only a matching response owner', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            jsonResponse({
                ownerId: 'user-a',
                requested: [],
                providers: [],
                active: { ownerId: 'user-a', providers: [] },
            })
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            requestGameSync({ ownerId: 'user-a', providers: ['lichess'] })
        ).resolves.toMatchObject({ ownerId: 'user-a' });

        const [, init] = fetchMock.mock.calls[0] ?? [];
        expect(
            new Headers((init as RequestInit | undefined)?.headers).get(
                'X-Backranq-Owner-Id'
            )
        ).toBe('user-a');
    });

    it('rejects stale sync and activity responses from another owner', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                jsonResponse({
                    ownerId: 'user-b',
                    requested: [],
                    providers: [],
                    active: { ownerId: 'user-b', providers: [] },
                })
            )
        );

        await expect(
            requestGameSync({ ownerId: 'user-a' })
        ).rejects.toThrow('Invalid sync response owner');
        await expect(
            getGameSyncActivity('user-a')
        ).rejects.toThrow('Invalid sync activity response');
    });
});
