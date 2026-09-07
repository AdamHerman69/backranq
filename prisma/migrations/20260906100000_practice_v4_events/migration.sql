-- Clean pre-user replacement. Preserve games, accounts, source snapshots and unrelated state.
BEGIN;
-- Old extraction configurations/checkpoints cannot be resumed under v4. Keep
-- historical runs and ledger entries, but stop their incompatible active work.
CREATE TEMP TABLE practice_v4_cancelled_runs ON COMMIT DROP AS
SELECT "id" FROM "AnalysisRun"
WHERE "status" IN ('QUEUED', 'RUNNING')
  AND "configSnapshot"->>'version' IS DISTINCT FROM '4';
CREATE TEMP TABLE practice_v4_cancelled_jobs ON COMMIT DROP AS
SELECT "id" FROM "AnalysisJob"
WHERE "status" IN ('QUEUED', 'RUNNING')
  AND "analysisRunId" IN (SELECT "id" FROM practice_v4_cancelled_runs);
CREATE TEMP TABLE practice_v4_cancelled_batches ON COMMIT DROP AS
SELECT "id" FROM "AnalysisBatch"
WHERE "status" IN ('PENDING', 'PLANNING', 'QUEUED', 'PARTIAL')
  AND "configSnapshot"->>'version' IS DISTINCT FROM '4';

-- Reservation settlement is period-specific. Already consumed/expired/released
-- credits are never returned a second time; old-period releases do not replenish
-- the current allowance. This uses the same cap as billingAccounts.ts.
CREATE TEMP TABLE practice_v4_releases ON COMMIT DROP AS
WITH referenced AS (
  SELECT ledger.*, COALESCE(ledger."analysisRunId", job."analysisRunId") AS "settlementRunId"
  FROM "CreditLedgerEntry" ledger LEFT JOIN "AnalysisJob" job ON job."id" = ledger."analysisJobId"
  WHERE ledger."scope" = 'RESERVATION'
)
SELECT ledger."userId", MIN(ledger."analysisJobId"::text)::uuid AS "analysisJobId",
  ledger."settlementRunId" AS "analysisRunId", run."gameId", ledger."billingPeriodStart",
  GREATEST(0, SUM(CASE ledger."type" WHEN 'RESERVED' THEN ledger."credits"
    WHEN 'CONSUMED' THEN -ledger."credits" WHEN 'RELEASED' THEN -ledger."credits"
    WHEN 'EXPIRED' THEN -ledger."credits" ELSE 0 END))::integer AS credits
FROM referenced ledger JOIN "AnalysisRun" run ON run."id" = ledger."settlementRunId"
WHERE run."id" IN (SELECT "id" FROM practice_v4_cancelled_runs)
GROUP BY ledger."userId", ledger."settlementRunId", run."gameId", ledger."billingPeriodStart";
INSERT INTO "CreditLedgerEntry" ("userId", "analysisJobId", "analysisRunId", "gameId", "type", "scope", "billingPeriodStart", "credits", "idempotencyKey", "reason")
SELECT "userId", "analysisJobId", "analysisRunId", "gameId", 'RELEASED', 'RESERVATION', "billingPeriodStart", credits,
  'practice-v4-reset:' || md5(concat_ws(':', "userId", "analysisJobId", "analysisRunId", "gameId", "billingPeriodStart")), 'EXTRACTION_V4_RESET'
FROM practice_v4_releases WHERE credits > 0;
WITH restorable AS (
  SELECT account."userId", SUM(release.credits)::integer AS credits
  FROM "BillingAccount" account JOIN practice_v4_releases release
    ON release."userId" = account."userId" AND release."billingPeriodStart" = account."serverCreditsPeriodStart"
  GROUP BY account."userId"
), outstanding AS (
  SELECT account."userId", GREATEST(0, COALESCE(SUM(CASE ledger."type"
    WHEN 'RESERVED' THEN ledger."credits" WHEN 'CONSUMED' THEN -ledger."credits"
    WHEN 'RELEASED' THEN -ledger."credits" WHEN 'EXPIRED' THEN -ledger."credits" ELSE 0 END), 0))::integer AS credits
  FROM "BillingAccount" account LEFT JOIN "CreditLedgerEntry" ledger
    ON ledger."userId" = account."userId" AND ledger."scope" = 'RESERVATION'
    AND ledger."billingPeriodStart" = account."serverCreditsPeriodStart"
  GROUP BY account."userId"
)
UPDATE "BillingAccount" account SET "serverCreditsBalance" = account."serverCreditsBalance" +
  GREATEST(0, LEAST(restorable.credits, account."monthlyServerCreditsLimit" - account."monthlyServerCreditsUsed" - outstanding.credits - account."serverCreditsBalance")),
  "updatedAt" = CURRENT_TIMESTAMP
