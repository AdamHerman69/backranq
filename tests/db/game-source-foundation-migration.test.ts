import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260807120000_game_source_foundation/migration.sql'
);
const schemaPath = join(process.cwd(), 'prisma/schema.prisma');

describe('game source foundation migration', () => {
    it('separates import sources from provider synchronization exhaustively', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'CREATE TYPE "GameSource" AS ENUM (\'LICHESS\', \'CHESSCOM\', \'MANUAL_PGN\', \'BACKRANQ_COACH\')'
        );
        expect(sql).toContain(
            'CREATE TYPE "SyncProvider" AS ENUM (\'LICHESS\', \'CHESSCOM\')'
        );
        for (const table of [
            'ProviderSyncState',
            'HistoryImportQuota',
            'SyncJob',
            'OnboardingAnalyticsEvent',
            'MasterAccount',
            'MasterSourceGame',
        ]) {
            expect(sql).toMatch(
                new RegExp(
                    `ALTER TABLE "${table}"[\\s\\S]*?ALTER COLUMN "provider" TYPE "SyncProvider"`
                )
            );
        }
        expect(sql).toContain('DROP TYPE "Provider"');
    });

    it('creates one private durable account-connection boundary', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('CREATE TABLE "ChessAccountConnection"');
        expect(sql).toContain(
            '"ChessAccountConnection_userId_provider_key"'
        );
        expect(sql).not.toContain(
            '"ChessAccountConnection_provider_providerAccountId_key"'
        );
        expect(sql).toContain('"ChessAccountConnection_origin_shape"');
        expect(sql).toContain(
            '"origin" <> \'OAUTH_ACCOUNT\' OR "providerAccountId" IS NOT NULL'
        );
        expect(sql).toContain(
            'ALTER TABLE public."ChessAccountConnection" ENABLE ROW LEVEL SECURITY;'
        );
        expect(sql).toContain(
            'ALTER TABLE public."ChessAccountConnection" FORCE ROW LEVEL SECURITY;'
        );
        expect(sql).toContain(
            'REVOKE ALL PRIVILEGES ON TABLE public."ChessAccountConnection" FROM anon, authenticated;'
        );
        expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    });

    it('fails closed on incomplete or mutable game provenance', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const schema = await readFile(schemaPath, 'utf8');

        expect(sql).toContain('DELETE FROM "AnalyzedGame"');
        expect(sql).toContain('"userSide" = \'UNKNOWN\'');
        expect(sql).toContain('ALTER COLUMN "sourceUsername" SET NOT NULL');
        expect(schema).toMatch(
            /model AnalyzedGame \{[\s\S]*?userSide\s+GameUserSide\s*\n/
        );
        expect(schema).not.toMatch(
            /model AnalyzedGame \{[\s\S]*?userSide\s+GameUserSide\s+@default\(UNKNOWN\)/
        );
        expect(sql).toContain('"AnalyzedGame_frozen_perspective_check"');
        expect(sql).toContain('"AnalyzedGame_prevent_provenance_mutation"');
        expect(sql).toContain(
            'OLD."provider" IN (\'MANUAL_PGN\', \'BACKRANQ_COACH\')'
        );
        expect(sql).toContain('OLD."pgn" IS DISTINCT FROM NEW."pgn"');
        expect(sql).toContain(
            'OLD."sourcePgnHash" IS DISTINCT FROM NEW."sourcePgnHash"'
        );
        expect(sql).toContain(
            "CONSTRAINT = 'AnalyzedGame_local_source_pgn_immutable'"
        );
        expect(sql).toContain(
            'REVOKE EXECUTE ON FUNCTION public.prevent_analyzed_game_provenance_mutation() FROM PUBLIC, anon, authenticated;'
        );
    });

    it('removes mutable provider usernames from the application user', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('DROP COLUMN "lichessUsername"');
        expect(sql).toContain('DROP COLUMN "chesscomUsername"');
    });
});
