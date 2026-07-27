import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type AutoSyncModule = typeof import('@/lib/services/autoSync');

const fetchLichessGamesMock = vi.fn();
const fetchChessComGamesMock = vi.fn();
const saveNormalizedGamesForUserMock = vi.fn();
const enqueueAnalysisJobMock = vi.fn();

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
        enqueueAnalysisJob: enqueueAnalysisJobMock,
        serverAnalysisConfigFromPreferences: vi.fn(() => ({
            config: { snapshot: {}, hash: 'config-hash' },
        })),
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
        enqueueAnalysisJobMock.mockResolvedValue({
            job: { id: 'analysis-job-1', gameId: 'game-db-1' },
            created: true,
            queued: true,
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

    it('queues auto-analysis only for eligible newly saved games', async () => {
        prismaMock.user.findMany.mockResolvedValue([
            {
                id: 'user-1',
                preferences: {
                    autoSyncEnabled: true,
                    autoAnalyzeEnabled: true,
                    autoSyncProviders: { lichess: true, chesscom: true },
                    autoAnalyzeResultScope: 'losses',
                    autoAnalyzeTimeControls: { rapid: true },
                    autoAnalyzeRatedOnly: true,
                    autoAnalyzeMinPlies: 4,
                },
                lichessUsername: 'Ada',
                chesscomUsername: null,
                accounts: [],
            },
        ]);
        const loss = {
            id: 'lichess:loss',
            provider: 'lichess',
            playedAt: '2026-07-05T10:00:00.000Z',
            timeClass: 'rapid',
            rated: true,
            result: '0-1',
            white: { name: 'Ada' },
            black: { name: 'Bob' },
            pgn: '[Result "0-1"]\n\n1. e4 e5 2. Nf3 Nc6 0-1',
        };
        const win = {
            ...loss,
            id: 'lichess:win',
            result: '1-0',
            pgn: '[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0',
        };
        fetchLichessGamesMock.mockResolvedValue({ games: [loss, win] });
        saveNormalizedGamesForUserMock.mockResolvedValue({
            saved: 2,
            created: 2,
            updated: 0,
            ids: {
                [loss.id]: 'game-loss',
                [win.id]: 'game-win',
            },
            newGameDbIds: ['game-loss', 'game-win'],
            errors: [],
        });
        enqueueAnalysisJobMock.mockResolvedValueOnce({
            job: { id: 'analysis-job-1', gameId: 'game-loss' },
            created: true,
            queued: true,
        });
        const { syncLinkedAccounts } = await importAutoSync();

        const result = await syncLinkedAccounts();

        expect(result.providers[0]).toMatchObject({ queuedAnalysis: 1 });
        expect(enqueueAnalysisJobMock).toHaveBeenCalledTimes(1);
        expect(enqueueAnalysisJobMock).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                gameId: 'game-loss',
                queuedReason: 'auto-sync',
                priority: expect.any(Number),
            })
        );
    });
});
