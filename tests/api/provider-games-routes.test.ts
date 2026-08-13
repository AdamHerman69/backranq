import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';
import { mockAuthModule, setMockUserId } from '../helpers/route-mocks';

type LichessRouteModule = typeof import('@/app/api/lichess/games/route');
type ChessComRouteModule = typeof import('@/app/api/chesscom/games/route');
const rateLimitMock = vi.fn<
    () => Promise<
        | { allowed: true }
        | { allowed: false; retryAfterSeconds: number }
    >
>(async () => ({ allowed: true }));

function mockRateLimitModule() {
    vi.doMock('@/lib/api/providerProxyRateLimit', () => ({
        consumeProviderProxyRateLimit: rateLimitMock,
    }));
}

async function importLichessRoute(): Promise<LichessRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockRateLimitModule();

    return import('@/app/api/lichess/games/route');
}

async function importChessComRoute(): Promise<ChessComRouteModule> {
    vi.resetModules();
    mockAuthModule();
    mockRateLimitModule();

    return import('@/app/api/chesscom/games/route');
}

function createGetRequest(path: string) {
    return new Request(`http://localhost${path}`);
}

describe('provider game proxy routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        rateLimitMock.mockResolvedValue({ allowed: true });
        vi.stubGlobal('fetch', vi.fn());
    });

    it('requires auth before proxying Lichess requests', async () => {
        const route = await importLichessRoute();
        setMockUserId(null);

        const response = await route.GET(
            createGetRequest('/api/lichess/games?username=ada')
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(response.status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('requires auth before proxying Chess.com requests', async () => {
        const route = await importChessComRoute();
        setMockUserId(null);

        const response = await route.GET(
            createGetRequest('/api/chesscom/games?username=ada')
        );

        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(response.status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps Lichess request validation after auth succeeds', async () => {
        const route = await importLichessRoute();
        setMockUserId('user-1');

        const response = await route.GET(createGetRequest('/api/lichess/games'));

        await expect(readJson(response)).resolves.toEqual({
            error: 'Missing username',
        });
        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('keeps Chess.com request validation after auth succeeds', async () => {
        const route = await importChessComRoute();
        setMockUserId('user-1');

        const response = await route.GET(createGetRequest('/api/chesscom/games'));

        await expect(readJson(response)).resolves.toEqual({
            error: 'Missing username',
        });
        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });

    it('rate limits an authenticated owner before calling either provider', async () => {
        rateLimitMock.mockResolvedValue({
            allowed: false,
            retryAfterSeconds: 37,
        });
        const route = await importLichessRoute();
        setMockUserId('user-1');

        const response = await route.GET(
            createGetRequest('/api/lichess/games?username=ada')
        );

        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('37');
        expect(fetch).not.toHaveBeenCalled();
    });
});
