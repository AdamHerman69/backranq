import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
    process.cwd(),
    'prisma/migrations/20260729130000_add_training_foundation/migration.sql'
);

describe('training foundation migration', () => {
    it('creates the canonical training model and removes the legacy domain', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain('CREATE TABLE "TrainingMoment"');
        expect(sql).toContain('CREATE TABLE "SolutionRevision"');
        expect(sql).toContain('CREATE TABLE "TrainingMomentObservation"');
        expect(sql).toContain('CREATE TABLE "SolutionMoveAssessment"');
        expect(sql).toContain(
            'CREATE UNIQUE INDEX "SolutionMoveAssessment_revision_decision_position_move_key" ON "SolutionMoveAssessment"("solutionRevisionId", "decisionIndex", "positionKey", "moveUci")'
        );
        expect(sql).toContain('CREATE TABLE "TrainingAttempt"');
        expect(sql).toContain('CREATE TABLE "TrainingAttemptStep"');
        expect(sql).toContain('CREATE TABLE "AnalysisOpsCounter"');
        expect(sql).toContain(
            'REFERENCES "TrainingMoment"("id") ON DELETE CASCADE'
        );
        expect(sql).not.toContain('LEGACY_UNVERIFIED');
        expect(sql).not.toContain('ALTER TABLE "Puzzle"');
        expect(sql).not.toContain('ALTER TABLE "PuzzleAttempt"');
        expect(sql).toContain('DROP TABLE "PuzzleAttempt"');
        expect(sql).toContain('DROP TABLE "Puzzle"');
        expect(sql).toContain('DROP TYPE "PuzzleKind"');
        expect(sql).toContain('DROP TYPE "PuzzleType"');
        expect(sql).not.toMatch(/\bTRUNCATE\b/i);
        expect(sql).not.toMatch(/\bINSERT\s+INTO\s+"?(Puzzle|PuzzleAttempt)"?/i);
        expect(sql).not.toMatch(/\bUPDATE\s+"?(Puzzle|PuzzleAttempt)"?\s+SET\b/i);
    });

    it('keeps all new data tables private from Supabase Data API roles', async () => {
        const sql = await readFile(migrationPath, 'utf8');
        const tables = [
            'TrainingMoment',
            'SolutionRevision',
            'TrainingMomentObservation',
            'SolutionMoveAssessment',
            'TrainingAttempt',
            'TrainingAttemptStep',
            'AnalysisOpsCounter',
        ];

        for (const table of tables) {
            expect(sql).toContain(
                `ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY;`
            );
            expect(sql).toContain(
                `REVOKE ALL PRIVILEGES ON TABLE public."${table}" FROM anon, authenticated;`
            );
        }
        expect(sql).not.toMatch(/CREATE\s+POLICY/i);
        expect(sql).not.toMatch(
            /GRANT\s+.*\s+TO\s+(anon|authenticated)/i
        );
    });

    it('enforces retry and active-grading concurrency invariants', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'CREATE UNIQUE INDEX "TrainingAttempt_userId_clientAttemptId_key"'
        );
        expect(sql).toMatch(
            /CREATE UNIQUE INDEX "AnalysisRun_one_active_per_game_key"[\s\S]*WHERE "status" IN \('QUEUED', 'RUNNING'\)/
        );
        expect(sql).toMatch(
            /CREATE UNIQUE INDEX "TrainingAttempt_one_pending_per_user_key"[\s\S]*WHERE "status" = 'PENDING'/
        );
        expect(sql).toContain(
            '"attempts" INTEGER NOT NULL DEFAULT 0'
        );
        expect(sql).toContain(
            '"status" "AttemptStatus" NOT NULL DEFAULT \'PENDING\''
        );
        expect(sql).toContain('"lockedUntil" TIMESTAMP(3)');
        expect(sql).toContain('"solutionRevisionId" UUID NOT NULL');
        expect(sql).toContain(
            'REFERENCES "SolutionRevision"("id", "momentId") ON DELETE CASCADE'
        );
        expect(sql).not.toContain(
            'REFERENCES "SolutionRevision"("id", "momentId") ON DELETE RESTRICT'
        );
        expect(sql).not.toContain('"wasCorrect"');
        expect(sql).toContain('ADD COLUMN "inputPgnHash" TEXT NOT NULL');
        expect(sql).toContain('"engineOptions" JSONB NOT NULL');
        expect(sql).toContain(
            'ALTER TABLE "AnalysisJob" ALTER COLUMN "analysisRunId" SET NOT NULL'
        );
        expect(sql).toContain(
            'REFERENCES "AnalysisRun"("id") ON DELETE CASCADE'
        );
    });

    it('enforces ownership, provenance, and safe delete invariants', async () => {
        const sql = await readFile(migrationPath, 'utf8');

        expect(sql).toContain(
            'FOREIGN KEY ("gameId", "userId") REFERENCES "AnalyzedGame"("id", "userId") ON DELETE CASCADE'
        );
        expect(sql).toContain(
            'FOREIGN KEY ("trainingMomentId", "userId") REFERENCES "TrainingMoment"("id", "userId") ON DELETE CASCADE'
        );
        expect(sql).toContain(
            'FOREIGN KEY ("currentSolutionRevisionId") REFERENCES "SolutionRevision"("id") ON DELETE SET NULL'
        );
        expect(sql).toContain(
            'CREATE UNIQUE INDEX "TrainingMoment_currentSolutionRevisionId_key"'
        );
        expect(sql).toContain(
            'CREATE TRIGGER "TrainingMoment_current_revision_membership"'
        );
        expect(sql).toContain(
            'CREATE TRIGGER "AnalyzedGame_current_run_membership"'
        );
        expect(sql).toContain(
            'CREATE TRIGGER "AnalysisJob_run_membership"'
        );
        expect(sql).toContain(
            'CREATE TRIGGER "TrainingMomentObservation_provenance"'
        );
        expect(sql).toContain(
            'r."inputPgnHash" = m."sourcePgnHash"'
        );
        expect(sql).toContain(
            's."solutionHash" = NEW."observedSolutionHash"'
        );
        expect(sql).toContain(
            'CONSTRAINT "TrainingAttempt_status_payload" CHECK'
        );
        expect(sql).toContain(
            'CONSTRAINT "TrainingAttemptStep_move_uci" CHECK'
        );
    });
});
