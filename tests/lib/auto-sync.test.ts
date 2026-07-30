import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type AutoSyncModule = typeof import('@/lib/services/autoSync');

const fetchLichessGamesBatchMock = vi.fn();
const fetchChessComGamesBatchMock = vi.fn();
const saveNormalizedGamesForUserMock = vi.fn();
const requestAutoAnalysisWakeupMock = vi.fn();

async function importAutoSync(): Promise<AutoSyncModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/providers/lichess', () => ({
        fetchLichessGamesBatch: fetchLichessGamesBatchMock,
    }));
    vi.doMock('@/lib/providers/chesscom', () => ({
        fetchChessComGamesBatch: fetchChessComGamesBatchMock,
    }));
    vi.doMock('@/lib/services/gameImport', () => ({
        saveNormalizedGamesForUser: saveNormalizedGamesForUserMock,
    }));
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        requestAutoAnalysisWakeup: requestAutoAnalysisWakeupMock,
    }));
    return import('@/lib/services/autoSync');
}

function syncState(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sync-state-1',
        userId: 'user-1',
        provider: 'LICHESS',
        enabled: true,
        providerUsernameNormalized: 'ada',
        lastSyncedPlayedAt: new Date('2026-07-01T00:00:00.000Z'),
        cursorSincePlayedAt: null,
        cursorUntilPlayedAt: null,
        cursorWindowEnd: null,
        etag: null,
        lastModified: null,
        ...overrides,
    };
}

function game(id: string, playedAt = '2026-07-05T10:00:00.000Z') {
    return {
        id: `lichess:${id}`,
        provider: 'lichess' as const,
        playedAt,
        timeClass: 'rapid' as const,
        rated: true,
        result: '0-1',
        white: { name: 'Ada' },
        black: { name: 'Bob' },
        pgn: '[Result "0-1"]\n\n1. e4 e5 2. Nf3 Nc6 0-1',
    };
}

