import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260807110000_harden_billing_entitlements/migration.sql'
);
const enumMigrationPath = join(
    process.cwd(),
    'prisma/migrations/20260807105000_add_billing_ledger_entry_types/migration.sql'
);

describe('billing entitlement hardening migrations', () => {
    it('commits new ledger enum values before using them', async () => {
        const [enumSql, entitlementSql] = await Promise.all([
            readFile(enumMigrationPath, 'utf8'),
            readFile(migrationPath, 'utf8'),
        ]);

        expect(enumSql).toContain(
            'ALTER TYPE "CreditLedgerEntryType" ADD VALUE \'ALLOWANCE_GRANTED\''
        );
        expect(enumSql).toContain(
            'ALTER TYPE "CreditLedgerEntryType" ADD VALUE \'ALLOWANCE_EXPIRED\''
        );
        expect(entitlementSql).not.toContain(
            'ALTER TYPE "CreditLedgerEntryType" ADD VALUE'
        );
    });

    it('preserves the exact Stripe period anchor without calendar reconstruction', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'SET "stripeCurrentPeriodStart" = "serverCreditsPeriodStart"'
        );
        expect(sql).toContain(
            'AND "serverCreditsPeriodStart" < "stripeCurrentPeriodEnd"'
        );
        expect(sql).not.toMatch(
            /"stripeCurrentPeriodEnd"\s*-\s*INTERVAL\s+'1 month'/i
        );
    });

    it('normalizes reservation periods before subtracting outstanding reservations', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const normalization = sql.indexOf(
            'UPDATE "CreditLedgerEntry" cle\nSET "billingPeriodStart"'
        );
        const reconciliation = sql.indexOf('WITH candidates AS');

        expect(normalization).toBeGreaterThan(-1);
        expect(reconciliation).toBeGreaterThan(normalization);
        expect(sql).toContain("WHEN 'RESERVED' THEN cle.\"credits\"");
        expect(sql).toContain("WHEN 'CONSUMED' THEN -cle.\"credits\"");
        expect(sql).toContain("WHEN 'RELEASED' THEN -cle.\"credits\"");
        expect(sql).toContain("WHEN 'EXPIRED' THEN -cle.\"credits\"");
        expect(sql).toContain(
            't.credit_limit - ba."monthlyServerCreditsUsed" - o.credits'
        );
    });
});
