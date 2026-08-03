import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchChessComGames,
    fetchChessComGamesBatch,
} from '@/lib/providers/chesscom';
import { fetchLichessGamesBatch } from '@/lib/providers/lichess';

function response(body: unknown, headers: Record<string, string> = {}) {
    return new Response(
        typeof body === 'string' ? body : JSON.stringify(body),
        { status: 200, headers }
    );
}

function errorResponse(status: number, body = 'provider error') {
    return new Response(body, { status });
}

function lichessJson(id: string, createdAt: number) {
    return JSON.stringify({
        id,
        createdAt,
        speed: 'rapid',
        rated: true,
        pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
        players: {
            white: { user: { name: 'Ada' } },
            black: { user: { name: 'Bob' } },
        },
    });
}

describe('provider pagination', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    it('pages beyond the former 25-game limit without skips', async () => {
        const newest = Date.parse('2026-07-10T00:00:00.000Z');
        const firstPage = Array.from({ length: 200 }, (_, index) =>
            lichessJson(`game-${index}`, newest - index * 1_000)
        ).join('\n');
        const boundary = newest - 199 * 1_000;
        const secondPage = [
            lichessJson('game-199', boundary),
            ...Array.from({ length: 30 }, (_, index) =>
                lichessJson(
                    `game-${200 + index}`,
                    boundary - (index + 1) * 1_000
                )
            ),
        ].join('\n');
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(firstPage))
            .mockResolvedValueOnce(response(secondPage));

        const result = await fetchLichessGamesBatch({
            username: 'Ada',
            since: '2026-07-01T00:00:00.000Z',
            until: '2026-07-11T00:00:00.000Z',
        });

        expect(result.complete).toBe(true);
        expect(result.games).toHaveLength(230);
        expect(new Set(result.games.map((game) => game.id)).size).toBe(230);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('overlaps and dedupes games sharing a page-boundary timestamp', async () => {
        const newest = Date.parse('2026-07-10T00:00:00.000Z');
        const boundary = newest - 199 * 1_000;
        const firstPage = Array.from({ length: 200 }, (_, index) =>
            lichessJson(`game-${index}`, newest - index * 1_000)
        ).join('\n');
        const secondPage = [
            lichessJson('game-199', boundary),
            lichessJson('same-time-second-game', boundary),
            lichessJson('older', boundary - 1_000),
        ].join('\n');
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(firstPage))
            .mockResolvedValueOnce(response(secondPage));

        const result = await fetchLichessGamesBatch({
            username: 'Ada',
            since: '2026-07-01T00:00:00.000Z',
            until: '2026-07-11T00:00:00.000Z',
        });

        expect(result.games.filter((game) => game.id === 'lichess:game-199')).toHaveLength(1);
        expect(result.games.map((game) => game.id)).toContain(
            'lichess:same-time-second-game'
        );
    });

    it('fails safely instead of stepping past an exhausted timestamp tie', async () => {
        const boundary = Date.parse('2026-07-10T00:00:00.000Z');
        const tiedPage = Array.from({ length: 200 }, (_, index) =>
            lichessJson(`tied-${index}`, boundary)
        ).join('\n');
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(tiedPage))
            .mockResolvedValueOnce(response(tiedPage));

        await expect(
            fetchLichessGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-11T00:00:00.000Z',
            })
        ).rejects.toThrow(
            'Lichess pagination stalled at an inclusive timestamp boundary'
        );
    });

    it('uses one bounded filtered export request without a synthetic since floor', async () => {
        const newest = Date.parse('2026-07-10T00:00:00.000Z');
        const exportBatch = Array.from({ length: 200 }, (_, index) => {
            const value = JSON.parse(
                lichessJson(`history-${index}`, newest - index * 1_000)
            ) as Record<string, unknown>;
            return JSON.stringify({
                ...value,
                speed: index % 2 === 0 ? 'blitz' : 'rapid',
                rated: false,
            });
        }).join('\n');
        vi.mocked(fetch).mockResolvedValueOnce(response(exportBatch));

        const result = await fetchLichessGamesBatch({
            username: 'Ada',
            until: '2026-07-11T00:00:00.000Z',
            timeClasses: ['blitz', 'rapid'],
            rated: false,
            maxPages: 1,
            pageSize: 200,
        });

        expect(result.games).toHaveLength(200);
        expect(fetch).toHaveBeenCalledTimes(1);
        const requestUrl = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
        expect(requestUrl.searchParams.get('max')).toBe('200');
        expect(requestUrl.searchParams.has('since')).toBe(false);
        expect(requestUrl.searchParams.get('perfType')).toBe('blitz,rapid');
        expect(requestUrl.searchParams.get('rated')).toBe('false');
        expect(result.complete).toBe(false);
        expect(result.nextUntil).not.toBeNull();
    });

    it('keeps the unknown bucket exact without excluding it upstream', async () => {
        const playedAt = Date.parse('2026-07-10T00:00:00.000Z');
        const rapid = JSON.parse(
            lichessJson('rapid-game', playedAt)
        ) as Record<string, unknown>;
        const unknown = {
            ...rapid,
            id: 'correspondence-game',
            speed: 'correspondence',
        };
        vi.mocked(fetch).mockResolvedValueOnce(
            response([JSON.stringify(rapid), JSON.stringify(unknown)].join('\n'))
        );

        const result = await fetchLichessGamesBatch({
            username: 'Ada',
            until: '2026-07-11T00:00:00.000Z',
            timeClasses: ['unknown'],
            maxPages: 1,
            pageSize: 2,
        });

        const requestUrl = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
        expect(requestUrl.searchParams.has('perfType')).toBe(false);
        expect(result.games.map((game) => game.id)).toEqual([
            'lichess:correspondence-game',
        ]);
    });

    it('caps one Lichess export request at the bounded scan limit', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(response(''));

        await fetchLichessGamesBatch({
            username: 'Ada',
            until: '2026-07-11T00:00:00.000Z',
            maxPages: 1,
            pageSize: 9_000,
        });

        const requestUrl = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
        expect(requestUrl.searchParams.get('max')).toBe('500');
    });

    it('resumes an inclusive Lichess boundary across separate requests', async () => {
        const newest = Date.parse('2026-07-10T00:00:00.000Z');
        const firstPage = Array.from({ length: 200 }, (_, index) =>
            lichessJson(`game-${index}`, newest - index * 1_000)
        ).join('\n');
        const boundary = newest - 199 * 1_000;
        const secondPage = [
            lichessJson('game-199', boundary),
            lichessJson('older', boundary - 1_000),
        ].join('\n');
        vi.mocked(fetch)
            .mockResolvedValueOnce(response(firstPage))
            .mockResolvedValueOnce(response(secondPage));

        const first = await fetchLichessGamesBatch({
            username: 'Ada',
            until: '2026-07-11T00:00:00.000Z',
            maxPages: 1,
        });
        const second = await fetchLichessGamesBatch({
            username: 'Ada',
            until: first.nextUntil as string,
            resumeBoundaryIds: first.nextBoundaryIds,
            maxPages: 1,
        });

        expect(first.nextBoundaryIds).toEqual(['game-199']);
        expect(second.games.map((game) => game.id)).toEqual([
            'lichess:older',
        ]);
        expect(second.complete).toBe(true);
    });

    it.each([401, 403])(
        'retries stale Lichess OAuth status %s exactly once without credentials',
        async (status) => {
            vi.mocked(fetch)
                .mockResolvedValueOnce(errorResponse(status))
                .mockResolvedValueOnce(
                    response(
                        lichessJson(
                            'public-game',
                            Date.parse('2026-07-10T00:00:00.000Z')
                        )
                    )
                );

            const result = await fetchLichessGamesBatch({
                username: 'Ada',
                until: '2026-07-11T00:00:00.000Z',
                accessToken: 'stale-token',
                maxPages: 1,
                pageSize: 2,
            });

            expect(result.games).toHaveLength(1);
            expect(fetch).toHaveBeenCalledTimes(2);
            const firstHeaders = vi.mocked(fetch).mock.calls[0]?.[1]
                ?.headers as Record<string, string>;
            const secondHeaders = vi.mocked(fetch).mock.calls[1]?.[1]
                ?.headers as Record<string, string>;
            expect(firstHeaders.Authorization).toBe(
                'Bearer stale-token'
            );
            expect(secondHeaders.Authorization).toBeUndefined();
        }
    );

    it('does not retry non-auth Lichess failures publicly', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(errorResponse(429));

        await expect(
            fetchLichessGamesBatch({
                username: 'Ada',
                until: '2026-07-11T00:00:00.000Z',
                accessToken: 'token',
                maxPages: 1,
            })
        ).rejects.toThrow('429');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does not trust archive-list ETags for current-month Chess.com games', async () => {
        const archive =
            'https://api.chess.com/pub/player/ada/games/2026/07';
        vi.mocked(fetch)
            .mockResolvedValueOnce(
                response(
                    { archives: [archive] },
                    { etag: '"same-archive-list"' }
                )
            )
            .mockResolvedValueOnce(
                response({
                    games: [
                        {
                            uuid: 'new-game',
                            end_time: Date.parse(
                                '2026-07-10T00:00:00.000Z'
                            ) / 1_000,
                            time_class: 'rapid',
                            rated: true,
                            pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
                            white: { username: 'Ada' },
                            black: { username: 'Bob' },
                        },
                    ],
                })
            );

        const result = await fetchChessComGames({
            username: 'Ada',
            filters: {
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-31T23:59:59.999Z',
                max: 100,
            },
            etag: '"same-archive-list"',
            lastModified: 'Wed, 01 Jul 2026 00:00:00 GMT',
        });

        const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as
            | Record<string, string>
            | undefined;
        expect(headers?.['If-None-Match']).toBeUndefined();
        expect(headers?.['If-Modified-Since']).toBeUndefined();
        expect(vi.mocked(fetch).mock.calls[0]?.[1]?.redirect).toBe('error');
        expect(vi.mocked(fetch).mock.calls[1]?.[1]?.redirect).toBe('error');
        expect(result.games.map((game) => game.id)).toEqual([
            'chesscom:new-game',
        ]);
    });

    it('continues through sparse Chess.com history beyond 24 archives', async () => {
        const archives = Array.from({ length: 26 }, (_, index) => {
            const date = new Date(Date.UTC(2024, 5 + index, 1));
            return `https://api.chess.com/pub/player/ada/games/${date.getUTCFullYear()}/${String(
                date.getUTCMonth() + 1
            ).padStart(2, '0')}`;
        });
        vi.mocked(fetch).mockResolvedValueOnce(
            response({ archives })
        );
        for (let index = 0; index < 24; index += 1) {
            vi.mocked(fetch).mockResolvedValueOnce(
                response({ games: [] })
            );
        }

        const first = await fetchChessComGamesBatch({
            username: 'Ada',
            until: '2026-08-01T00:00:00.000Z',
            maxArchives: 24,
        });

        expect(first.complete).toBe(false);
        expect(first.nextUntil).not.toBeNull();

        vi.mocked(fetch)
            .mockResolvedValueOnce(response({ archives }))
            .mockResolvedValueOnce(response({ games: [] }))
            .mockResolvedValueOnce(
                response({
                    games: [
                        {
                            uuid: 'old-match',
                            end_time:
                                Date.parse(
                                    '2024-06-15T00:00:00.000Z'
                                ) / 1_000,
                            time_class: 'rapid',
                            rated: true,
                            pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
                            white: { username: 'Ada' },
                            black: { username: 'Bob' },
                        },
                    ],
                })
            );
        const second = await fetchChessComGamesBatch({
            username: 'Ada',
            until: first.nextUntil as string,
            maxArchives: 24,
        });

        expect(second.complete).toBe(true);
        expect(second.games.map((game) => game.id)).toEqual([
            'chesscom:old-match',
        ]);
    });

    it('rejects malformed Chess.com archive JSON instead of treating it as empty', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(response('{'));

        await expect(
            fetchChessComGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-31T23:59:59.999Z',
            })
        ).rejects.toThrow('malformed JSON');
    });

    it.each([
        'http://api.chess.com/pub/player/ada/games/2026/07',
        'https://example.com/pub/player/ada/games/2026/07',
        'https://api.chess.com/pub/player/grace/games/2026/07',
        'https://api.chess.com/pub/player/ada/games/2026/07?redirect=1',
    ])('rejects unsafe Chess.com archive URL %s before fetching it', async (archive) => {
        vi.mocked(fetch).mockResolvedValueOnce(
            response({ archives: [archive] })
        );

        await expect(
            fetchChessComGamesBatch({
                username: 'Ada',
                until: '2026-07-31T23:59:59.999Z',
            })
        ).rejects.toThrow('archive URL');
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('rejects missing Chess.com arrays and malformed game rows', async () => {
        const archive =
            'https://api.chess.com/pub/player/ada/games/2026/07';
        vi.mocked(fetch)
            .mockResolvedValueOnce(response({}))
            .mockResolvedValueOnce(response({ archives: [archive] }))
            .mockResolvedValueOnce(
                response({
                    games: [
                        {
                            uuid: 'missing-pgn',
                            end_time: 1_783_641_600,
                        },
                    ],
                })
            );

        await expect(
            fetchChessComGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-31T23:59:59.999Z',
            })
        ).rejects.toThrow('archives must be an array');
        await expect(
            fetchChessComGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-31T23:59:59.999Z',
            })
        ).rejects.toThrow('missing PGN');
    });

    it('uses the URL fallback when Chess.com returns a blank UUID', async () => {
        const archive =
            'https://api.chess.com/pub/player/ada/games/2026/07';
        vi.mocked(fetch)
            .mockResolvedValueOnce(response({ archives: [archive] }))
            .mockResolvedValueOnce(
                response({
                    games: [
                        {
                            uuid: '',
                            url: 'https://www.chess.com/game/live/1',
                            end_time: 1_783_641_600,
                            pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
                            white: { username: 'Ada' },
                            black: { username: 'Bob' },
                        },
                        {
                            uuid: '   ',
                            url: 'https://www.chess.com/game/live/2',
                            end_time: 1_783_641_601,
                            pgn: '[Result "0-1"]\n\n1. d4 d5 0-1',
                            white: { username: 'Ada' },
                            black: { username: 'Bob' },
                        },
                    ],
                })
            );

        const result = await fetchChessComGamesBatch({
            username: 'Ada',
            since: '2026-07-01T00:00:00.000Z',
            until: '2026-07-31T23:59:59.999Z',
        });

        expect(result.games).toHaveLength(2);
        expect(result.games.map((game) => game.id)).toEqual(
            expect.arrayContaining([
                'chesscom:https://www.chess.com/game/live/1:1783641600',
                'chesscom:https://www.chess.com/game/live/2:1783641601',
            ])
        );
    });

    it('rejects malformed Lichess NDJSON and missing required game fields', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(response('{'))
            .mockResolvedValueOnce(
                response(
                    JSON.stringify({
                        id: 'missing-pgn',
                        createdAt: Date.parse(
                            '2026-07-10T00:00:00.000Z'
                        ),
                        players: { white: {}, black: {} },
                    })
                )
            )
            .mockResolvedValueOnce(
                response(
                    JSON.stringify({
                        id: 'missing-requested-player',
                        createdAt: Date.parse(
                            '2026-07-10T00:00:00.000Z'
                        ),
                        pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
                        players: { white: {}, black: {} },
                    })
                )
            );

        await expect(
            fetchLichessGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-11T00:00:00.000Z',
            })
        ).rejects.toThrow('malformed NDJSON');
        await expect(
            fetchLichessGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-11T00:00:00.000Z',
            })
        ).rejects.toThrow('missing PGN');
        await expect(
            fetchLichessGamesBatch({
                username: 'Ada',
                since: '2026-07-01T00:00:00.000Z',
                until: '2026-07-11T00:00:00.000Z',
            })
        ).rejects.toThrow('does not contain the requested player identity');
    });
});
