import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type GameRouteModule = typeof import('@/app/api/games/[id]/route');

async function importRoute(): Promise<GameRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/games/[id]/route');
}

function createGetRequest() {
    return new Request('http://localhost/api/games/game-1');
}

function routeParams() {
    return { params: Promise.resolve({ id: 'game-1' }) };
}

describe('GET /api/games/[id]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('requires auth before reading a game', async () => {
        const route = await importRoute();
        setMockUserId(null);

        const response = await route.GET(createGetRequest(), routeParams());

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(prismaMock.analyzedGame.findFirst).not.toHaveBeenCalled();
    });

    it('returns analysis in the game detail contract', async () => {
        const route = await importRoute();
        const analysis = { gameId: 'lichess:abc', moves: [] };
        const game = {
            id: 'game-1',
            provider: 'LICHESS',
            externalId: 'abc',
            pgn: '[Event "Test"]',
            analysis,
            analyzedAt: '2026-07-04T12:00:00.000Z',
        };
        prismaMock.analyzedGame.findFirst.mockResolvedValue(game);

        const response = await route.GET(createGetRequest(), routeParams());

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ game });
        expect(prismaMock.analyzedGame.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'game-1', userId: 'user-1' },
                select: expect.objectContaining({
                    analysis: true,
                    analyzedAt: true,
                    pgn: true,
                }),
            })
        );
    });

    it('returns a consistent not found error', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findFirst.mockResolvedValue(null);

        const response = await route.GET(createGetRequest(), routeParams());

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
    });
});
