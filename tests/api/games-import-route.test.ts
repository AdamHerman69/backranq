import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

const saveMock = vi.fn();

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    vi.doMock('@/lib/services/gameImport', () => ({
        saveNormalizedGamesForUser: saveMock,
    }));
    return import('@/app/api/games/import/route');
}

const PGN = `[Event "Manual"]
[UTCDate "2026.08.04"]
[UTCTime "12:00:00"]
[White "Ada"]
[Black "Grace"]
[Result "1-0"]
[TimeControl "600+5"]

1. e4 e5 2. Nf3 Nc6 1-0`;

describe('POST /api/games/import', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
        );
        saveMock.mockResolvedValue({
            saved: 1,
            created: 1,
            updated: 0,
            ids: { game: 'db-game-1' },
            newGameDbIds: ['db-game-1'],
            errors: [],
        });
    });

    it('requires authentication', async () => {
        setMockUserId(null);
        const route = await importRoute();
        const response = await route.POST(
            new Request('http://localhost/api/games/import', {
                method: 'POST',
                body: JSON.stringify({ pgn: PGN, playerName: 'Ada' }),
            })
        );
        expect(response.status).toBe(401);
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('stores manual provenance and separates created from duplicate ids', async () => {
        const route = await importRoute();
        const response = await route.POST(
            new Request('http://localhost/api/games/import', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pgn: PGN, playerName: 'ada' }),
            })
        );

        expect(response.status).toBe(200);
        expect(await readJson(response)).toEqual({
            created: 1,
            duplicates: 0,
            createdGameIds: ['db-game-1'],
            duplicateGameIds: [],
            needsAnalysisGameIds: ['db-game-1'],
        });
        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                games: [
                    expect.objectContaining({
                        provider: 'manual_pgn',
                        timeClass: 'rapid',
                        provenance: expect.objectContaining({
                            username: 'Ada',
                            userSide: 'white',
                        }),
                    }),
                ],
            })
        );
    });

    it('returns the typed immutable perspective conflict', async () => {
        saveMock.mockResolvedValue({
            saved: 0,
            created: 0,
            updated: 0,
            ids: {},
            newGameDbIds: [],
            errors: [
                {
                    index: 0,
                    id: 'manual_pgn:hash',
                    code: 'PROVENANCE_CONFLICT',
                    error: 'Existing game has a different immutable player perspective',
                },
            ],
        });
        const route = await importRoute();
        const response = await route.POST(
            new Request('http://localhost/api/games/import', {
                method: 'POST',
                body: JSON.stringify({ pgn: PGN, playerName: 'Ada' }),
            })
        );
        expect(response.status).toBe(409);
        expect(await readJson(response)).toMatchObject({
            code: 'PERSPECTIVE_CONFLICT',
        });
    });

    it('rejects an ambiguous player before writing', async () => {
        const route = await importRoute();
        const response = await route.POST(
            new Request('http://localhost/api/games/import', {
                method: 'POST',
                body: JSON.stringify({ pgn: PGN, playerName: 'Missing' }),
            })
        );
        expect(response.status).toBe(400);
        expect(saveMock).not.toHaveBeenCalled();
    });
});
