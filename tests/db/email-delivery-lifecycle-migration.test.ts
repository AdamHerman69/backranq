import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../prisma/migrations/20260807140000_harden_email_delivery_lifecycle/migration.sql',
        import.meta.url
    ),
    'utf8'
);

describe('shared email delivery lifecycle migration', () => {
    it('adds an exact dispatch-stream index and denormalized priority', () => {
        expect(migration).toContain(
            'ADD COLUMN "dispatchPriority" INTEGER NOT NULL DEFAULT 1'
        );
        expect(migration).toContain(
            '"NotificationDelivery_dispatch_stream_idx"'
        );
        expect(migration).toContain(
            'CHECK ("dispatchPriority" IN (0, 1))'
        );
        expect(migration).toContain(
            '"status",\n    "channel",\n    "dispatchPriority",\n    "scheduledFor",\n    "createdAt",\n    "id"'
        );
    });

    it('creates atomic provider-day counters and unique Practice windows', () => {
        expect(migration).toContain('CREATE TABLE "EmailProviderDay"');
        expect(migration).toContain('CREATE TABLE "EmailSendReservation"');
        expect(migration).toContain(
            '"EmailSendReservation_ownerToken_key"'
        );
        expect(migration).toContain(
            '"EmailSendReservation_practiceWindowKey_key"'
        );
        expect(migration).toContain(
            'CHECK ("nonPriorityReservedCount" <= "reservedCount")'
        );
    });

    it('keeps budget and reservation state outside the public Data API', () => {
        for (const table of ['EmailProviderDay', 'EmailSendReservation']) {
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
