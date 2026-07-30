import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('history import quota schema', () => {
    it('has a per-identity unique key and a database-level hard cap', () => {
        const schema = readFileSync('prisma/schema.prisma', 'utf8');
        const migration = readFileSync(
            'prisma/migrations/20260730110000_add_history_import_quota/migration.sql',
            'utf8'
        );
        const leaseMigration = readFileSync(
            'prisma/migrations/20260730120000_add_history_import_fetch_lease/migration.sql',
            'utf8'
        );

        expect(schema).toContain('model HistoryImportQuota');
        expect(schema).toContain(
            '@@unique([userId, provider, usernameNormalized])'
        );
        expect(migration).toContain(
            'CHECK ("createdCount" BETWEEN 0 AND 2000)'
        );
        expect(schema).toContain('fetchLeaseToken');
        expect(schema).toContain('fetchLeaseUntil');
        expect(leaseMigration).toContain(
            'ADD COLUMN "fetchLeaseUntil" TIMESTAMP(3)'
        );
    });
});
