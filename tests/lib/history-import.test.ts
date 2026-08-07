import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';
import type { NormalizedGame } from '@/lib/types/game';

type HistoryImportModule = typeof import('@/lib/services/historyImport');
const fetchLichessGamesBatchMock = vi.fn();
const fetchChessComGamesBatchMock = vi.fn();

async function importHistoryImport(): Promise<HistoryImportModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/providers/lichess', () => ({
        fetchLichessGamesBatch: fetchLichessGamesBatchMock,
    }));
    vi.doMock('@/lib/providers/chesscom', () => ({
        fetchChessComGamesBatch: fetchChessComGamesBatchMock,
    }));
    return import('@/lib/services/historyImport');
}

function game(id: string): NormalizedGame {
    return {
        id: `lichess:${id}`,
        provider: 'lichess',
        playedAt: '2026-07-04T12:00:00.000Z',
        timeClass: 'rapid',
        rated: true,
        white: { name: 'Ada', rating: 1800 },
        black: { name: 'Grace', rating: 1750 },
        result: '1-0',
        termination: 'Normal',
        pgn: '[Event "Test"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
        provenance: {
            username: 'Ada',
            userSide: 'white',
        },
    };
}

function linkedUser(
    provider: 'LICHESS' | 'CHESSCOM' = 'LICHESS',
    username = 'Ada',
    accessToken: string | null = 'oauth-token'
) {
    return {
        chessAccountConnections: [{ provider, username }],
        accounts:
            provider === 'LICHESS' && accessToken
                ? [{ access_token: accessToken }]
                : [],
    };
}

function signedItem(
    module: HistoryImportModule,
    value: NormalizedGame,
    usernameNormalized = 'ada'
) {
    return {
        game: value,
        ticket: module.issueHistoryImportTicket({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized,
            game: value,
        }),
    };
}

function nonCanonicalSignatureVariant(token: string) {
    const [encoded, signature] = token.split('.');
    if (!encoded || !signature) throw new Error('Expected a signed token');
    const alphabet =
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = signature.at(-1);
    const index = last ? alphabet.indexOf(last) : -1;
    if (index < 0 || index % 4 !== 0) {
        throw new Error('Expected a canonical SHA-256 base64url signature');
    }
    const variant = `${signature.slice(0, -1)}${alphabet[index + 1]}`;
    expect(Buffer.from(variant, 'base64url')).toEqual(
        Buffer.from(signature, 'base64url')
    );
    return `${encoded}.${variant}`;
}

