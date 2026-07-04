import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type PreferencesRouteModule = typeof import('@/app/api/user/preferences/route');

async function importRoute(): Promise<PreferencesRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/user/preferences/route');
}

function createPutRequest(body: unknown) {
    return createJsonRequest('http://localhost/api/user/preferences', body, {
        method: 'PUT',
    });
}

describe('PUT /api/user/preferences', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
        prismaMock.user.update.mockResolvedValue({ id: 'user-1' });
    });

    it('rejects unknown preference keys before writing', async () => {
        const route = await importRoute();

        const response = await route.PUT(createPutRequest({ admin: true }));

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unknown preference admin',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('rejects invalid patch shapes before writing', async () => {
        const route = await importRoute();

        const response = await route.PUT(createPutRequest(null));

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Invalid preferences patch',
        });
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('saves a validated partial preferences patch', async () => {
        const route = await importRoute();

        const response = await route.PUT(
            createPutRequest({
                engineMoveTimeMs: '300',
                requireTactical: false,
                puzzleMode: 'punishBlunder',
                filters: { timeClass: 'rapid', max: '50' },
                puzzleTagFilter: ['fork', 'fork', 'pin'],
            })
        );
        const body = await readJson<{ preferences: Record<string, unknown> }>(
            response
        );

        expect(response.status).toBe(200);
        expect(body.preferences).toMatchObject({
            engineMoveTimeMs: '300',
            requireTactical: false,
            puzzleMode: 'punishBlunder',
            puzzleTagFilter: ['fork', 'pin'],
            filters: expect.objectContaining({ timeClass: 'rapid', max: '50' }),
        });
        expect(prismaMock.user.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'user-1' },
                data: {
                    preferences: expect.objectContaining({
                        engineMoveTimeMs: '300',
                    }),
                },
            })
        );
    });
});
