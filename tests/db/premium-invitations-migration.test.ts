import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260807100000_add_premium_invitations/migration.sql'
);

describe('premium invitations migration', () => {
    it('separates Stripe state from the effective plan', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('ADD COLUMN "planSource"');
        expect(sql).toContain('ADD COLUMN "stripePlan"');
        expect(sql).toContain(
            "WHEN \"stripeSubscriptionStatus\" IN ('active', 'trialing')"
        );
    });

    it('keeps invitation tokens and grants private behind server routes', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        for (const table of ['PremiumInvitation', 'PlanGrant']) {
            expect(sql).toContain(
                `ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY;`
            );
            expect(sql).toContain(
                `REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM anon, authenticated;`
            );
        }
    });
});
