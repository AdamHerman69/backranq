import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

type UserProfileRouteModule = typeof import('@/app/api/user/profile/route');

async function importRoute(): Promise<UserProfileRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();

    return import('@/app/api/user/profile/route');
}

describe('GET /api/user/profile', () => {
    beforeEach(() => {
        setMockUserId('user-1');
    });

    it('returns profile users with nullable email', async () => {
        const route = await importRoute();
        const user = {
            id: 'user-1',
            email: null,
            name: 'Ada',
            image: null,
            lichessUsername: 'ada',
            chesscomUsername: null,
        };
        prismaMock.user.findUnique.mockResolvedValue(user);

        const response = await route.GET();

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ user });
    });
});
