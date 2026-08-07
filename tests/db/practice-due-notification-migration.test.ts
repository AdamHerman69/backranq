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
    it('adds the due campaign and token-fenced delivery contracts', () => {
        expect(migration).toContain(
            'ALTER TYPE "NotificationType" ADD VALUE \'PRACTICE_DUE\''
        );
        expect(migration).toContain(
            'ALTER TYPE "NotificationDeliveryStatus" ADD VALUE \'QUEUED\''
        );
        expect(migration).toContain('ADD COLUMN "dispatchToken" UUID');
        expect(migration).toContain(
            '"NotificationDelivery_status_scheduledFor_id_idx"'
        );
        expect(migration).toContain(
            '"NotificationDelivery_status_lockedUntil_id_idx"'
        );
    });

    it('creates index-backed raw keyset streams before eligibility joins', () => {
        expect(migration).toContain(
            '"PracticeReviewState_due_lapsed_scan_idx"'
        );
        expect(migration).toContain(
            'WHERE "lapses" > 0'
        );
        expect(migration).toContain(
            '"PracticeReviewState_due_clean_scan_idx"'
        );
        expect(migration).toContain(
            'WHERE "lapses" = 0'
        );
        expect(migration).toContain(
            '"TrainingMoment_new_practice_scan_idx"'
        );
        expect(migration).toContain(
            '"PracticeDueSweep_status_completedAt_id_idx"'
        );
        expect(migration).toContain(
            '"PracticeDueSweep_single_active_key"'
        );
    });

    it('protects durable sweep tables from the public data API', () => {
        for (const table of ['PracticeDueSweep', 'PracticeDueSweepUser']) {
            expect(migration).toContain(
                `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`
            );
            expect(migration).toContain(
                `ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY`
            );
            expect(migration).toContain(
                `REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM anon, authenticated`
            );
        }
        expect(migration).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
    });
});