describe('reliable provider auto-sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.providerSyncState.upsert.mockResolvedValue(syncState());
        prismaMock.providerSyncState.update.mockImplementation(
            async (args: unknown) => {
                const data = (args as { data?: Record<string, unknown> }).data;
                return syncState(data);
            }
        );
        prismaMock.providerSyncState.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
        );
        prismaMock.$queryRaw.mockResolvedValue([
            {
                lichessUsername: 'Ada',
                chesscomUsername: 'AdaChess',
            },
        ]);
        prismaMock.user.findUnique.mockResolvedValue({
            lichessUsername: 'Ada',
            chesscomUsername: 'AdaChess',
        });
        saveNormalizedGamesForUserMock.mockResolvedValue({
            saved: 0,
            created: 0,
            updated: 0,
            ids: {},
            newGameDbIds: [],
            errors: [],
        });
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
        requestAutoAnalysisWakeupMock.mockResolvedValue({
            queued: true,
            inline: false,
        });
    });

    it('resets cursors and conditional metadata when provider identity changes', async () => {
        prismaMock.providerSyncState.upsert.mockResolvedValue(
            syncState({
                providerUsernameNormalized: 'old-ada',
                cursorSincePlayedAt: new Date('2026-06-01T00:00:00.000Z'),
                cursorUntilPlayedAt: new Date('2026-06-10T00:00:00.000Z'),
                cursorWindowEnd: new Date('2026-07-01T00:00:00.000Z'),
                etag: 'old-etag',
                lastModified: 'old-modified',
            })
        );
        const { syncUserProvider } = await importAutoSync();
        prismaMock.user.findUnique.mockResolvedValue({
            lichessUsername: 'New-Ada',
            chesscomUsername: null,
        });
        prismaMock.$queryRaw.mockResolvedValue([
            {
                lichessUsername: 'New-Ada',
                chesscomUsername: null,
            },
        ]);

        await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'New-Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: {
                ...(await import('@/lib/preferences')).defaultPreferences(),
                autoSyncEnabled: true,
            },
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(prismaMock.providerSyncState.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'sync-state-1',
                providerUsernameNormalized: 'old-ada',
            },
            data: expect.objectContaining({
                providerUsernameNormalized: 'new-ada',
                lastSyncedPlayedAt: null,
                cursorSincePlayedAt: null,
                cursorUntilPlayedAt: null,
                cursorWindowEnd: null,
                etag: null,
                lastModified: null,
            }),
        });
        expect(fetchLichessGamesBatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                username: 'New-Ada',
                firstSyncMaxGames: 100,
            })
        );
    });

    it('does not advance a cursor past a page with save failures', async () => {
        const item = game('failed');
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [item],
            complete: true,
            nextUntil: null,
        });
        saveNormalizedGamesForUserMock.mockResolvedValue({
            saved: 0,
            created: 0,
            updated: 0,
            ids: {},
            newGameDbIds: [],
            errors: [{ index: 0, id: item.id, error: 'save failed' }],
        });
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(result).toMatchObject({
            saved: 0,
            complete: false,
            error: 'Saved 0/1 games; 1 failed',
        });
        expect(prismaMock.providerSyncState.updateMany).toHaveBeenLastCalledWith({
            where: expect.objectContaining({
                id: 'sync-state-1',
                providerUsernameNormalized: 'ada',
            }),
            data: expect.objectContaining({
                cursorSincePlayedAt: new Date('2026-06-30T00:00:00.000Z'),
                cursorUntilPlayedAt: new Date('2026-07-10T00:00:00.000Z'),
                cursorWindowEnd: new Date('2026-07-10T00:00:00.000Z'),
            }),
        });
    });

    it('resumes a bounded interval from its durable cursor and completes the original window', async () => {
        prismaMock.providerSyncState.upsert.mockResolvedValue(
            syncState({
                lastSyncedPlayedAt: new Date('2026-06-01T00:00:00.000Z'),
                cursorSincePlayedAt: new Date('2026-05-31T23:58:00.000Z'),
                cursorUntilPlayedAt: new Date('2026-06-15T00:00:00.000Z'),
                cursorWindowEnd: new Date('2026-07-01T00:00:00.000Z'),
            })
        );
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(fetchLichessGamesBatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                since: '2026-05-31T23:58:00.000Z',
                until: '2026-06-15T00:00:00.000Z',
                firstSyncMaxGames: undefined,
            })
        );
        expect(result.complete).toBe(true);
        expect(prismaMock.providerSyncState.updateMany).toHaveBeenLastCalledWith({
            where: expect.objectContaining({
                id: 'sync-state-1',
                providerUsernameNormalized: 'ada',
            }),
            data: expect.objectContaining({
                lastSyncedPlayedAt: new Date('2026-07-01T00:00:00.000Z'),
                cursorSincePlayedAt: null,
                cursorUntilPlayedAt: null,
                cursorWindowEnd: null,
            }),
        });
    });

    it('keeps saved counts truthful when downstream analysis enqueue is unavailable', async () => {
        const item = game('new');
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [item],
            complete: true,
            nextUntil: null,
        });
        saveNormalizedGamesForUserMock.mockResolvedValue({
            saved: 1,
            created: 1,
            updated: 0,
            ids: { [item.id]: 'game-db-1' },
            newGameDbIds: ['game-db-1'],
            errors: [],
        });
        requestAutoAnalysisWakeupMock.mockResolvedValue({
            queued: false,
            inline: false,
            unavailableReason: 'disabled',
        });
        const prefs = (await import('@/lib/preferences')).defaultPreferences();
        prefs.autoAnalysis = {
            ...prefs.autoAnalysis,
            enabled: true,
            resultScope: 'losses',
            timeControls: {
                ...prefs.autoAnalysis?.timeControls,
                bullet: false,
                blitz: false,
                rapid: true,
                classical: false,
                unknown: false,
            },
            ratedOnly: true,
            minPlies: 4,
        };
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs,
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(result).toMatchObject({
            saved: 1,
            created: 1,
            importedGameIds: ['game-db-1'],
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: true,
        });
        expect(result.error).toBeUndefined();
        expect(
            prismaMock.historyImportQuota.findUnique
        ).not.toHaveBeenCalled();
        expect(
            prismaMock.historyImportQuota.upsert
        ).not.toHaveBeenCalled();
        expect(
            prismaMock.historyImportQuota.updateMany
        ).not.toHaveBeenCalled();
        expect(prismaMock.providerSyncState.updateMany).toHaveBeenLastCalledWith({
            where: expect.objectContaining({
                id: 'sync-state-1',
                providerUsernameNormalized: 'ada',
            }),
            data: expect.objectContaining({
                lastSyncedPlayedAt: new Date('2026-07-10T00:00:00.000Z'),
                lastError: null,
            }),
        });
    });

    it('reconciles an existing analysis backlog after a successful sync with no new games', async () => {
        requestAutoAnalysisWakeupMock.mockResolvedValue({
            queued: true,
            inline: false,
        });
        const { syncUserProvider } = await importAutoSync();
        const now = new Date('2026-07-10T00:00:00.000Z');

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            now,
        });

        expect(saveNormalizedGamesForUserMock).toHaveBeenCalledWith({
            userId: 'user-1',
            games: [],
            client: prismaMock,
        });
        expect(requestAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'import'
        );
        expect(result).toMatchObject({
            fetched: 0,
            saved: 0,
            queuedAnalysis: 0,
            analysisErrors: 0,
            complete: true,
        });
    });

    it('replays the previous Chess.com archive month for late-visible games', async () => {
        prismaMock.providerSyncState.upsert.mockResolvedValue(
            syncState({
                provider: 'CHESSCOM',
                providerUsernameNormalized: 'adachess',
                lastSyncedPlayedAt: new Date('2026-07-28T12:00:00.000Z'),
            })
        );
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: null,
                chesscomUsername: 'AdaChess',
            },
            provider: 'CHESSCOM',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            force: true,
            now: new Date('2026-07-29T12:00:00.000Z'),
        });

        expect(fetchChessComGamesBatchMock).toHaveBeenCalledWith(
            expect.objectContaining({
                since: '2026-06-01T00:00:00.000Z',
                until: '2026-07-29T12:00:00.000Z',
            })
        );
        expect(result.complete).toBe(true);
    });

    it('does not save a fetched batch after the linked identity changes', async () => {
        prismaMock.user.findUnique.mockResolvedValue({
            lichessUsername: 'Grace',
            chesscomUsername: null,
        });
        prismaMock.$queryRaw.mockResolvedValue([
            {
                lichessUsername: 'Grace',
                chesscomUsername: null,
            },
        ]);
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [game('old-account-game')],
            complete: true,
            nextUntil: null,
        });
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            force: true,
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(result).toMatchObject({
            identityChanged: true,
            complete: false,
            saved: 0,
        });
        expect(saveNormalizedGamesForUserMock).not.toHaveBeenCalled();
        expect(
            prismaMock.providerSyncState.updateMany
        ).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    lastSyncedPlayedAt: expect.any(Date),
                }),
            })
        );
    });

    it('locks the provider identity and commits imports with cursor state in one transaction', async () => {
        const order: string[] = [];
        const item = game('atomic');
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [item],
            complete: true,
            nextUntil: null,
        });
        prismaMock.$queryRaw.mockImplementation(async () => {
            order.push('identity-lock');
            return [
                {
                    lichessUsername: 'Ada',
                    chesscomUsername: null,
                },
            ];
        });
        saveNormalizedGamesForUserMock.mockImplementation(async () => {
            order.push('save');
            return {
                saved: 1,
                created: 1,
                updated: 0,
                ids: { [item.id]: 'game-db-atomic' },
                newGameDbIds: ['game-db-atomic'],
                errors: [],
            };
        });
        prismaMock.providerSyncState.updateMany.mockImplementation(
            async (args: unknown) => {
                if (
                    (
                        args as {
                            data?: { lastSyncedPlayedAt?: Date };
                        }
                    ).data?.lastSyncedPlayedAt
                ) {
                    order.push('cursor');
                }
                return { count: 1 };
            }
        );
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            force: true,
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(result).toMatchObject({ saved: 1, complete: true });
        expect(order).toEqual(['identity-lock', 'save', 'cursor']);
        expect(saveNormalizedGamesForUserMock).toHaveBeenCalledWith({
            userId: 'user-1',
            games: [item],
            client: prismaMock,
        });
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    });

    it('casts UUID lock parameters without weakening the identity or worker lease fences', async () => {
        const userId = '11111111-1111-4111-8111-111111111111';
        const jobId = '22222222-2222-4222-8222-222222222222';
        prismaMock.$queryRaw
            .mockResolvedValueOnce([
                {
                    lichessUsername: 'Ada',
                    chesscomUsername: null,
                },
            ])
            .mockResolvedValueOnce([
                {
                    status: 'RUNNING',
                    leaseToken: 'current-worker-token',
                },
            ]);
        const { syncUserProvider } = await importAutoSync();

        await expect(
            syncUserProvider({
                user: {
                    id: userId,
                    lichessUsername: 'Ada',
                    chesscomUsername: null,
                },
                provider: 'LICHESS',
                prefs: (await import('@/lib/preferences')).defaultPreferences(),
                force: true,
                jobLease: {
                    jobId,
                    leaseToken: 'current-worker-token',
                },
                now: new Date('2026-07-10T00:00:00.000Z'),
            })
        ).resolves.toMatchObject({
            complete: true,
            skipped: false,
        });

        const [identityLock, jobLeaseLock] =
            prismaMock.$queryRaw.mock.calls.map((call) => {
                const query = call[0] as {
                    text?: string;
                    values?: unknown[];
                };
                return {
                    text: query.text ?? '',
                    values: query.values ?? [],
                };
            });

        expect(identityLock).toEqual({
            text: expect.stringMatching(
                /FROM "User"[\s\S]*WHERE "id" = CAST\(\$1 AS uuid\)[\s\S]*FOR UPDATE/
            ),
            values: [userId],
        });
        expect(jobLeaseLock).toEqual({
            text: expect.stringMatching(
                /FROM "SyncJob"[\s\S]*WHERE "id" = CAST\(\$1 AS uuid\)[\s\S]*FOR UPDATE/
            ),
            values: [jobId],
        });
        expect(saveNormalizedGamesForUserMock).toHaveBeenCalledWith({
            userId,
            games: [],
            client: prismaMock,
        });
    });

    it('rejects a stale worker lease before saving games or advancing the cursor', async () => {
        const item = game('stale-worker');
        fetchLichessGamesBatchMock.mockResolvedValue({
            games: [item],
            complete: true,
            nextUntil: null,
        });
        prismaMock.$queryRaw
            .mockResolvedValueOnce([
                {
                    lichessUsername: 'Ada',
                    chesscomUsername: null,
                },
            ])
            .mockResolvedValueOnce([
                {
                    status: 'RUNNING',
                    leaseToken: 'newer-worker-token',
                },
            ]);
        const { StaleSyncJobLeaseError, syncUserProvider } =
            await importAutoSync();

        await expect(
            syncUserProvider({
                user: {
                    id: 'user-1',
                    lichessUsername: 'Ada',
                    chesscomUsername: null,
                },
                provider: 'LICHESS',
                prefs: (await import('@/lib/preferences')).defaultPreferences(),
                force: true,
                jobLease: {
                    jobId: 'sync-job-1',
                    leaseToken: 'stale-worker-token',
                },
                now: new Date('2026-07-10T00:00:00.000Z'),
            })
        ).rejects.toBeInstanceOf(StaleSyncJobLeaseError);
        expect(saveNormalizedGamesForUserMock).not.toHaveBeenCalled();
        expect(
            prismaMock.providerSyncState.updateMany
        ).not.toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    lastSyncedPlayedAt: expect.any(Date),
                }),
            })
        );
    });

    it('bounds a stalled provider fetch without advancing the cursor', async () => {
        fetchLichessGamesBatchMock.mockImplementation(
            async (args: { signal?: AbortSignal }) =>
                new Promise((_, reject) => {
                    args.signal?.addEventListener(
                        'abort',
                        () => reject(new Error('aborted')),
                        { once: true }
                    );
                })
        );
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            force: true,
            fetchTimeoutMs: 5,
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(result).toMatchObject({
            complete: false,
            saved: 0,
            error: 'Provider sync fetch timed out',
        });
        expect(saveNormalizedGamesForUserMock).not.toHaveBeenCalled();
    });

    it('keeps the cursor unchanged when a provider payload is invalid', async () => {
        fetchLichessGamesBatchMock.mockRejectedValue(
            new Error('Lichess returned malformed NDJSON at line 2')
        );
        const { syncUserProvider } = await importAutoSync();

        const result = await syncUserProvider({
            user: {
                id: 'user-1',
                lichessUsername: 'Ada',
                chesscomUsername: null,
            },
            provider: 'LICHESS',
            prefs: (await import('@/lib/preferences')).defaultPreferences(),
            force: true,
            now: new Date('2026-07-10T00:00:00.000Z'),
        });

        expect(result).toMatchObject({
            saved: 0,
            complete: false,
            error: 'Lichess returned malformed NDJSON at line 2',
        });
        expect(saveNormalizedGamesForUserMock).not.toHaveBeenCalled();
        for (const call of prismaMock.providerSyncState.updateMany.mock.calls) {
            const data = (call[0] as { data?: Record<string, unknown> }).data;
            expect(data).not.toHaveProperty('lastSyncedPlayedAt');
            expect(data).not.toHaveProperty('cursorUntilPlayedAt');
        }
    });

    it('isolates provider failures and continues syncing the other account', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: {
                    autoSyncEnabled: true,
                    autoSyncProviders: { lichess: true, chesscom: true },
                },
                lichessUsername: 'Ada',
                chesscomUsername: 'AdaChess',
                accounts: [],
            },
        ]);
        prismaMock.providerSyncState.upsert
            .mockResolvedValueOnce(syncState())
            .mockResolvedValueOnce(
                syncState({
                    id: 'sync-state-2',
                    provider: 'CHESSCOM',
                    providerUsernameNormalized: 'adachess',
                })
            );
        fetchLichessGamesBatchMock.mockRejectedValue(
            new Error('Lichess unavailable')
        );
        const { syncLinkedAccounts } = await importAutoSync();

        const result = await syncLinkedAccounts();

        expect(result.providers).toHaveLength(2);
        expect(result.providers[0]).toMatchObject({
            provider: 'LICHESS',
            error: 'Lichess unavailable',
        });
        expect(result.providers[1]).toMatchObject({ provider: 'CHESSCOM' });
        expect(result.providers[1]?.error).toBeUndefined();
        expect(fetchChessComGamesBatchMock).toHaveBeenCalledTimes(1);
    });
});
