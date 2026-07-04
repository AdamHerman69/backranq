import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';
import { readJson } from '../helpers/route';

type PrismaMockWithRaw = typeof prismaMock & {
    $queryRaw: ReturnType<typeof vi.fn>;
};

function createGetRequest(path = '/api/health') {
    return new Request(`http://localhost${path}`);
}

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/health/route');
}

describe('/api/health', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.stubEnv('DATABASE_URL', '');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
        vi.stubEnv('SUPABASE_URL', '');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
        vi.stubEnv('SUPABASE_ANON_KEY', '');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
        vi.stubGlobal('fetch', vi.fn());
        setMockUserId('user-1');
    });

    it('returns public liveness without exposing diagnostic details', async () => {
        const { GET } = await importRoute();
        setMockUserId(null);

        const response = await GET(createGetRequest());

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ ok: true });
        expect(
            (prismaMock as PrismaMockWithRaw).$queryRaw
        ).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('requires auth for diagnostic details', async () => {
        const { GET } = await importRoute();
        setMockUserId(null);

        const response = await GET(createGetRequest('/api/health?details=1'));

        expect(response.status).toBe(401);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Unauthorized',
        });
        expect(
            (prismaMock as PrismaMockWithRaw).$queryRaw
        ).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports database status but fails when Supabase REST env is absent in diagnostics', async () => {
        vi.stubEnv('DATABASE_URL', 'postgresql://example');
        (prismaMock as PrismaMockWithRaw).$queryRaw.mockResolvedValue([
            { '?column?': 1 },
        ]);

        const { GET } = await importRoute();
        const response = await GET(createGetRequest('/api/health?details=1'));
        const body = await readJson<{
            ok: boolean;
            configComplete: boolean;
            database: { configured: boolean; ok: boolean };
            supabase: { configured: boolean; missing: string[] };
        }>(response);

        expect(response.status).toBe(500);
        expect(body.ok).toBe(false);
        expect(body.configComplete).toBe(false);
        expect(body.database).toMatchObject({
            configured: true,
            ok: true,
        });
        expect(body.supabase.configured).toBe(false);
        expect(body.supabase.missing).toContain(
            'NEXT_PUBLIC_SUPABASE_ANON_KEY or SUPABASE_ANON_KEY'
        );
    });

    it('fails when neither database nor Supabase REST is configured in diagnostics', async () => {
        const { GET } = await importRoute();
        const response = await GET(createGetRequest('/api/health?details=1'));
        const body = await readJson<{ ok: boolean; error: string }>(response);

        expect(response.status).toBe(500);
        expect(body.ok).toBe(false);
        expect(body.error).toBe(
            'Missing database and Supabase environment variables'
        );
        expect(
            (prismaMock as PrismaMockWithRaw).$queryRaw
        ).not.toHaveBeenCalled();
    });

    it('fails when the configured database is unreachable in diagnostics', async () => {
        vi.stubEnv('DATABASE_URL', 'postgresql://example');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
        (prismaMock as PrismaMockWithRaw).$queryRaw.mockRejectedValue(
            new Error('connection failed')
        );
        vi.mocked(fetch).mockResolvedValue(
            new Response(null, { status: 200 })
        );

        const { GET } = await importRoute();
        const response = await GET(createGetRequest('/api/health?details=1'));
        const body = await readJson<{
            ok: boolean;
            database: { ok: boolean; error: string };
        }>(response);

        expect(response.status).toBe(503);
        expect(body.ok).toBe(false);
        expect(body.database).toMatchObject({
            ok: false,
            error: 'Database health check failed',
        });
    });

    it('passes when database and Supabase auth health are reachable in diagnostics', async () => {
        vi.stubEnv('DATABASE_URL', 'postgresql://example');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co/');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
        (prismaMock as PrismaMockWithRaw).$queryRaw.mockResolvedValue([
            { '?column?': 1 },
        ]);
        vi.mocked(fetch).mockResolvedValue(
            new Response(JSON.stringify({ name: 'GoTrue' }), {
                headers: { 'content-type': 'application/json' },
                status: 200,
            })
        );

        const { GET } = await importRoute();
        const response = await GET(createGetRequest('/api/health?details=1'));
        const body = await readJson<{
            ok: boolean;
            configComplete: boolean;
            supabase: { ok: boolean; used: string };
        }>(response);

        expect(response.status).toBe(200);
        expect(body).toMatchObject({
            ok: true,
            configComplete: true,
            supabase: { ok: true, used: 'anon' },
        });
        expect(fetch).toHaveBeenCalledWith(
            'https://example.supabase.co/auth/v1/health',
            expect.objectContaining({
                headers: expect.objectContaining({
                    apikey: 'anon-key',
                    Authorization: 'Bearer anon-key',
                }),
            })
        );
    });
});
