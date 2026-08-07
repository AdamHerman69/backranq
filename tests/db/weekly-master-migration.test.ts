import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260806100000_add_weekly_master_pipeline/migration.sql'
);

describe('Weekly Master migration', () => {
    it('keeps master content separate from product users and preserves discoveries', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('CREATE TABLE "MasterPerson"');
        expect(sql).toContain('CREATE TABLE "MasterSourceGameSnapshot"');
        expect(sql).toContain('CREATE TABLE "MasterSourceGameDiscovery"');
        expect(sql).toContain('CREATE TABLE "MasterAnalysisReceipt"');
        expect(sql).toContain(
            'PRIMARY KEY ("sourceGameId", "accountId")'
        );
        expect(sql).not.toMatch(
            /CREATE TABLE "MasterSourceGame"[\s\S]*?"userId" UUID/
        );
    });

    it('enforces durable work and expiring override invariants', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('"MasterPipelineRun_one_active_idx"');
        expect(sql).toContain(
            'WHERE "status" IN (\'QUEUED\', \'RUNNING\')'
        );
        expect(sql).toContain('"MasterAdminOverride_valid_window"');
        expect(sql).toContain('"MasterAdminOverride_scope"');
        expect(sql).toContain('"AdminAuditLog_idempotencyKey_key"');
    });

    it('keeps master and anonymous analytics tables private behind server routes', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const privateTables = [
            'AdminMembership',
            'AdminAuditLog',
            'OnboardingAnalyticsEvent',
            'OnboardingRateBucket',
            'MasterPerson',
            'MasterAccount',
            'MasterPipelineRun',
            'MasterSourceGame',
            'MasterSourceGameDiscovery',
            'MasterSourceGameSnapshot',
            'MasterAnalysisReceipt',
            'MasterCandidate',
            'MasterPublication',
            'MasterSlot',
            'MasterAdminOverride',
        ];
        for (const table of privateTables) {
            expect(sql).toContain(
                `ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY;`
            );
            expect(sql).toContain(
                `REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM anon, authenticated;`
            );
        }
    });

    it('uses strict typed onboarding events without a free-form payload', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('CREATE TYPE "OnboardingEventName"');
        expect(sql).toContain('"progressMilestone" IN (25, 50, 75, 100)');
        expect(sql).toContain(
            'PRIMARY KEY ("keyHash", "namespace")'
        );
        const eventTable = sql.match(
            /CREATE TABLE "OnboardingAnalyticsEvent" \(([\s\S]*?)\n\);/
        )?.[1];
        expect(eventTable).not.toContain('payload');
        expect(eventTable).not.toContain('username');
        expect(eventTable).not.toContain('fen');
        expect(eventTable).not.toContain('pgn');
    });

    it('does not declare the same schema object twice', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const declaredNames = Array.from(
            sql.matchAll(
                /CREATE (?:UNIQUE )?(?:TABLE|TYPE|INDEX) "([^"]+)"/g
            ),
            (match) => match[1]
        );

        expect(new Set(declaredNames).size).toBe(declaredNames.length);
    });

    it('keeps required candidate arrays non-null at the SQL boundary', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        for (const field of [
            'positionHistory',
            'sourceKinds',
            'lessonKinds',
            'themes',
            'acceptedMovesUci',
            'rejectionReasons',
        ]) {
            expect(sql).toMatch(
                new RegExp(`"${field}"[^\\n]+NOT NULL[^\\n]+DEFAULT`)
            );
        }
    });
});
