import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readJson } from '../helpers/route';

type AdminReadinessRouteModule = typeof import('@/app/api/admin/readiness/route');

async function importRoute(): Promise<AdminReadinessRouteModule> {
    vi.resetModules();
    return import('@/app/api/admin/readiness/route');
}

function request(secret?: string) {
    return new Request('http://localhost/api/admin/readiness', {
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
    });
}

describe('GET /api/admin/readiness', () => {
    beforeEach(() => {
        vi.unstubAllEnvs();
        vi.clearAllMocks();
    });

    it('is hidden when no admin secret is configured', async () => {
        const route = await importRoute();

        const response = await route.GET(request());

        expect(response.status).toBe(404);
        await expect(readJson(response)).resolves.toEqual({
            error: 'Not found',
        });
    });

    it('requires the configured admin bearer token', async () => {
        vi.stubEnv('BACKRANQ_ADMIN_API_SECRET', 'ops-secret');
        const route = await importRoute();

        const response = await route.GET(request('wrong'));

        expect(response.status).toBe(401);
    });

    it('returns readiness for authorized requests', async () => {
        vi.stubEnv('BACKRANQ_ADMIN_API_SECRET', 'ops-secret');
        vi.stubEnv(
            'DATABASE_URL',
            'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1'
        );
        vi.stubEnv(
            'DIRECT_URL',
            'postgresql://postgres:secret@db.project.supabase.co:5432/postgres'
        );
        vi.stubEnv('NEXTAUTH_SECRET', 'auth-secret');
        vi.stubEnv('NEXTAUTH_URL', 'http://localhost:3000');
        vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_123');
        vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_123');
        vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY', 'price_plus');
        vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY', 'price_pro');
        vi.stubEnv('CRON_SECRET', 'cron-secret');
        vi.stubEnv('SMTP2GO_API_KEY', 'smtp-key');
        vi.stubEnv('SMTP2GO_WEBHOOK_SECRET', 'smtp-webhook-secret');
        vi.stubEnv('BACKRANQ_EMAIL_FROM', 'Backranq <notifications@example.com>');
        vi.stubEnv('NOTIFICATION_UNSUBSCRIBE_SECRET', 'unsubscribe-secret');
        vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'vapid-public');
        vi.stubEnv('VAPID_PRIVATE_KEY', 'vapid-private');
        vi.stubEnv('VAPID_SUBJECT', 'mailto:support@example.com');
        const route = await importRoute();

        const response = await route.GET(request('ops-secret'));

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toMatchObject({
            ok: true,
            checks: expect.arrayContaining([
                expect.objectContaining({ group: 'stripe', ok: true }),
                expect.objectContaining({ group: 'queues', ok: true }),
            ]),
        });
    });
});
