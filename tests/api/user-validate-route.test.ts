import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/route';
import {
    mockAuthModule,
    setMockUserId,
} from '../helpers/route-mocks';

const rateLimitMock = vi.fn<
    () => Promise<
        | { allowed: true }
        | { allowed: false; retryAfterSeconds: number }
    >
>(async () => ({ allowed: true }));

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    vi.doMock('@/lib/api/providerProxyRateLimit', () => ({
        consumeProviderProxyRateLimit: rateLimitMock,
    }));
    return import('@/app/api/user/validate/route');
}

function request(provider = 'lichess', username = 'Ada') {
    return new Request(
        `http://localhost/api/user/validate?provider=${provider}&username=${username}`
    );
}

describe('GET /api/user/validate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        rateLimitMock.mockResolvedValue({ allowed: true });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('treats only a provider 404 as a missing username', async () => {
        const providerFetch = vi.fn(async () => new Response('', { status: 404 }));
        vi.stubGlobal('fetch', providerFetch);
        const route = await importRoute();

        const response = await route.GET(request());

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            ok: true,
            exists: false,
        });
        expect(providerFetch).toHaveBeenCalledWith(
            'https://lichess.org/api/user/Ada',
            expect.objectContaining({
                cache: 'no-store',
                signal: expect.any(AbortSignal),
            })
        );
    });

    it('reports provider rate limiting as a retryable source error', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 429 }))
        );
        const route = await importRoute();

        const response = await route.GET(request('chesscom', 'Ada'));
        const body = await readJson<{
            ok: boolean;
            retryable: boolean;
            error: string;
        }>(response);

        expect(response.status).toBe(429);
        expect(body).toMatchObject({
            ok: false,
            retryable: true,
        });
        expect(body.error).toContain('rate limiting');
    });

    it('does not turn a provider outage into username not found', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('', { status: 503 }))
        );
        const route = await importRoute();

        const response = await route.GET(request());
        const body = await readJson<{
            ok: boolean;
            retryable: boolean;
            error: string;
        }>(response);

        expect(response.status).toBe(503);
        expect(body).toMatchObject({
            ok: false,
            retryable: true,
        });
        expect(body.error).toContain('source status 503');
    });

    it('reports bounded provider timeouts as retryable', async () => {
        const timeout = new DOMException('Timed out', 'TimeoutError');
        vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(timeout)));
        const route = await importRoute();

        const response = await route.GET(request());

        expect(response.status).toBe(504);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: false,
            retryable: true,
            error: expect.stringContaining('timed out'),
        });
    });

    it('does not call the provider when the owner limit is exhausted', async () => {
        const providerFetch = vi.fn();
        vi.stubGlobal('fetch', providerFetch);
        rateLimitMock.mockResolvedValue({
            allowed: false,
            retryAfterSeconds: 22,
        });
        const route = await importRoute();

        const response = await route.GET(request());

        expect(response.status).toBe(429);
        expect(response.headers.get('Retry-After')).toBe('22');
        expect(providerFetch).not.toHaveBeenCalled();
    });
});
