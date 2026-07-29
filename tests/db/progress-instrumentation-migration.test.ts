import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260730160000_add_progress_provenance_instrumentation/migration.sql'
);

describe('progress provenance and instrumentation migration', () => {
    it('adds immutable source and attempt context needed for honest cohorts', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('ADD COLUMN "sourcePgnHash" TEXT');
        expect(sql).toContain('ADD COLUMN "sourceUsername" TEXT');
        expect(sql).toContain('ADD COLUMN "sourceAccountId" TEXT');
        expect(sql).toContain(
            'ADD COLUMN "userSide" "GameUserSide" NOT NULL'
        );
        expect(sql).toContain('ADD COLUMN "timeControlRaw" TEXT');
        expect(sql).toContain(
            'ADD COLUMN "timeControlInitialSeconds" INTEGER'
        );
        expect(sql).toContain(
            'ADD COLUMN "timeControlIncrementSeconds" INTEGER'
        );
        expect(sql).toContain(
            'ADD COLUMN "currentAnalysisValid" BOOLEAN NOT NULL DEFAULT FALSE'
        );
        expect(sql).toContain('ADD COLUMN "contextProvider" "Provider"');
        expect(sql).toContain('ADD COLUMN "contextTimeClass" "TimeClass"');
        expect(sql).toContain('ADD COLUMN "contextSolutionHash" TEXT');
        expect(sql).toContain(
            'ADD COLUMN "contextThemeTaxonomyVersion" TEXT NOT NULL'
        );
        expect(sql).toContain(
            'CONSTRAINT "AnalyzedGame_time_control_nonnegative" CHECK'
        );

        const gameExpand = sql.indexOf(
            'ADD COLUMN "sourcePgnHash" TEXT'
        );
        const gameBackfill = sql.indexOf(
            'UPDATE "AnalyzedGame"'
        );
        const gameContract = sql.indexOf(
            'ALTER COLUMN "sourcePgnHash" SET NOT NULL'
        );
        const attemptExpand = sql.indexOf(
            'ADD COLUMN "contextProvider" "Provider"'
        );
        const attemptBackfill = sql.indexOf(
            'UPDATE "TrainingAttempt" AS attempt'
        );
        const attemptContract = sql.indexOf(
            'ALTER COLUMN "contextProvider" SET NOT NULL'
        );

        expect(gameExpand).toBeGreaterThanOrEqual(0);
        expect(gameBackfill).toBeGreaterThan(gameExpand);
        expect(gameContract).toBeGreaterThan(gameBackfill);
        expect(attemptExpand).toBeGreaterThanOrEqual(0);
        expect(attemptBackfill).toBeGreaterThan(attemptExpand);
        expect(attemptContract).toBeGreaterThan(attemptBackfill);
        expect(sql).toContain(
            "RAISE EXCEPTION 'cannot backfill exact source PGN provenance'"
        );
        expect(sql).toContain(
            "RAISE EXCEPTION 'cannot backfill immutable attempt context'"
        );
        expect(sql).toContain(
            "convert_to('backranq-source-pgn', 'UTF8')"
        );
        expect(sql).toContain("decode('00', 'hex')");
        expect(sql).toContain("E'\\\\r\\\\n?'");
        expect(sql).toContain("'sha256'");
        expect(sql).toContain(
            'UPDATE "AnalyzedGame" AS game'
        );
        expect(sql).toContain(
            'WHEN game."provider" = \'LICHESS\' THEN owner."lichessUsername"'
        );
        expect(sql).toContain(
            'THEN \'WHITE\'::"GameUserSide"'
        );
        expect(sql).toContain(
            'THEN \'BLACK\'::"GameUserSide"'
        );
        expect(sql).toContain(
            'CREATE TRIGGER "invalidate_current_analysis_on_source_change"'
        );
        expect(sql).toContain(
            'NEW."currentAnalysisValid" := FALSE'
        );
    });

    it('creates append-only exposure, status, review, and bounded analytics records', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        for (const table of [
            'PracticeExposure',
            'TrainingAttemptStatusEvent',
            'PracticeReviewState',
            'PracticeReviewEvent',
            'ProgressAnalyticsEvent',
            'ProgressAnalyticsRateBucket',
        ]) {
            expect(sql).toContain(`CREATE TABLE "${table}"`);
        }

        expect(sql).toContain(
            'CONSTRAINT "PracticeExposure_kind_payload" CHECK'
        );
        expect(sql).toContain(
            '"terminalReason" IN (\'MOVE_SUBMITTED\', \'REVEALED\')'
        );
        expect(sql).toContain(
            '"terminalReason" IN (\'ABANDONED\', \'REPLACED\', \'NAVIGATED_AWAY\')'
        );
        expect(sql).toContain(
            'CONSTRAINT "TrainingAttemptStatusEvent_payload" CHECK'
        );
        expect(sql).toContain(
            'CONSTRAINT "PracticeReviewState_counters_nonnegative" CHECK'
        );
        expect(sql).toContain(
            'CONSTRAINT "PracticeReviewEvent_grade_payload" CHECK'
        );
        expect(sql).toContain(
            'CONSTRAINT "ProgressAnalyticsEvent_payload" CHECK'
        );
        expect(sql).toContain(
            'CONSTRAINT "ProgressAnalyticsEvent_window_days" CHECK'
        );
        expect(sql).not.toMatch(/"payload"\s+JSONB/i);
        expect(sql).not.toMatch(/\b(FEN|moveUci|solutionTree|bestMoveUci)\b/i);
    });

    it('enforces idempotency and same-owner foreign keys', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'CREATE UNIQUE INDEX "PracticeExposure_userId_clientEventId_key"'
        );
        expect(sql).toContain(
            'CREATE UNIQUE INDEX "TrainingAttemptStatusEvent_attemptId_eventKey_key"'
        );
        expect(sql).toContain(
            'CREATE UNIQUE INDEX "PracticeReviewState_user_moment_semantics_key"'
        );
        expect(sql).toContain('"configHash" TEXT NOT NULL');
        expect(sql).toContain(
            'CREATE UNIQUE INDEX "PracticeReviewEvent_userId_eventKey_key"'
        );
        expect(sql).toContain(
            'CREATE UNIQUE INDEX "ProgressAnalyticsEvent_userId_clientEventId_key"'
        );
        expect(sql).toContain(
            'FOREIGN KEY ("trainingMomentId", "userId") REFERENCES "TrainingMoment"("id", "userId")'
        );
        expect(sql).toContain(
            'FOREIGN KEY ("attemptId", "userId") REFERENCES "TrainingAttempt"("id", "userId")'
        );
    });

    it('keeps all event and review tables private and supplies Progress indexes', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const tables = [
            'PracticeExposure',
            'TrainingAttemptStatusEvent',
            'PracticeReviewState',
            'PracticeReviewEvent',
            'ProgressAnalyticsEvent',
            'ProgressAnalyticsRateBucket',
        ];

        for (const table of tables) {
            expect(sql).toContain(
                `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`
            );
            expect(sql).toContain(
                `ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY;`
            );
            expect(sql).toContain(
                `REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM anon, authenticated;`
            );
        }

        expect(sql).toContain(
            'CREATE INDEX "TrainingAttempt_user_provider_class_time_idx"'
        );
        expect(sql).toContain(
            'CREATE INDEX "TrainingAttempt_user_phase_time_idx"'
        );
        expect(sql).toContain(
            'CREATE INDEX "PracticeReviewState_user_due_idx"'
        );
        expect(sql).toContain(
            'CREATE INDEX "PracticeExposure_solutionRevisionId_idx"'
        );
        expect(sql).toContain(
            'CREATE INDEX "ProgressAnalyticsEvent_user_recorded_time_idx"'
        );
        expect(sql).not.toMatch(/CREATE\s+POLICY/i);
        expect(sql).not.toMatch(
            /GRANT\s+.*\s+TO\s+(anon|authenticated)/i
        );
    });
});
