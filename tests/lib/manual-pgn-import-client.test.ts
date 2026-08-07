import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';

const publishLibraryChanged = vi.fn();
const setOwner = vi.fn();
const enqueueGameDbIds = vi.fn();

async function importClient() {
    vi.resetModules();
    vi.doMock('@/lib/analysis/analysisCompletion', () => ({
        publishLibraryChanged,
    }));
    vi.doMock('@/lib/analysis/backgroundAnalysisManager', () => ({
        backgroundAnalysis: { setOwner, enqueueGameDbIds },
    }));
    return import('@/lib/games/manualPgnImportClient');
}

describe('manual PGN import client owner fence', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('sends the render owner and accepts only a successful typed response', async () => {
        const providerFetch = vi.fn(async () =>
            Response.json({
                created: 1,
                duplicates: 0,
                createdGameIds: ['game-1'],
                duplicateGameIds: [],
                needsAnalysisGameIds: ['game-1'],
            })
        );
        vi.stubGlobal('fetch', providerFetch);
        const client = await importClient();

        await expect(
            client.importManualPgnGamesAndAnalyze({
                ownerId: 'user-1',
                pgn: '[Event "Test"]',
                playerName: 'Ada',
                analyze: true,
            })
        ).resolves.toMatchObject({ createdGameIds: ['game-1'] });

        expect(providerFetch).toHaveBeenCalledWith('/api/games/import', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                [EXPECTED_OWNER_HEADER]: 'user-1',
            },
            body: JSON.stringify({
                pgn: '[Event "Test"]',
                playerName: 'Ada',
            }),
        });
        expect(publishLibraryChanged).toHaveBeenCalledWith('user-1', {
            invalidateCompletion: true,
        });
        expect(setOwner).toHaveBeenCalledWith('user-1');
        expect(enqueueGameDbIds).toHaveBeenCalledWith('user-1', ['game-1']);
    });

    it('rejects an owner mismatch response before returning analysis ids', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json(
                    {
                        error: 'The signed-in account changed.',
                        code: 'OWNER_MISMATCH',
                    },
                    { status: 409 }
                )
            )
        );
        const client = await importClient();

        await expect(
            client.importManualPgnGamesAndAnalyze({
                ownerId: 'stale-user',
                pgn: '[Event "Test"]',
                playerName: 'Ada',
                analyze: true,
            })
        ).rejects.toThrow('signed-in account changed');
        expect(publishLibraryChanged).not.toHaveBeenCalled();
        expect(setOwner).not.toHaveBeenCalled();
        expect(enqueueGameDbIds).not.toHaveBeenCalled();
    });
});
