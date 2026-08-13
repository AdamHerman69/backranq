import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { getDeploymentReadiness } from '@/lib/config/deploymentReadiness';

const completeEnv = {
    DATABASE_URL:
        'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1',
    DIRECT_URL:
        'postgresql://postgres:secret@db.project.supabase.co:5432/postgres',
    NEXTAUTH_SECRET: 'secret',
    NEXTAUTH_URL: 'http://localhost:3000',
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_123',
    STRIPE_PRICE_PLUS_MONTHLY: 'price_plus',
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro',
    BACKRANQ_ADMIN_API_SECRET: 'ops-secret',
    CRON_SECRET: 'cron-secret',
    SMTP2GO_API_KEY: 'smtp-key',
    SMTP2GO_WEBHOOK_SECRET: 'smtp-webhook-secret',
    BACKRANQ_EMAIL_FROM: 'Backranq <notifications@example.com>',
    NOTIFICATION_UNSUBSCRIBE_SECRET: 'unsubscribe-secret',
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: 'vapid-public',
    VAPID_PRIVATE_KEY: 'vapid-private',
    VAPID_SUBJECT: 'mailto:support@example.com',
};

describe('deployment readiness', () => {
    it('keeps operator reconciliation scripts in source control', () => {
        expect(
            existsSync(
                new URL(
                    '../../scripts/reconcile-credit-ledger.mjs',
                    import.meta.url
                )
            )
        ).toBe(true);
        expect(
            existsSync(
                new URL(
                    '../../scripts/smoke-stripe-billing.mjs',
                    import.meta.url
                )
            )
        ).toBe(true);
    });

    it('passes when required runtime settings are present', () => {
        const readiness = getDeploymentReadiness(completeEnv);

        expect(readiness.ok).toBe(true);
        expect(readiness.checks.every((check) => check.ok)).toBe(true);
    });

    it('reports missing auth, Stripe and admin settings without exposing values', () => {
        const readiness = getDeploymentReadiness({
            DATABASE_URL: 'postgresql://runtime/backranq',
            DIRECT_URL: 'postgresql://direct/backranq',
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
                ]),
            })
        );
        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'auth',
                missing: expect.arrayContaining([
                    'NEXTAUTH_SECRET',
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

    it('requires safe serverless pool settings in the production profile', () => {
        const readiness = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres',
            DIRECT_URL:
                'postgresql://postgres:secret@db.project.supabase.co:5432/postgres',
        });

        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'database',
                warnings: expect.arrayContaining([
                    'DATABASE_URL pooler URL must include pgbouncer=true',
                    'DATABASE_URL pooler URL must include connection_limit=1 or connection_limit=2',
                ]),
            })
        );
    });

    it('rejects a direct production runtime URL even when both targets match', () => {
        const readiness = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://postgres:secret@db.project.supabase.co:5432/postgres?connection_limit=1',
        });

        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'database',
                warnings: expect.arrayContaining([
                    'DATABASE_URL must use a pooled runtime URL',
                    'DATABASE_URL pooler URL must include pgbouncer=true',
                ]),
            })
        );
    });

    it('does not let a fake pgbouncer query turn direct Supabase or Neon hosts into poolers', () => {
        const supabase = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://postgres:secret@db.project.supabase.co:5432/postgres?pgbouncer=true&connection_limit=1',
        });
        const neon = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://app:secret@ep-example.eu-central-1.aws.neon.tech/backranq?pgbouncer=true&connection_limit=1',
            DIRECT_URL:
                'postgresql://app:secret@ep-example.eu-central-1.aws.neon.tech/backranq',
        });

        for (const readiness of [supabase, neon]) {
            expect(readiness.checks[0]).toEqual(
                expect.objectContaining({
                    ok: false,
                    warnings: expect.arrayContaining([
                        'DATABASE_URL must use a pooled runtime URL',
                    ]),
                })
            );
        }
    });

    it('rejects a pooled migration URL', () => {
        const readiness = getDeploymentReadiness({
            ...completeEnv,
            DIRECT_URL:
                'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres?pgbouncer=true',
        });

        expect(readiness.checks).toContainEqual(
            expect.objectContaining({
                group: 'database',
                warnings: expect.arrayContaining([
                    'DIRECT_URL must use a direct, non-pooled database URL',
                ]),
            })
        );
    });

    it('rejects different logical databases for generic and Supabase targets', () => {
        const generic = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://runtime:secret@postgres.internal:5432/backranq?pgbouncer=true&connection_limit=1',
            DIRECT_URL:
                'postgresql://direct:secret@other.internal:5432/backranq',
        });
        const supabase = getDeploymentReadiness({
            ...completeEnv,
            DIRECT_URL:
                'postgresql://postgres:secret@db.other-project.supabase.co:5432/postgres',
        });

        for (const readiness of [generic, supabase]) {
            expect(readiness.checks).toContainEqual(
                expect.objectContaining({
                    group: 'database',
                    warnings: expect.arrayContaining([
                        'DATABASE_URL and DIRECT_URL identify different logical databases',
                    ]),
                })
            );
        }
    });

    it('recognizes explicit Supabase and Neon pooler/direct variants', () => {
        const neon = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://app:secret@ep-example-pooler.eu-central-1.aws.neon.tech/backranq?pgbouncer=true&connection_limit=2',
            DIRECT_URL:
                'postgresql://app:secret@ep-example.eu-central-1.aws.neon.tech/backranq',
        });

        expect(getDeploymentReadiness(completeEnv).checks[0]?.ok).toBe(true);
        expect(neon.checks[0]?.ok).toBe(true);
    });

    it('rejects otherwise matching targets that select different schemas', () => {
        const readiness = getDeploymentReadiness({
            ...completeEnv,
            DATABASE_URL:
                'postgresql://runtime:secret@postgres.internal:5432/backranq?schema=tenant_a&pgbouncer=true&connection_limit=1',
            DIRECT_URL:
                'postgresql://direct:secret@postgres.internal:5432/backranq?schema=public',
        });

        expect(readiness.checks[0]).toEqual(
            expect.objectContaining({
                ok: false,
                warnings: expect.arrayContaining([
                    'DATABASE_URL and DIRECT_URL identify different logical databases',
                ]),
            })
        );
    });

    it('keeps the CLI and web adapter on the same readiness contract', () => {
        const stdout = execFileSync(
            process.execPath,
            [
                'scripts/check-runtime-readiness.mjs',
                '--no-env-files',
                '--json',
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    PATH: process.env.PATH,
                    NODE_ENV: 'production',
                    ...completeEnv,
                },
            }
        );

        expect(JSON.parse(stdout)).toEqual(getDeploymentReadiness(completeEnv));
    });
});
