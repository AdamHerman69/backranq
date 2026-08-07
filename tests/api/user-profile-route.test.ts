import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
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

function createPatchRequest(
    body: unknown,
    expectedOwner: string | null = 'user-1'
) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (expectedOwner !== null) {
        headers.set(EXPECTED_OWNER_HEADER, expectedOwner);
    }
    return new Request('http://localhost/api/user/profile', {
        method: 'PATCH',
        headers,
        body: JSON.stringify(body),
    });
}

describe('GET /api/user/profile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns profile users with nullable email', async () => {
        const route = await importRoute();
        const row = {
            id: 'user-1',
            email: null,
            name: 'Ada',
            image: null,
            chessAccountConnections: [
                {
                    provider: 'LICHESS',
                    username: 'ada',
                    usernameNormalized: 'ada',
                },
            ],
        };
        const user = {
            id: 'user-1',
            email: null,
            name: 'Ada',
            image: null,
            lichessUsername: 'ada',
            chesscomUsername: null,
        };
        prismaMock.user.findUnique.mockResolvedValue(row);

        const response = await route.GET();

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ user });
    });

    it('atomically resets only the changed provider sync identity', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                Response.json({ id: 'grace-id', username: 'Grace' })
            )
        );
        const route = await importRoute();
        const updated = {
            id: 'user-1',
            email: null,
            name: 'Ada',
            image: null,
            lichessUsername: 'Grace',
            chesscomUsername: 'ada-chess',
        };
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (
                    callback as (
                        tx: typeof prismaMock
                    ) => Promise<unknown>
                )(prismaMock)
        );
        prismaMock.chessAccountConnection.findUnique
            .mockResolvedValueOnce({ usernameNormalized: 'ada' })
            .mockResolvedValueOnce({ usernameNormalized: 'ada-chess' });
        prismaMock.user.findUniqueOrThrow.mockResolvedValue({
            id: 'user-1',
            email: null,
            name: 'Ada',
            image: null,
            chessAccountConnections: [
                {
                    provider: 'LICHESS',
                    username: 'Grace',
                    usernameNormalized: 'grace',
                },
                {
                    provider: 'CHESSCOM',
                    username: 'ada-chess',
                    usernameNormalized: 'ada-chess',
                },
            ],
        });
        prismaMock.chessAccountConnection.upsert.mockResolvedValue({});
        prismaMock.providerSyncState.upsert.mockResolvedValue({});

        const response = await route.PATCH(
            createPatchRequest({
                lichessUsername: 'Grace',
                chesscomUsername: 'ada-chess',
            })
        );

        expect(response.status).toBe(200);
        expect(prismaMock.providerSyncState.upsert).toHaveBeenCalledTimes(1);
        expect(prismaMock.providerSyncState.upsert).toHaveBeenCalledWith({
            where: {
                userId_provider: {
                    userId: 'user-1',
                    provider: 'LICHESS',
                },
            },
            create: {
                userId: 'user-1',
                provider: 'LICHESS',
                providerUsernameNormalized: 'grace',
            },
            update: expect.objectContaining({
                providerUsernameNormalized: 'grace',
                lastSyncedPlayedAt: null,
                cursorUntilPlayedAt: null,
                lastAttemptAt: null,
                lastSuccessAt: null,
            }),
        });
        await expect(readJson(response)).resolves.toEqual({ user: updated });
    });

    it('rejects a missing or stale expected owner before parsing, lookup, or mutation', async () => {
        const providerFetch = vi.fn();
        vi.stubGlobal('fetch', providerFetch);
        const route = await importRoute();

        const missing = await route.PATCH(
            createPatchRequest({ lichessUsername: 'Ada' }, null)
        );
        const stale = await route.PATCH(
            createPatchRequest({ lichessUsername: 'Ada' }, 'user-a')
        );

        expect(missing.status).toBe(409);
        expect(stale.status).toBe(409);
        await expect(readJson(stale)).resolves.toMatchObject({
            code: 'OWNER_MISMATCH',
        });
        expect(providerFetch).not.toHaveBeenCalled();
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
        expect(prismaMock.user.update).not.toHaveBeenCalled();
    });

    it('treats an upstream 404 as username not found without mutating', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 404 }))
        );
        const route = await importRoute();

        const response = await route.PATCH(
            createPatchRequest({ lichessUsername: 'missing-user' })
        );

        expect(response.status).toBe(400);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Lichess username not found',
        });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('preserves upstream rate limiting as a retryable profile error', async () => {
        const providerFetch = vi.fn(
            async () => new Response('', { status: 429 })
        );
        vi.stubGlobal('fetch', providerFetch);
        const route = await importRoute();

        const response = await route.PATCH(
            createPatchRequest({ lichessUsername: 'Ada' })
        );

        expect(response.status).toBe(429);
        await expect(readJson(response)).resolves.toMatchObject({
            retryable: true,
            sourceStatus: 429,
            error: expect.stringContaining('rate limiting'),
        });
        expect(providerFetch).toHaveBeenCalledWith(
            'https://lichess.org/api/user/Ada',
            expect.objectContaining({
                signal: expect.any(AbortSignal),
            })
        );
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('preserves an upstream outage as a retryable service error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 503 }))
        );
        const route = await importRoute();

        const response = await route.PATCH(
            createPatchRequest({ lichessUsername: 'Ada' })
        );

        expect(response.status).toBe(503);
        await expect(readJson(response)).resolves.toMatchObject({
            retryable: true,
            sourceStatus: 503,
            error: expect.stringContaining('temporarily unavailable'),
        });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('preserves a bounded provider timeout as a retryable timeout', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Promise.reject(
                    new DOMException('Timed out', 'TimeoutError')
                )
            )
        );
        const route = await importRoute();

        const response = await route.PATCH(
            createPatchRequest({ lichessUsername: 'Ada' })
        );

        expect(response.status).toBe(504);
        await expect(readJson(response)).resolves.toMatchObject({
            retryable: true,
            sourceStatus: null,
            error: expect.stringContaining('timed out'),
        });
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
});
