import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type ExistingRouteModule = typeof import('@/app/api/games/existing/route');

async function importRoute(): Promise<ExistingRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/games/existing/route');
}

function createPostRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/games/existing', body, {
        method: 'POST',
    });
}

describe('POST /api/games/existing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    it('validates provider', async () => {
        const route = await importRoute();

        const response = await route.POST(
            createPostRequest({ provider: 'other', externalIds: [] })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid provider',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });

    it('deduplicates external ids before querying', async () => {
        const route = await importRoute();
        prismaMock.analyzedGame.findMany.mockResolvedValue([{ externalId: 'a' }]);

        const response = await route.POST(
            createPostRequest({
                provider: 'lichess',
                externalIds: ['a', 'a', 'b'],
            })
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            existingExternalIds: ['a'],
        });
        expect(prismaMock.analyzedGame.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    externalId: { in: ['a', 'b'] },
                }),
            })
        );
    });

    it('rejects oversized lookups', async () => {
        const route = await importRoute();

        const response = await route.POST(
            createPostRequest({
                provider: 'chesscom',
                externalIds: Array.from({ length: 201 }, (_, i) => `id-${i}`),
            })
        );

        expect(response.status).toBe(413);
        await expect(readJson(response)).resolves.toEqual({
            error: 'externalIds exceeds limit of 200',
        });
        expect(prismaMock.analyzedGame.findMany).not.toHaveBeenCalled();
    });
});