FROM restorable JOIN outstanding USING ("userId") WHERE account."userId" = restorable."userId";
UPDATE "AnalysisJob" SET "status" = 'CANCELLED', "lockedAt" = NULL, "lockedUntil" = NULL,
  "scheduledFor" = NULL, "completedAt" = CURRENT_TIMESTAMP, "lastError" = 'EXTRACTION_V4_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM practice_v4_cancelled_jobs);
UPDATE "AnalysisRun" run SET "status" = 'CANCELLED', "completedAt" = CURRENT_TIMESTAMP,
  "consumedCredits" = COALESCE((SELECT GREATEST(0, SUM(CASE ledger."type" WHEN 'CONSUMED' THEN ledger."credits" WHEN 'REFUNDED' THEN -ledger."credits" ELSE 0 END))::integer
    FROM "CreditLedgerEntry" ledger WHERE ledger."analysisRunId" = run."id" AND ledger."scope" = 'RESERVATION'), 0),
  "lastError" = 'EXTRACTION_V4_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM practice_v4_cancelled_runs);
UPDATE "AnalysisBatchItem" SET "status" = 'CANCELLED', "planningToken" = NULL, "planningUntil" = NULL,
  "lastError" = 'EXTRACTION_V4_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('PENDING', 'PLANNING', 'QUEUED', 'ATTACHED')
  AND ("batchId" IN (SELECT "id" FROM practice_v4_cancelled_batches)
    OR "analysisJobId" IN (SELECT "id" FROM practice_v4_cancelled_jobs));
UPDATE "AnalysisBatch" batch SET "status" = 'CANCELLED', "pendingItems" = 0,
  "queuedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'QUEUED'),
  "attachedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'ATTACHED'),
  "skippedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'SKIPPED'),
  "failedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'FAILED'),
  "cancelledItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'CANCELLED'),
  "completedAt" = CURRENT_TIMESTAMP, "lastError" = 'EXTRACTION_V4_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM practice_v4_cancelled_batches);
DELETE FROM "AnalysisOutbox" WHERE "status" IN ('PENDING', 'LEASED')
  AND ("batchId" IN (SELECT "id" FROM practice_v4_cancelled_batches)
    OR "analysisJobId" IN (SELECT "id" FROM practice_v4_cancelled_jobs));
DELETE FROM "AnalysisRunCheckpoint" WHERE "runId" IN (SELECT "id" FROM practice_v4_cancelled_runs)
  OR "state"->>'version' IS DISTINCT FROM '2';

-- Stored game analysis is a derived current projection, not source history.
-- Removing the obsolete training graph must also remove its saved-position
-- counts/CTAs and analysis-valid flag. Keep original PGN and historical runs.
UPDATE "AnalyzedGame" game SET "analysis" = 'null'::jsonb,
  "whiteAccuracy" = NULL, "blackAccuracy" = NULL, "analyzedAt" = NULL,
  "currentAnalysisRunId" = NULL, "currentAnalysisValid" = FALSE,
  "updatedAt" = CURRENT_TIMESTAMP
WHERE (game."currentAnalysisRunId" IS NOT NULL OR game."currentAnalysisValid"
    OR game."analyzedAt" IS NOT NULL OR game."analysis" ? 'moves' OR game."analysis" ? 'trainingExtraction')
  AND (game."analysis"->'trainingExtraction'->>'version' IS DISTINCT FROM '2'
    OR NOT EXISTS (SELECT 1 FROM "AnalysisRun" run WHERE run."id" = game."currentAnalysisRunId"
      AND run."configSnapshot"->>'version' = '4'));

