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

function createGetRequest(query = '') {
    return new Request(`http://localhost/api/games${query}`);
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

    it('rejects imported analysis blobs so analyzedAt has a single writer', async () => {
        const route = await importRoute();

        const response = await route.POST(
            createPostRequest({
                games: [validGame()],
                analyses: {
                    'lichess:abc123': {
                        gameId: 'lichess:abc123',
                        moves: [],
                    },
                },
            })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Imported analyses are not supported; complete an analysis run instead',
        });
        expect(prismaMock.analyzedGame.upsert).not.toHaveBeenCalled();
    });

    it('returns a structured partial import result', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findUnique.mockResolvedValue(null);
        prismaMock.analyzedGame.create.mockResolvedValue({ id: 'db-game-1' });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (tx: typeof prismaMock) => Promise<unknown>
                )(prismaMock)
        );

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
        expect(prismaMock.analyzedGame.create).toHaveBeenCalledTimes(1);
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

    it('rejects invalid calendar timestamps and malformed PGN before writing', async () => {
        const route = await importRoute();

        const invalidDate = await route.POST(
            createPostRequest({
                games: [validGame({ playedAt: 'July 4, 2026' })],
            })
        );
        const invalidPgn = await route.POST(
            createPostRequest({
                games: [validGame({ pgn: 'not a legal PGN' })],
            })
        );

        expect(invalidDate.status).toBe(400);
        expect(invalidPgn.status).toBe(400);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.create).not.toHaveBeenCalled();
    });

    it('invalidates analysis and training moments when an imported PGN changes', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            pgn: '[Event "Old"]',
        });
        prismaMock.analysisJob.findFirst.mockResolvedValue(null);
        prismaMock.analyzedGame.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.trainingMoment.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (tx: typeof prismaMock) => Promise<unknown>
                )(prismaMock)
        );

        const response = await route.POST(
            createPostRequest({ games: [validGame()] })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.analyzedGame.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    id: 'db-game-1',
                    userId: 'user-1',
                    pgn: '[Event "Old"]',
                },
                data: expect.objectContaining({
                    analysis: {},
                    analyzedAt: null,
                    currentAnalysisRunId: null,
                }),
            })
        );
        expect(prismaMock.trainingMoment.updateMany).toHaveBeenCalledWith({
            where: { gameId: 'db-game-1', archivedAt: null },
            data: {
                status: 'INVALIDATED',
                archivedAt: expect.any(Date),
            },
        });
    });

    it('reports an active-analysis PGN conflict without mutating the game', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findUnique.mockResolvedValue({
            id: 'db-game-1',
            pgn: '[Event "Old"]',
        });
        prismaMock.analysisJob.findFirst.mockResolvedValue({ id: 'job-1' });
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (tx: typeof prismaMock) => Promise<unknown>
                )(prismaMock)
        );

        const response = await route.POST(
            createPostRequest({ games: [validGame()] })
        );

        expect(response.status).toBe(409);
        await expect(readJson(response)).resolves.toMatchObject({
            saved: 0,
            errors: [
                {
                    kind: 'save',
                    error: 'Cannot replace PGN while analysis is active',
                },
            ],
        });
        expect(prismaMock.analyzedGame.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.trainingMoment.updateMany).not.toHaveBeenCalled();
    });
});

describe('GET /api/games', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('rejects loose or impossible date filters', async () => {
        const route = await importRoute();

        const loose = await route.GET(
            createGetRequest('?since=July%204,%202026')
        );
        const impossible = await route.GET(
            createGetRequest('?until=2026-02-30')
        );

        expect(loose.status).toBe(400);
        expect(impossible.status).toBe(400);
        expect(prismaMock.analyzedGame.count).not.toHaveBeenCalled();
    });

    it('treats strict date-only until filters as inclusive calendar days', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.count.mockResolvedValue(0);
        prismaMock.analyzedGame.findMany.mockResolvedValue([]);

        const response = await route.GET(
            createGetRequest('?since=2026-07-01&until=2026-07-04')
        );

        expect(response.status).toBe(200);
        expect(prismaMock.analyzedGame.count).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                playedAt: {
                    gte: new Date('2026-07-01T00:00:00.000Z'),
                    lte: new Date('2026-07-04T23:59:59.999Z'),
                },
            },
        });
    });
});
