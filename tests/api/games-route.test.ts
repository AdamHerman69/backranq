import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type GamesRouteModule = typeof import('@/app/api/games/route');

async function importRoute(): Promise<GamesRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/games/route');
}

function createPostRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/games', body, {
        method: 'POST',
    });
}

function validGame(overrides: Record<string, unknown> = {}) {
    return {
        id: 'lichess:abc123',
        provider: 'lichess',
        playedAt: '2026-07-04T12:00:00.000Z',
        timeClass: 'blitz',
        rated: true,
        white: { name: 'Ada', rating: 1800 },
        black: { name: 'Grace', rating: 1750 },
        result: '1-0',
        termination: 'Normal',
        pgn: '[Event "Test"]\n\n1. e4 e5 1-0',
        ...overrides,
    };
}

describe('POST /api/games', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('rejects missing games instead of reporting a silent success', async () => {
        const route = await importRoute();

        const response = await route.POST(createPostRequest({}));

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid games',
        });
        expect(prismaMock.analyzedGame.upsert).not.toHaveBeenCalled();
    });

    it('rejects oversized imports before writing', async () => {
        const route = await importRoute();

        const response = await route.POST(
            createPostRequest({ games: Array.from({ length: 201 }, () => validGame()) })
        );

        expect(response.status).toBe(413);
        await expect(readJson(response)).resolves.toEqual({
            error: 'games exceeds limit of 200',
        });
        expect(prismaMock.analyzedGame.upsert).not.toHaveBeenCalled();
    });

    it('returns a structured partial import result', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.upsert.mockResolvedValue({ id: 'db-game-1' });

        const response = await route.POST(
            createPostRequest({
                games: [validGame(), validGame({ id: 'bad', pgn: '' })],
            })
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            saved: 1,
            skipped: 1,
            ids: { 'lichess:abc123': 'db-game-1' },
            errors: [{ index: 1, id: 'bad', error: 'Invalid pgn' }],
        });
        expect(prismaMock.analyzedGame.upsert).toHaveBeenCalledTimes(1);
    });

    it('returns an error when every row fails validation', async () => {
        const route = await importRoute();

        const response = await route.POST(
            createPostRequest({
                games: [validGame({ id: 'bad', provider: 'other' })],
            })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toMatchObject({
            error: 'No games saved',
            saved: 0,
            skipped: 1,
            errors: [{ index: 0, id: 'bad', error: 'Invalid provider' }],
        });
        expect(prismaMock.analyzedGame.upsert).not.toHaveBeenCalled();
    });
});
