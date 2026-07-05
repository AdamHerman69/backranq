import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type AutoSyncModule = typeof import('@/lib/services/autoSync');

const fetchLichessGamesMock = vi.fn();
const fetchChessComGamesMock = vi.fn();
const saveNormalizedGamesForUserMock = vi.fn();
const enqueueAnalysisJobsForGamesMock = vi.fn();
const publishBackranqQueueMessageMock = vi.fn();

async function importAutoSync(): Promise<AutoSyncModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/providers/lichess', () => ({
        fetchLichessGames: fetchLichessGamesMock,
    }));
    vi.doMock('@/lib/providers/chesscom', () => ({
        fetchChessComGames: fetchChessComGamesMock,
    }));
    vi.doMock('@/lib/services/gameImport', () => ({
        saveNormalizedGamesForUser: saveNormalizedGamesForUserMock,
    }));
    vi.doMock('@/lib/services/analysisJobs', () => ({
        enqueueAnalysisJobsForGames: enqueueAnalysisJobsForGamesMock,
    }));
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishBackranqQueueMessageMock,
    }));
    return import('@/lib/services/autoSync');
}

describe('syncLinkedAccounts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: {
                    autoSyncEnabled: true,
                    autoAnalyzeEnabled: false,
                    autoSyncProviders: { lichess: true, chesscom: true },
                },
                lichessUsername: 'Ada',
                chesscomUsername: null,
                accounts: [],
            },
        ]);
        prismaMock.providerSyncState.upsert.mockResolvedValue({
            id: 'sync-state-1',
            userId: 'user-1',
            provider: 'LICHESS',
            enabled: true,
            lastSyncedPlayedAt: null,
            etag: null,
            lastModified: null,
        });
        prismaMock.providerSyncState.update.mockResolvedValue({});
        enqueueAnalysisJobsForGamesMock.mockResolvedValue([]);
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'msg-1',
        });
    });

    it('advances the provider cursor only through successfully saved games', async () => {
        const olderGame = {
            id: 'lichess:older',
            provider: 'lichess',
            playedAt: '2026-07-04T10:00:00.000Z',
            timeClass: 'rapid',
            white: { name: 'Ada' },
            black: { name: 'Bob' },
            pgn: '[Result "1-0"]\n\n1. e4 e5 1-0',
        };
        const newerGame = {
            ...olderGame,
            id: 'lichess:newer',
            playedAt: '2026-07-05T10:00:00.000Z',
        };
        fetchLichessGamesMock.mockResolvedValue({
            games: [newerGame, olderGame],
        });
        saveNormalizedGamesForUserMock.mockResolvedValue({
            saved: 1,
            created: 1,
            updated: 0,
            ids: { [olderGame.id]: 'game-db-1' },
            newGameDbIds: ['game-db-1'],
            errors: [{ index: 0, id: newerGame.id, error: 'save failed' }],
        });
        const { syncLinkedAccounts } = await importAutoSync();

        await syncLinkedAccounts();

        expect(prismaMock.providerSyncState.update).toHaveBeenCalledWith({
            where: { id: 'sync-state-1' },
            data: expect.objectContaining({
                lastSyncedPlayedAt: new Date('2026-07-04T10:00:00.000Z'),
                lastError: 'Saved 1/2 games; 1 failed',
            }),
        });
    });
});
