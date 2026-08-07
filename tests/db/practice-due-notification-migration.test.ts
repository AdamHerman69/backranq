import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../prisma/migrations/20260807130000_add_practice_due_notifications/migration.sql',
        import.meta.url
    ),
    'utf8'
);

describe('practice due notification migration', () => {
    it('adds only the explicit notification type', () => {
        expect(migration).toContain(
            'ALTER TYPE "NotificationType" ADD VALUE \'PRACTICE_DUE\''
        );
        expect(migration).not.toMatch(/CREATE INDEX/i);
        expect(migration).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
    });
});
