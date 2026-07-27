import { describe, expect, it } from 'vitest';
import { getDeploymentReadiness } from '@/lib/config/deploymentReadiness';

const completeEnv = {
    DATABASE_URL: 'postgresql://runtime',
    DIRECT_URL: 'postgresql://direct',
    NEXTAUTH_SECRET: 'secret',
    NEXTAUTH_URL: 'http://localhost:3000',
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro',
    BACKRANQ_ADMIN_API_SECRET: 'ops-secret',
    CRON_SECRET: 'cron-secret',
};

describe('deployment readiness', () => {
    it('passes when required runtime settings are present', () => {
        const readiness = getDeploymentReadiness(completeEnv);

        expect(readiness.ok).toBe(true);
        expect(readiness.checks.every((check) => check.ok)).toBe(true);
    });

    it('reports missing Stripe and admin settings without exposing values', () => {
        const readiness = getDeploymentReadiness({
            DATABASE_URL: 'postgresql://runtime',
            DIRECT_URL: 'postgresql://direct',
            CRON_SECRET: 'cron-secret',
        });

        expect(readiness.ok).toBe(false);
        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'stripe',
                missing: expect.arrayContaining([
                    'STRIPE_SECRET_KEY',
                    'STRIPE_WEBHOOK_SECRET',
                    'STRIPE_PRICE_PLUS_MONTHLY',
                    'STRIPE_PRICE_PRO_MONTHLY',
                    'BACKRANQ_APP_URL or NEXTAUTH_URL',
                ]),
            })
        );
        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'adminOps',
                missing: ['BACKRANQ_ADMIN_API_SECRET'],
            })
        );
    });

    it('fails when Plus and Pro point at the same Stripe price', () => {
        const readiness = getDeploymentReadiness({
            ...completeEnv,
            STRIPE_PRICE_PLUS_MONTHLY: 'price_same',
            STRIPE_PRICE_PRO_MONTHLY: 'price_same',
        });

        expect(readiness.ok).toBe(false);
        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'stripe',
                warnings: ['Stripe Plus and Pro price IDs must be distinct'],
            })
        );
    });
});