describe('durable history import quota', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.user.findUnique.mockResolvedValue(linkedUser());
        prismaMock.$queryRaw.mockResolvedValue([{ username: 'Ada' }]);
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
        );
        prismaMock.historyImportQuota.upsert.mockResolvedValue({
            id: 'quota-1',
            createdCount: 0,
        });
        prismaMock.historyImportQuota.findUnique.mockResolvedValue(null);
        prismaMock.historyImportQuota.updateMany.mockResolvedValue({
            count: 1,
        });
        prismaMock.analyzedGame.count.mockResolvedValue(0);
        prismaMock.analyzedGame.findMany.mockResolvedValue([]);
        prismaMock.analyzedGame.createManyAndReturn.mockResolvedValue([]);
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [],
            complete: true,
            nextUntil: null,
        });
        fetchChessComGamesBatchMock.mockResolvedValue({
            games: [],
            complete: true,
            nextUntil: null,
        });
    });

    it('passes the validated snapshot filters into the bounded provider fetch', async () => {
        prismaMock.historyImportQuota.findUnique.mockResolvedValue({
            createdCount: 20,
        });
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [game('existing'), game('rapid')],
            complete: true,
            nextUntil: null,
        });
        prismaMock.analyzedGame.findMany.mockResolvedValue([
            { externalId: 'existing' },
        ]);
        const { getHistoryImportSnapshot } = await importHistoryImport();

        const result = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: ['rapid'],
                rated: true,
                since: '2026-01-01T00:00:00.000Z',
                until: '2026-07-30T23:59:59.999Z',
            },
        });

        expect(fetchLichessGamesBatchMock).toHaveBeenCalledWith({
            username: 'Ada',
            accessToken: 'oauth-token',
            since: '2026-01-01T00:00:00.000Z',
            until: '2026-07-30T23:59:59.999Z',
            timeClasses: ['rapid'],
            rated: true,
            maxPages: 1,
            pageSize: 200,
            resumeBoundaryIds: [],
            signal: expect.any(AbortSignal),
        });
        expect(result).toMatchObject({
            ownerId: 'user-1',
            fetched: 2,
            existingCount: 1,
            rows: [{ ticket: expect.any(String) }],
            allowance: { used: 20, remaining: 1_980 },
            providerComplete: true,
            nextCursor: null,
            page: 1,
        });
    });

    it('keeps Chess.com history resumable without first-sync semantics', async () => {
        prismaMock.user.findUnique.mockResolvedValue(
            linkedUser('CHESSCOM', 'Ada', null)
        );
        fetchChessComGamesBatchMock.mockResolvedValue({
            games: [],
            complete: false,
            nextUntil: '2026-05-31T23:59:59.999Z',
        });
        const { getHistoryImportSnapshot } = await importHistoryImport();

        const result = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'chesscom',
            filters: {
                timeClasses: ['rapid'],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
        });

        expect(fetchChessComGamesBatchMock).toHaveBeenCalledWith({
            username: 'Ada',
            since: undefined,
            until: expect.any(String),
            timeClasses: ['rapid'],
            rated: undefined,
            maxArchives: 1,
            signal: expect.any(AbortSignal),
        });
        expect(fetchChessComGamesBatchMock.mock.calls[0]?.[0]).not.toHaveProperty(
            'firstSyncMaxGames'
        );
        expect(result).toMatchObject({
            rows: [],
            providerComplete: false,
            truncatedReason: 'provider-page',
            nextCursor: expect.any(String),
        });
    });

    it('advances through all-existing pages without a preexisting-game stall', async () => {
        const firstGames = Array.from({ length: 200 }, (_, index) =>
            game(`existing-a-${index}`)
        );
        const secondGames = Array.from({ length: 200 }, (_, index) =>
            game(`existing-b-${index}`)
        );
        fetchLichessGamesBatchMock
            .mockResolvedValueOnce({
                games: firstGames,
                complete: false,
                nextUntil: '2026-06-01T00:00:00.000Z',
                nextBoundaryIds: ['existing-a-199'],
            })
            .mockResolvedValueOnce({
                games: secondGames,
                complete: false,
                nextUntil: '2026-05-01T00:00:00.000Z',
                nextBoundaryIds: ['existing-b-199'],
            });
        prismaMock.analyzedGame.findMany
            .mockResolvedValueOnce(
                firstGames.map((value) => ({
                    externalId: value.id.slice('lichess:'.length),
                }))
            )
            .mockResolvedValueOnce(
                secondGames.map((value) => ({
                    externalId: value.id.slice('lichess:'.length),
                }))
            );
        const { getHistoryImportSnapshot } = await importHistoryImport();
        const filters = {
            timeClasses: [],
            rated: undefined,
            since: undefined,
            until: undefined,
        };

        const first = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters,
        });
        const second = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters,
            cursor: first.nextCursor as string,
        });

        expect(fetchLichessGamesBatchMock).toHaveBeenCalledTimes(2);
        expect(fetchLichessGamesBatchMock.mock.calls[0]?.[0]).toMatchObject({
            maxPages: 1,
            pageSize: 200,
            since: undefined,
            resumeBoundaryIds: [],
        });
        expect(fetchLichessGamesBatchMock.mock.calls[1]?.[0]).toMatchObject({
            maxPages: 1,
            pageSize: 200,
            until: '2026-06-01T00:00:00.000Z',
            resumeBoundaryIds: ['existing-a-199'],
        });
        expect(first).toMatchObject({
            rows: [],
            existingCount: 200,
            truncatedReason: 'provider-page',
            page: 1,
        });
        expect(second).toMatchObject({
            rows: [],
            existingCount: 200,
            truncatedReason: 'provider-page',
            page: 2,
        });
        expect(prismaMock.analyzedGame.count).not.toHaveBeenCalled();
    });

    it('falls back to the public Lichess export when OAuth is unavailable', async () => {
        prismaMock.user.findUnique.mockResolvedValue(
            linkedUser('LICHESS', 'Ada', null)
        );
        const { getHistoryImportSnapshot } = await importHistoryImport();

        await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: [],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
        });

        expect(fetchLichessGamesBatchMock).toHaveBeenCalledWith(
            expect.objectContaining({ accessToken: null })
        );
    });

    it('keeps partial selections recoverable when the traversal is reset', async () => {
        fetchLichessGamesBatchMock
            .mockResolvedValueOnce({
                games: [game('selected'), game('left-unselected')],
                complete: false,
                nextUntil: '2026-06-01T00:00:00.000Z',
                nextBoundaryIds: ['left-unselected'],
            })
            .mockResolvedValueOnce({
                games: [game('older')],
                complete: true,
                nextUntil: null,
            })
            .mockResolvedValueOnce({
                games: [game('selected'), game('left-unselected')],
                complete: false,
                nextUntil: '2026-06-01T00:00:00.000Z',
                nextBoundaryIds: ['left-unselected'],
            });
        prismaMock.analyzedGame.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ externalId: 'selected' }]);
        const { getHistoryImportSnapshot } = await importHistoryImport();
        const filters = {
            timeClasses: [],
            rated: undefined,
            since: undefined,
            until: undefined,
        };

        const first = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters,
        });
        const continued = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters,
            cursor: first.nextCursor as string,
        });
        const reset = await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters,
        });

        expect(first.rows.map((row) => row.game.id)).toEqual([
            'lichess:selected',
            'lichess:left-unselected',
        ]);
        expect(continued.rows.map((row) => row.game.id)).toEqual([
            'lichess:older',
        ]);
        expect(reset.rows.map((row) => row.game.id)).toEqual([
            'lichess:left-unselected',
        ]);
        expect(reset.page).toBe(1);
    });

    it('binds cursors to signature, owner, provider, identity, filters, and expiry', async () => {
        const historyImport = await importHistoryImport();
        const filters = {
            timeClasses: ['rapid'] as const,
            rated: true,
            since: undefined,
            until: undefined,
        };
        const cursor = historyImport.issueHistoryImportCursor({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized: 'ada',
            filters: {
                ...filters,
                timeClasses: [...filters.timeClasses],
            },
            until: '2026-06-01T00:00:00.000Z',
            boundaryIds: ['boundary'],
            page: 2,
        });
        const expired = historyImport.issueHistoryImportCursor({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized: 'ada',
            filters: {
                ...filters,
                timeClasses: [...filters.timeClasses],
            },
            until: '2026-06-01T00:00:00.000Z',
            page: 2,
            now: Date.now() - 2 * 60 * 60 * 1_000,
        });
        const call = (
            overrides: Partial<
                Parameters<
                    typeof historyImport.getHistoryImportSnapshot
                >[0]
            > = {}
        ) =>
            historyImport.getHistoryImportSnapshot({
                userId: 'user-1',
                provider: 'lichess',
                filters: {
                    ...filters,
                    timeClasses: [...filters.timeClasses],
                },
                cursor,
                ...overrides,
            });

        await expect(
            call({ userId: 'user-2' })
        ).rejects.toMatchObject({ name: 'HistoryImportCursorError' });
        prismaMock.user.findUnique.mockResolvedValue(
            linkedUser('CHESSCOM', 'Ada', null)
        );
        await expect(
            call({ provider: 'chesscom' })
        ).rejects.toMatchObject({ name: 'HistoryImportCursorError' });
        await expect(
            call({
                filters: {
                    timeClasses: ['blitz'],
                    rated: true,
                    since: undefined,
                    until: undefined,
                },
            })
        ).rejects.toMatchObject({ name: 'HistoryImportCursorError' });
        await expect(
            call({ cursor: nonCanonicalSignatureVariant(cursor) })
        ).rejects.toMatchObject({ name: 'HistoryImportCursorError' });
        await expect(
            call({ cursor: expired })
        ).rejects.toMatchObject({
            name: 'HistoryImportCursorError',
            httpStatus: 409,
        });
        prismaMock.user.findUnique.mockResolvedValue(
            linkedUser('LICHESS', 'Grace', null)
        );
        await expect(call()).rejects.toMatchObject({
            name: 'HistoryImportCursorError',
            httpStatus: 409,
        });
        expect(fetchLichessGamesBatchMock).not.toHaveBeenCalled();
        expect(fetchChessComGamesBatchMock).not.toHaveBeenCalled();
    });

    it('treats canonical filter ordering as the same cursor traversal', async () => {
        const historyImport = await importHistoryImport();
        const cursor = historyImport.issueHistoryImportCursor({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized: 'ada',
            filters: {
                timeClasses: ['rapid', 'blitz'],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
            until: '2026-06-01T00:00:00.000Z',
            page: 2,
        });

        const result = await historyImport.getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: ['blitz', 'rapid'],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
            cursor,
        });

        expect(result.page).toBe(2);
        expect(fetchLichessGamesBatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                until: '2026-06-01T00:00:00.000Z',
            })
        );
    });

    it('bounds the aggregate signed snapshot response and marks truncation', async () => {
        const largeGames = Array.from({ length: 7 }, (_, index) => ({
            ...game(`large-${index}`),
            pgn: `${game(`large-${index}`).pgn}\n{${'x'.repeat(1_000_000)}}`,
        }));
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: largeGames,
            complete: true,
            nextUntil: null,
        });
        const historyImport = await importHistoryImport();

        const result = await historyImport.getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: [],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
        });

        expect(
            historyImport.historySnapshotResponseBytes(result)
        ).toBeLessThanOrEqual(
            historyImport.HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES
        );
        expect(result.rows.length).toBeLessThan(largeGames.length);
        expect(result.truncatedReason).toBe('response-size');
        expect(result.nextCursor).toBeNull();
        const firstOmitted = largeGames[result.rows.length];
        expect(firstOmitted).toBeDefined();
        const omittedTicket = historyImport.issueHistoryImportTicket({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized: 'ada',
            game: firstOmitted as NormalizedGame,
        });
        expect(
            historyImport.historySnapshotResponseBytes({
                ...result,
                rows: [
                    ...result.rows,
                    {
                        game: firstOmitted as NormalizedGame,
                        ticket: omittedTicket,
                    },
                ],
            })
        ).toBeGreaterThan(
            historyImport.HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES
        );
    });

    it('marks an allowance-limited snapshot as the final importable batch', async () => {
        prismaMock.historyImportQuota.findUnique.mockResolvedValue({
            createdCount: 1_999,
        });
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [game('first'), game('second')],
            complete: true,
            nextUntil: null,
        });
        const historyImport = await importHistoryImport();

        const result = await historyImport.getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: [],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
        });

        expect(result.rows).toHaveLength(1);
        expect(result.allowance.remaining).toBe(1);
        expect(result.truncatedReason).toBe('allowance');
    });

    it('classifies provider 429 responses as retryable rate limits', async () => {
        fetchLichessGamesBatchMock.mockRejectedValue(
            new Error(
                JSON.stringify({
                    error: 'Lichess request failed (429)',
                })
            )
        );
        const { getHistoryImportSnapshot } = await importHistoryImport();

        await expect(
            getHistoryImportSnapshot({
                userId: 'user-1',
                provider: 'lichess',
                filters: {
                    timeClasses: [],
                    rated: undefined,
                    since: undefined,
                    until: undefined,
                },
            })
        ).rejects.toMatchObject({
            httpStatus: 429,
            sourceStatus: 429,
            retryable: true,
        });
    });

    it('aborts a stalled provider snapshot at its internal deadline', async () => {
        fetchLichessGamesBatchMock.mockImplementation(
            async (args: { signal: AbortSignal }) =>
                new Promise((_, reject) => {
                    args.signal.addEventListener(
                        'abort',
                        () => reject(args.signal.reason),
                        { once: true }
                    );
                })
        );
        const { getHistoryImportSnapshot } = await importHistoryImport();

        await expect(
            getHistoryImportSnapshot({
                userId: 'user-1',
                provider: 'lichess',
                filters: {
                    timeClasses: [],
                    rated: undefined,
                    since: undefined,
                    until: undefined,
                },
                fetchTimeoutMs: 5,
            })
        ).rejects.toMatchObject({
            name: 'HistoryImportProviderTimeoutError',
        });
    });

    it('atomically rejects a concurrent provider fetch before provider work', async () => {
        prismaMock.historyImportQuota.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
                fetchLeaseUntil: new Date(Date.now() + 20_000),
            });
        prismaMock.historyImportQuota.updateMany.mockResolvedValueOnce({
            count: 0,
        });
        const { getHistoryImportSnapshot } = await importHistoryImport();

        await expect(
            getHistoryImportSnapshot({
                userId: 'user-1',
                provider: 'lichess',
                filters: {
                    timeClasses: [],
                    rated: undefined,
                    since: undefined,
                    until: undefined,
                },
            })
        ).rejects.toMatchObject({
            name: 'HistoryImportRateLimitError',
            retryAfterMs: expect.any(Number),
        });

        expect(fetchLichessGamesBatchMock).not.toHaveBeenCalled();
        expect(prismaMock.historyImportQuota.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    id: 'quota-1',
                    OR: expect.any(Array),
                }),
                data: expect.objectContaining({
                    fetchLeaseToken: expect.any(String),
                    fetchLeaseUntil: expect.any(Date),
                }),
            })
        );
    });

    it('releases only its own provider-fetch lease after external work', async () => {
        const { getHistoryImportSnapshot } = await importHistoryImport();

        await getHistoryImportSnapshot({
            userId: 'user-1',
            provider: 'lichess',
            filters: {
                timeClasses: [],
                rated: undefined,
                since: undefined,
                until: undefined,
            },
        });

        expect(
            prismaMock.historyImportQuota.updateMany
        ).toHaveBeenLastCalledWith({
            where: {
                id: 'quota-1',
                fetchLeaseToken: expect.any(String),
            },
            data: {
                fetchLeaseToken: null,
                fetchLeaseUntil: null,
            },
        });
        expect(
            prismaMock.$transaction.mock.invocationCallOrder[0]
        ).toBeLessThan(
            fetchLichessGamesBatchMock.mock.invocationCallOrder[0] ??
                Number.MAX_SAFE_INTEGER
        );
    });

    it('hard-caps repeated history imports at 2,000 for one identity', async () => {
        prismaMock.historyImportQuota.upsert.mockResolvedValue({
            id: 'quota-1',
            createdCount: 1_999,
        });
        prismaMock.analyzedGame.createManyAndReturn.mockResolvedValue([
            { id: 'db-a', externalId: 'a' },
        ]);
        const historyImport = await importHistoryImport();

        const result = await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [
                signedItem(historyImport, game('a')),
                signedItem(historyImport, game('b')),
            ],
        });

        expect(result).toMatchObject({
            imported: 1,
            duplicates: 0,
            failed: 1,
            capRejected: 1,
            allowance: { limit: 2_000, used: 2_000, remaining: 0 },
        });
        expect(prismaMock.analyzedGame.createManyAndReturn).toHaveBeenCalledWith(
            expect.objectContaining({
                data: [expect.objectContaining({ externalId: 'a' })],
                skipDuplicates: true,
            })
        );
        expect(prismaMock.historyImportQuota.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'quota-1',
                createdCount: { lte: 1_999 },
            },
            data: { createdCount: { increment: 1 } },
        });
    });

    it('counts only rows actually created after a concurrent auto-sync race', async () => {
        prismaMock.$queryRaw
            .mockReset()
            .mockResolvedValueOnce([
                { username: 'Ada' },
            ])
            .mockResolvedValueOnce([{ acquired: true }]);
        prismaMock.historyImportQuota.upsert.mockResolvedValue({
            id: 'quota-1',
            createdCount: 100,
        });
        prismaMock.analyzedGame.createManyAndReturn.mockResolvedValue([
            { id: 'db-a', externalId: 'a' },
        ]);
        const historyImport = await importHistoryImport();

        const result = await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [
                signedItem(historyImport, game('a')),
                signedItem(historyImport, game('b')),
            ],
        });

        expect(result).toMatchObject({
            imported: 1,
            duplicates: 1,
            failed: 0,
            allowance: { used: 101, remaining: 1_899 },
        });
        expect(prismaMock.historyImportQuota.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: { createdCount: { increment: 1 } },
            })
        );
        expect(prismaMock.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
            prismaMock.historyImportQuota.upsert.mock.invocationCallOrder[0] ??
                Number.MAX_SAFE_INTEGER
        );
        const rawSql = prismaMock.$queryRaw.mock.calls.map((call) =>
            Array.isArray(call[0])
                ? call[0].join(' ')
                : String(call[0])
        );
        expect(rawSql[0]).toContain('FROM "ChessAccountConnection"');
        expect(rawSql[0]).toContain('"SyncProvider"');
        expect(rawSql[0]).toContain('FOR UPDATE');
        expect(rawSql[1]).toContain('pg_advisory_xact_lock');
        expect(rawSql[1]).toContain('AS MATERIALIZED');
        expect(rawSql[1]).toContain('SELECT TRUE AS "acquired"');
        expect(rawSql[1]).not.toMatch(
            /^\s*SELECT\s+pg_advisory_xact_lock/
        );
    });

    it('requires an untampered, unexpired server-signed snapshot ticket', async () => {
        const historyImport = await importHistoryImport();
        const original = game('signed');
        const validTicket = historyImport.issueHistoryImportTicket({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized: 'ada',
            game: original,
        });
        const expiredTicket = historyImport.issueHistoryImportTicket({
            userId: 'user-1',
            provider: 'lichess',
            usernameNormalized: 'ada',
            game: original,
            now: Date.now() - 2 * 60 * 60 * 1_000,
        });
        const nonCanonicalTicket =
            nonCanonicalSignatureVariant(validTicket);

        const result = await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [
                original,
                {
                    game: {
                        ...original,
                        pgn: '[Event "Tampered"]\n[Result "1-0"]\n\n1. d4 d5 1-0',
                    },
                    ticket: validTicket,
                },
                { game: original, ticket: expiredTicket },
                { game: original, ticket: nonCanonicalTicket },
            ],
        });

        expect(result).toMatchObject({
            imported: 0,
            duplicates: 0,
            failed: 4,
        });
        expect(result.errors.map((error) => error.error)).toEqual([
            'A valid history snapshot ticket is required',
            'History snapshot ticket is invalid or expired',
            'History snapshot ticket is invalid or expired',
            'History snapshot ticket is invalid or expired',
        ]);
        expect(
            prismaMock.analyzedGame.createManyAndReturn
        ).not.toHaveBeenCalled();
        expect(
            prismaMock.historyImportQuota.updateMany
        ).not.toHaveBeenCalled();
    });

    it('does not consume quota for duplicates or validation failures', async () => {
        prismaMock.historyImportQuota.upsert.mockResolvedValue({
            id: 'quota-1',
            createdCount: 700,
        });
        prismaMock.analyzedGame.findMany.mockResolvedValue([
            { externalId: 'existing' },
        ]);
        const historyImport = await importHistoryImport();
        const invalid = { ...game('bad'), pgn: 'not pgn' };

        const result = await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [
                signedItem(historyImport, game('existing')),
                signedItem(historyImport, invalid),
            ],
        });

        expect(result).toMatchObject({
            imported: 0,
            duplicates: 1,
            failed: 1,
            allowance: { used: 700, remaining: 1_300 },
        });
        expect(
            prismaMock.historyImportQuota.updateMany
        ).not.toHaveBeenCalled();
    });

    it('keys allowance by normalized identity across disconnect and reconnect', async () => {
        const historyImport = await importHistoryImport();
        prismaMock.analyzedGame.findMany.mockResolvedValue([
            { externalId: 'existing' },
        ]);

        await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [signedItem(historyImport, game('existing'))],
        });
        prismaMock.user.findUnique.mockResolvedValue(
            linkedUser('LICHESS', 'Grace', null)
        );
        prismaMock.$queryRaw.mockResolvedValue([{ username: 'Grace' }]);
        const graceGame = {
            ...game('existing'),
            white: { name: 'Grace' },
        };
        await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [
                signedItem(historyImport, graceGame, 'grace'),
            ],
        });
        prismaMock.user.findUnique.mockResolvedValue(
            linkedUser('LICHESS', '  ADA  ', null)
        );
        prismaMock.$queryRaw.mockResolvedValue([{ username: '  ADA  ' }]);
        await historyImport.importHistoricalGames({
            userId: 'user-1',
            provider: 'lichess',
            items: [signedItem(historyImport, game('existing'))],
        });

        const keys = prismaMock.historyImportQuota.upsert.mock.calls.map(
            (call) =>
                (
                    call[0] as {
                        where: {
                            userId_provider_usernameNormalized: {
                                usernameNormalized: string;
                            };
                        };
                    }
                ).where.userId_provider_usernameNormalized.usernameNormalized
        );
        expect(keys).toEqual(['ada', 'grace', 'ada']);
    });
});
