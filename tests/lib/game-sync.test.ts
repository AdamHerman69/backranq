import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ClientRequestTimeoutError,
    fetchHistoricalGames,
    getSyncStatus,
    saveHistoricalGamesToLibrary,
    unresolvedHistoryPageGameCount,
} from '@/lib/services/gameSync';
import type { NormalizedGame } from '@/lib/types/game';

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
        vi.useRealTimers();
    });
});
