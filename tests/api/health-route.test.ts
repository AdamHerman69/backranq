import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';
import { readJson } from '../helpers/route';

type PrismaMockWithRaw = typeof prismaMock & {
    $queryRaw: ReturnType<typeof vi.fn>;
};

describe('/api/health', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllEnvs();
        vi.stubEnv('DATABASE_URL', '');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
        vi.stubEnv('SUPABASE_URL', '');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
        vi.stubEnv('SUPABASE_ANON_KEY', '');
        vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
        mockPrismaModule();
        vi.stubGlobal('fetch', vi.fn());
    });

    it('reports database status but fails when Supabase REST env is absent', async () => {
        vi.stubEnv('DATABASE_URL', 'postgresql://example');
        (prismaMock as PrismaMockWithRaw).$queryRaw.mockResolvedValue([
            { '?column?': 1 },
        ]);

        const { GET } = await import('@/app/api/health/route');
        const response = await GET();
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

    it('fails when neither database nor Supabase REST is configured', async () => {
        const { GET } = await import('@/app/api/health/route');
        const response = await GET();
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

    it('fails when the configured database is unreachable', async () => {
        vi.stubEnv('DATABASE_URL', 'postgresql://example');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
        (prismaMock as PrismaMockWithRaw).$queryRaw.mockRejectedValue(
            new Error('connection failed')
        );
        vi.mocked(fetch).mockResolvedValue(
            new Response(null, { status: 200 })
        );

        const { GET } = await import('@/app/api/health/route');
        const response = await GET();
        const body = await readJson<{
            ok: boolean;
            database: { ok: boolean; error: string };
        }>(response);

        expect(response.status).toBe(503);
        expect(body.ok).toBe(false);
        expect(body.database).toMatchObject({
            ok: false,
            error: 'connection failed',
        });
    });
});
