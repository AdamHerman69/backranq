import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashSourcePgn } from '@/lib/chess/pgn';

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
    return import('@/app/api/coach/games/route');
}

const COMPLETED_PGN = `[Event "Backranq Coach"]
[White "Backranq Player"]
[Black "Backranq Coach"]
[Result "0-1"]

1. f3 e5 2. g4 Qh4# 0-1`;

function request(overrides: Record<string, unknown> = {}) {
    return new Request('http://localhost/api/coach/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            sessionId: 'session-1',
            pgn: COMPLETED_PGN,
            userSide: 'white',
            completedAt: '2026-08-04T12:00:00.000Z',
            ...overrides,
        }),
    });
}

describe('POST /api/coach/games', () => {
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
        saveMock.mockImplementation(async (input: { games: Array<{ id: string }> }) => ({
            saved: 1,
            created: 1,
            updated: 0,
            ids: { [input.games[0]!.id]: 'db-game-1' },
            newGameDbIds: ['db-game-1'],
            errors: [],
        }));
    });

    it('requires the signed-in owner', async () => {
        setMockUserId(null);
        const route = await importRoute();
        const response = await route.POST(request());
        expect(response.status).toBe(401);
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('atomically stores immutable Coach provenance and returns its DB id', async () => {
        const route = await importRoute();
        const response = await route.POST(request());

        expect(response.status).toBe(200);
        expect(await readJson(response)).toEqual({
            ownerId: 'user-1',
            gameId: 'db-game-1',
            created: true,
            needsAnalysis: true,
        });
        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-1',
                client: prismaMock,
                games: [
                    expect.objectContaining({
                        provider: 'backranq_coach',
                        white: { name: 'Backranq Player' },
                        provenance: {
                            username: 'Backranq Player',
                            userSide: 'white',
                        },
                    }),
                ],
            })
        );
    });

    it('uses one stable external id for a session and rejects source mutation', async () => {
        const route = await importRoute();
        await route.POST(request());
        saveMock.mockResolvedValue({
            saved: 0,
            created: 0,
            updated: 0,
            ids: {},
            newGameDbIds: [],
            errors: [
                {
                    index: 0,
                    code: 'SOURCE_SNAPSHOT_CONFLICT',
                    error: 'Existing game has a different immutable source snapshot',
                },
            ],
        });
        const changed = await route.POST(
            request({ pgn: COMPLETED_PGN.replace('f3', 'f4') })
        );

        const firstId = (saveMock.mock.calls[0]?.[0] as {
            games: Array<{ id: string }>;
        }).games[0]!.id;
        const secondId = (saveMock.mock.calls[1]?.[0] as {
            games: Array<{ id: string }>;
        }).games[0]!.id;
        expect(firstId).toMatch(/^backranq_coach:[a-f0-9]{64}$/);
        expect(secondId).toBe(firstId);
        expect(changed.status).toBe(409);
    });

    it('never treats an opposite-side concurrent duplicate as the same save', async () => {
        saveMock.mockResolvedValue({
            saved: 0,
            created: 0,
            updated: 0,
            ids: {},
            newGameDbIds: [],
            errors: [
                {
                    index: 0,
                    code: 'CONCURRENT_MODIFICATION',
                    error: 'retry',
                },
            ],
        });
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            sourcePgnHash: hashSourcePgn(COMPLETED_PGN),
            sourceUsername: 'Backranq Coach',
            userSide: 'BLACK',
        });
        const route = await importRoute();

        const response = await route.POST(request());

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toEqual({
            error: 'The saved game has a different player perspective.',
            code: 'PROVENANCE_CONFLICT',
        });
        expect(saveMock).toHaveBeenCalledTimes(3);
    });

    it('rejects incomplete games and unknown fields before writing', async () => {
        const route = await importRoute();
        expect((await route.POST(request({ pgn: '1. e4 e5' }))).status).toBe(400);
        expect((await route.POST(request({ unexpected: true }))).status).toBe(400);
        expect(saveMock).not.toHaveBeenCalled();
    });
});
