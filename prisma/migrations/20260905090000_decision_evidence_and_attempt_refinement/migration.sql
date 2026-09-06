-- Pre-user contract replacement: old closed-set exercises cannot truthfully
-- claim the new evidence contract. Remove only that obsolete training graph.
DELETE FROM "TrainingMoment";
-- Public exercises use the same grading DTO. Re-extract obsolete candidates;
-- retain source snapshots, roster/accounts, and pipeline history.
DELETE FROM "MasterPublication";
DELETE FROM "MasterCandidate";
DELETE FROM "MasterAnalysisReceipt";

ALTER TYPE "MoveAssessmentSource" ADD VALUE 'CLIENT_EVALUATED';

-- A neutral reveal may retain a legal attempted move without asserting a grade.
ALTER TABLE "TrainingAttempt" DROP CONSTRAINT "TrainingAttempt_status_payload";
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_status_payload" CHECK (
    ("status" = 'PENDING' AND "grade" IS NULL AND "completedAt" IS NULL) OR
    ("status" = 'GRADED' AND "grade" IS NOT NULL AND "userMoveUci" IS NOT NULL AND "completedAt" IS NOT NULL) OR
    ("status" = 'REVEALED' AND "grade" IS NULL AND "gradingSource" IS NULL AND "completedAt" IS NOT NULL) OR
    ("status" IN ('SKIPPED', 'UNRESOLVED') AND "grade" IS NULL AND "completedAt" IS NOT NULL)
);

ALTER TABLE "SolutionRevision"
    ADD COLUMN "decision" JSONB NOT NULL,
    ADD COLUMN "answerCoverage" JSONB NOT NULL,
    ADD COLUMN "continuation" JSONB NOT NULL,
    ADD COLUMN "originalDecision" JSONB NOT NULL;

ALTER TABLE "SolutionMoveAssessment"
    ADD COLUMN "referenceId" TEXT NOT NULL,
    ADD COLUMN "tierStable" BOOLEAN NOT NULL;

CREATE TABLE "TrainingAttemptAssessmentRevision" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "clientEvidenceId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "grade" "AttemptGrade" NOT NULL,
    "gradingSource" "MoveAssessmentSource" NOT NULL,
    "comparison" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "corrected" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrainingAttemptAssessmentRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainingAttemptAssessmentRevision_attemptId_fkey"
        FOREIGN KEY ("attemptId") REFERENCES "TrainingAttempt"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrainingAttemptAssessmentRevision_attemptId_clientEvidenceI_key"
    ON "TrainingAttemptAssessmentRevision"("attemptId", "clientEvidenceId");
CREATE INDEX "TrainingAttemptAssessmentRevision_attemptId_createdAt_idx"
    ON "TrainingAttemptAssessmentRevision"("attemptId", "createdAt");
ALTER TABLE "TrainingAttemptAssessmentRevision" ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE "TrainingAttemptAssessmentRevision" FROM anon, authenticated;