DELETE FROM "TrainingMoment";
DELETE FROM "PracticeDueSweep";
DELETE FROM "MasterPublication";
DELETE FROM "MasterCandidate";
DELETE FROM "MasterAnalysisReceipt";
-- These runs describe the removed derived graph. Reset their daily keys and
-- obsolete queued configurations so the current pipeline can rebuild at once.
-- Source snapshots remain intact through their ON DELETE SET NULL relation.
DELETE FROM "MasterPipelineRun";
-- Pending is now a durable played event, not an exclusive server-engine slot.
DROP INDEX "TrainingAttempt_one_pending_per_user_key";
ALTER TABLE "TrainingAttempt" DROP CONSTRAINT "TrainingAttempt_status_payload";
ALTER TABLE "TrainingAttemptStatusEvent" DROP CONSTRAINT "TrainingAttemptStatusEvent_payload";
ALTER TABLE "PracticeReviewEvent" DROP CONSTRAINT "PracticeReviewEvent_grade_payload";
-- CreateEnum
CREATE TYPE "AttemptTier" AS ENUM ('BEST', 'STRONG', 'GOOD', 'SUBPAR');

-- CreateEnum
CREATE TYPE "AttemptQuality" AS ENUM ('GOOD', 'BELOW_STANDARD', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AttemptOriginalRelation" AS ENUM ('SAME_MOVE', 'BETTER', 'EQUIVALENT', 'WORSE', 'UNKNOWN');




-- DropForeignKey
ALTER TABLE "SolutionMoveAssessment" DROP CONSTRAINT "SolutionMoveAssessment_solutionRevisionId_fkey";

-- DropIndex
DROP INDEX "TrainingAttemptAssessmentRevision_attemptId_clientEvidenceI_key";

-- AlterTable
ALTER TABLE "SolutionRevision" DROP COLUMN "acceptanceFrontier",
DROP COLUMN "acceptedMovesUci",
DROP COLUMN "answerCoverage",
DROP COLUMN "bestLine",
DROP COLUMN "bestMoveUci",
DROP COLUMN "continuation",
DROP COLUMN "continuationShape",
DROP COLUMN "decision",
DROP COLUMN "evidence",
DROP COLUMN "gradingPolicy",
DROP COLUMN "gradingStrategy",
DROP COLUMN "originalDecision",
DROP COLUMN "playedMoveScore",
DROP COLUMN "scoreAtStart",
DROP COLUMN "solutionShape",
DROP COLUMN "solutionTree",
DROP COLUMN "targetOutcome",
DROP COLUMN "verificationStatus",
ADD COLUMN     "manifest" JSONB NOT NULL,
ALTER COLUMN "trainable" SET DEFAULT false;

-- AlterTable
ALTER TABLE "TrainingAttempt" DROP COLUMN "bestGapCp",
DROP COLUMN "bestGapWinChance",
DROP COLUMN "grade",
DROP COLUMN "gradingEvidence",
DROP COLUMN "recoveredCp",
DROP COLUMN "recoveredWinChance",
ADD COLUMN     "originalRelation" "AttemptOriginalRelation" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "quality" "AttemptQuality" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "revealPayloadHash" TEXT,
ADD COLUMN     "revealedAt" TIMESTAMP(3),
ADD COLUMN     "tier" "AttemptTier";

-- AlterTable
ALTER TABLE "TrainingAttemptStep" DROP COLUMN "actor",
DROP COLUMN "evidence",
DROP COLUMN "grade",
ADD COLUMN     "contextId" TEXT NOT NULL,
ADD COLUMN     "initialAssessmentId" TEXT,
ADD COLUMN     "initialCoverageGroupId" TEXT,
ADD COLUMN     "initialResolution" "AttemptStatus" NOT NULL,
ADD COLUMN     "latestEventId" TEXT,
ADD COLUMN     "latestSequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "originalRelation" "AttemptOriginalRelation" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "payloadHash" TEXT NOT NULL,
ADD COLUMN     "playedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "quality" "AttemptQuality" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "resolution" "AttemptStatus" NOT NULL,
ADD COLUMN     "tier" "AttemptTier";

-- AlterTable
ALTER TABLE "TrainingAttemptAssessmentRevision" DROP COLUMN "clientEvidenceId",
DROP COLUMN "comparison",
DROP COLUMN "corrected",
DROP COLUMN "evidence",
DROP COLUMN "grade",
DROP COLUMN "gradingSource",
ADD COLUMN     "assessmentId" TEXT,
ADD COLUMN     "evaluatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "evaluation" JSONB,
ADD COLUMN     "eventId" TEXT NOT NULL,
ADD COLUMN     "originalRelation" "AttemptOriginalRelation" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "quality" "AttemptQuality" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "resolution" "AttemptStatus" NOT NULL,
ADD COLUMN     "sequence" INTEGER NOT NULL,
ADD COLUMN     "stepIndex" INTEGER NOT NULL,
ADD COLUMN     "supersedesEventId" TEXT,
ADD COLUMN     "tier" "AttemptTier";

-- AlterTable
ALTER TABLE "TrainingAttemptStatusEvent" DROP COLUMN "grade",
ADD COLUMN     "quality" "AttemptQuality" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "tier" "AttemptTier";

-- AlterTable
ALTER TABLE "PracticeReviewEvent" DROP COLUMN "grade",
ADD COLUMN     "quality" "AttemptQuality" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "tier" "AttemptTier";

-- AlterTable
ALTER TABLE "MasterCandidate" DROP COLUMN "acceptanceFrontier",
DROP COLUMN "acceptedMovesUci",
DROP COLUMN "bestLine",
DROP COLUMN "bestMoveUci",
DROP COLUMN "continuationShape",
DROP COLUMN "evidence",
DROP COLUMN "gradingPolicy",
DROP COLUMN "gradingStrategy",
DROP COLUMN "moveAssessments",
DROP COLUMN "playedMoveScore",
DROP COLUMN "scoreAtStart",
DROP COLUMN "solutionShape",
DROP COLUMN "solutionTree",
DROP COLUMN "targetOutcome",
DROP COLUMN "verificationStatus",
ADD COLUMN     "manifest" JSONB NOT NULL,
ADD COLUMN     "trainable" BOOLEAN NOT NULL DEFAULT false;

-- DropTable
DROP TABLE "SolutionMoveAssessment";

-- DropEnum
DROP TYPE "VerificationStatus";

-- DropEnum
DROP TYPE "SolutionShape";

-- DropEnum
DROP TYPE "GradingStrategy";

-- DropEnum
DROP TYPE "ContinuationShape";

-- DropEnum
DROP TYPE "AttemptGrade";

-- DropEnum
DROP TYPE "MoveAssessmentStatus";

-- DropEnum
DROP TYPE "AttemptStepActor";

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttemptAssessmentRevision_eventId_key" ON "TrainingAttemptAssessmentRevision"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttemptAssessmentRevision_attemptId_stepIndex_seque_key" ON "TrainingAttemptAssessmentRevision"("attemptId", "stepIndex", "sequence");

-- AddForeignKey
ALTER TABLE "TrainingAttemptAssessmentRevision" ADD CONSTRAINT "TrainingAttemptAssessmentRevision_attemptId_stepIndex_fkey" FOREIGN KEY ("attemptId", "stepIndex") REFERENCES "TrainingAttemptStep"("attemptId", "stepIndex") ON DELETE CASCADE ON UPDATE CASCADE;


-- AlterEnum
CREATE TYPE "AttemptStatus_new" AS ENUM ('PENDING', 'RESOLVED', 'REVEALED', 'UNAVAILABLE');
ALTER TABLE "TrainingAttempt" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "TrainingAttempt" ALTER COLUMN "status" TYPE "AttemptStatus_new" USING ("status"::text::"AttemptStatus_new");
ALTER TABLE "TrainingAttemptStep" ALTER COLUMN "initialResolution" TYPE "AttemptStatus_new" USING ("initialResolution"::text::"AttemptStatus_new");
ALTER TABLE "TrainingAttemptStep" ALTER COLUMN "resolution" TYPE "AttemptStatus_new" USING ("resolution"::text::"AttemptStatus_new");
ALTER TABLE "TrainingAttemptAssessmentRevision" ALTER COLUMN "resolution" TYPE "AttemptStatus_new" USING ("resolution"::text::"AttemptStatus_new");
ALTER TABLE "TrainingAttemptStatusEvent" ALTER COLUMN "status" TYPE "AttemptStatus_new" USING ("status"::text::"AttemptStatus_new");
ALTER TYPE "AttemptStatus" RENAME TO "AttemptStatus_old";
ALTER TYPE "AttemptStatus_new" RENAME TO "AttemptStatus";
DROP TYPE "AttemptStatus_old";
ALTER TABLE "TrainingAttempt" ALTER COLUMN "status" SET DEFAULT 'PENDING';
-- AlterEnum
CREATE TYPE "MoveAssessmentSource_new" AS ENUM ('SERVER_ENGINE', 'CLIENT_ENGINE', 'RULE', 'TABLEBASE');
ALTER TABLE "TrainingAttempt" ALTER COLUMN "gradingSource" TYPE "MoveAssessmentSource_new" USING ("gradingSource"::text::"MoveAssessmentSource_new");
ALTER TYPE "MoveAssessmentSource" RENAME TO "MoveAssessmentSource_old";
ALTER TYPE "MoveAssessmentSource_new" RENAME TO "MoveAssessmentSource";
DROP TYPE "MoveAssessmentSource_old";
-- AlterEnum
CREATE TYPE "TrainingAttemptStatusEventReason_new" AS ENUM ('SUBMITTED', 'RESOLVED', 'REVEALED', 'UNAVAILABLE', 'CORRECTED');
ALTER TABLE "TrainingAttemptStatusEvent" ALTER COLUMN "reason" TYPE "TrainingAttemptStatusEventReason_new" USING ("reason"::text::"TrainingAttemptStatusEventReason_new");
ALTER TYPE "TrainingAttemptStatusEventReason" RENAME TO "TrainingAttemptStatusEventReason_old";
ALTER TYPE "TrainingAttemptStatusEventReason_new" RENAME TO "TrainingAttemptStatusEventReason";
DROP TYPE "TrainingAttemptStatusEventReason_old";

ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_status_payload" CHECK (
  ("status" = 'PENDING' AND "quality" = 'UNKNOWN' AND "tier" IS NULL AND "completedAt" IS NULL) OR
  ("status" = 'RESOLVED' AND "quality" <> 'UNKNOWN' AND "userMoveUci" IS NOT NULL AND "completedAt" IS NOT NULL) OR
  ("status" IN ('REVEALED','UNAVAILABLE') AND "quality" = 'UNKNOWN' AND "tier" IS NULL AND "completedAt" IS NOT NULL)
);
ALTER TABLE "TrainingAttemptStep" ADD CONSTRAINT "TrainingAttemptStep_resolution_payload" CHECK (
  "initialResolution" IN ('PENDING','RESOLVED','UNAVAILABLE') AND
  (("initialResolution" = 'RESOLVED' AND num_nonnulls("initialAssessmentId", "initialCoverageGroupId") = 1) OR
   ("initialResolution" <> 'RESOLVED' AND "initialAssessmentId" IS NULL AND "initialCoverageGroupId" IS NULL)) AND
  (("resolution" = 'RESOLVED' AND "quality" <> 'UNKNOWN') OR ("resolution" IN ('PENDING','UNAVAILABLE') AND "quality" = 'UNKNOWN' AND "tier" IS NULL)) AND
  "latestSequence" >= 0 AND (("latestSequence" = 0) = ("latestEventId" IS NULL))
);
ALTER TABLE "TrainingAttemptAssessmentRevision" ADD CONSTRAINT "TrainingAttemptAssessmentRevision_payload" CHECK (
  "stepIndex" >= 0 AND "sequence" > 0 AND (("sequence" = 1) = ("supersedesEventId" IS NULL)) AND
  "eventId" IS DISTINCT FROM "supersedesEventId" AND
  (("resolution" = 'RESOLVED' AND "quality" <> 'UNKNOWN' AND "assessmentId" IS NOT NULL AND "evaluation" IS NOT NULL) OR
   ("resolution" = 'UNAVAILABLE' AND "quality" = 'UNKNOWN' AND "tier" IS NULL AND "assessmentId" IS NULL AND "evaluation" IS NULL))
);
ALTER TABLE "TrainingAttemptStatusEvent" ADD CONSTRAINT "TrainingAttemptStatusEvent_payload" CHECK (
  ("status" = 'RESOLVED' AND "quality" <> 'UNKNOWN') OR ("status" <> 'RESOLVED' AND "quality" = 'UNKNOWN' AND "tier" IS NULL)
);
ALTER TABLE "PracticeReviewEvent" ADD CONSTRAINT "PracticeReviewEvent_quality_payload" CHECK (
  ("outcome" = 'SUCCESS' AND "quality" = 'GOOD') OR ("outcome" = 'LAPSE' AND "quality" = 'BELOW_STANDARD')
);
COMMIT;
