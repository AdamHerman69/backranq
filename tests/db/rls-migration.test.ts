import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260704180000_harden_public_table_access/migration.sql'
);
const prismaMigrationTableMigrationPath = join(
    process.cwd(),
    'prisma/migrations/20260704183000_harden_prisma_migration_table_access/migration.sql'
);

const privateTables = [
    'User',
    'AnalyzedGame',
    'Puzzle',
    'PuzzleAttempt',
    'Account',
    'Session',
    'VerificationToken',
];

describe('public table access hardening migration', () => {
    it('enables RLS and revokes Supabase Data API role privileges', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        for (const tableName of privateTables) {
            expect(sql).toContain(
                `ALTER TABLE public."${tableName}" ENABLE ROW LEVEL SECURITY;`
            );
            expect(sql).toContain(
                `REVOKE ALL PRIVILEGES ON TABLE public."${tableName}" FROM anon, authenticated;`
            );
        }

        expect(sql).toContain(
            'ALTER DEFAULT PRIVILEGES IN SCHEMA public\nREVOKE ALL ON TABLES FROM anon, authenticated;'
        );
        expect(sql).not.toMatch(/CREATE\s+POLICY/i);
        expect(sql).not.toMatch(/GRANT\s+.*\s+TO\s+(anon|authenticated)/i);
    });

    it('keeps Prisma migration history out of Data API role access', async () => {
        const sql = await readFile(prismaMigrationTableMigrationPath, 'utf8');

        expect(sql).toContain(
            'ALTER TABLE public._prisma_migrations ENABLE ROW LEVEL SECURITY;'
        );
        expect(sql).toContain(
            'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM anon, authenticated;'
        );
        expect(sql).not.toMatch(/CREATE\s+POLICY/i);
        expect(sql).not.toMatch(/GRANT\s+.*\s+TO\s+(anon|authenticated)/i);
    });
});
