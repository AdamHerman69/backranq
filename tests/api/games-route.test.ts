import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/route';
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

function createGetRequest(query = '') {
    return new Request(`http://localhost/api/games${query}`);
}

describe('POST /api/games', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('cannot bypass the per-identity history import quota', async () => {
        const route = await importRoute();
        const response = await route.POST();

        expect(response.status).toBe(405);
        expect(response.headers.get('allow')).toBe('GET');
        await expect(readJson(response)).resolves.toEqual({
            error: 'Direct game import is unavailable. Use /api/sync/history.',
        });
        expect(prismaMock.analyzedGame.create).not.toHaveBeenCalled();
        expect(prismaMock.analyzedGame.createManyAndReturn).not.toHaveBeenCalled();
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

    it('filters manual and Coach sources and rejects unknown source aliases', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.count.mockResolvedValue(0);
        prismaMock.analyzedGame.findMany.mockResolvedValue([]);

        const manual = await route.GET(
            createGetRequest('?provider=manual_pgn')
        );
        const coach = await route.GET(
            createGetRequest('?provider=backranq_coach')
        );
        const unknown = await route.GET(
            createGetRequest('?provider=manual')
        );

        expect(manual.status).toBe(200);
        expect(coach.status).toBe(200);
        expect(unknown.status).toBe(400);
        expect(prismaMock.analyzedGame.count.mock.calls).toEqual([
            [{ where: { userId: 'user-1', provider: 'MANUAL_PGN' } }],
            [{ where: { userId: 'user-1', provider: 'BACKRANQ_COACH' } }],
        ]);
    });
});
