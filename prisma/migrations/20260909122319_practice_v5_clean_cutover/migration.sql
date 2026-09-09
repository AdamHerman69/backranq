-- Clean pre-user replacement. Preserve games, accounts, source snapshots and unrelated state.
BEGIN;
-- Fence worker/billing mutations while selecting and settling the old generation.
LOCK TABLE "AnalysisRun", "AnalysisJob", "AnalysisBatch", "AnalysisBatchItem",
  "AnalysisOutbox", "CreditLedgerEntry", "BillingAccount" IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE practice_v5_obsolete_runs ON COMMIT DROP AS
SELECT "id" FROM "AnalysisRun" WHERE COALESCE("configSnapshot" #>> '{extraction,extractor,selectionPolicyId}', "configSnapshot" #>> '{extractor,selectionPolicyId}', '') NOT IN ('practice-selection-t2-v1', 'practice-selection-corroborated-v1');
-- Old extraction configurations/checkpoints cannot be resumed under v5. Keep
-- historical runs and ledger entries, but stop their incompatible active work.
CREATE TEMP TABLE practice_v5_cancelled_runs ON COMMIT DROP AS
SELECT "id" FROM "AnalysisRun"
WHERE "status" IN ('QUEUED', 'RUNNING')
  AND COALESCE("configSnapshot" #>> '{extraction,extractor,selectionPolicyId}', "configSnapshot" #>> '{extractor,selectionPolicyId}', '') NOT IN ('practice-selection-t2-v1', 'practice-selection-corroborated-v1');
CREATE TEMP TABLE practice_v5_cancelled_jobs ON COMMIT DROP AS
SELECT "id" FROM "AnalysisJob"
WHERE "status" IN ('QUEUED', 'RUNNING')
  AND "analysisRunId" IN (SELECT "id" FROM practice_v5_cancelled_runs);
CREATE TEMP TABLE practice_v5_cancelled_batches ON COMMIT DROP AS
SELECT "id" FROM "AnalysisBatch"
WHERE "status" IN ('PENDING', 'PLANNING', 'QUEUED', 'PARTIAL')
  AND COALESCE("configSnapshot" #>> '{extraction,extractor,selectionPolicyId}', "configSnapshot" #>> '{extractor,selectionPolicyId}', '') NOT IN ('practice-selection-t2-v1', 'practice-selection-corroborated-v1');

-- Reservation settlement is period-specific. Already consumed/expired/released
-- credits are never returned a second time; old-period releases do not replenish
-- the current allowance. This uses the same cap as billingAccounts.ts.
CREATE TEMP TABLE practice_v5_releases ON COMMIT DROP AS
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
WHERE run."id" IN (SELECT "id" FROM practice_v5_cancelled_runs)
GROUP BY ledger."userId", ledger."settlementRunId", run."gameId", ledger."billingPeriodStart";
INSERT INTO "CreditLedgerEntry" ("userId", "analysisJobId", "analysisRunId", "gameId", "type", "scope", "billingPeriodStart", "credits", "idempotencyKey", "reason")
SELECT "userId", "analysisJobId", "analysisRunId", "gameId", 'RELEASED', 'RESERVATION', "billingPeriodStart", credits,
  'practice-v5-reset:' || md5(concat_ws(':', "userId", "analysisJobId", "analysisRunId", "gameId", "billingPeriodStart")), 'PRACTICE_V5_RESET'
FROM practice_v5_releases WHERE credits > 0;
WITH restorable AS (
  SELECT account."userId", SUM(release.credits)::integer AS credits
  FROM "BillingAccount" account JOIN practice_v5_releases release
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
  "scheduledFor" = NULL, "completedAt" = CURRENT_TIMESTAMP, "lastError" = 'PRACTICE_V5_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM practice_v5_cancelled_jobs);
UPDATE "AnalysisRun" run SET "status" = 'CANCELLED', "completedAt" = CURRENT_TIMESTAMP,
  "consumedCredits" = COALESCE((SELECT GREATEST(0, SUM(CASE ledger."type" WHEN 'CONSUMED' THEN ledger."credits" WHEN 'REFUNDED' THEN -ledger."credits" ELSE 0 END))::integer
    FROM "CreditLedgerEntry" ledger LEFT JOIN "AnalysisJob" job ON job."id" = ledger."analysisJobId"
    WHERE COALESCE(ledger."analysisRunId", job."analysisRunId") = run."id" AND ledger."scope" = 'RESERVATION'), 0),
  "lastError" = 'PRACTICE_V5_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM practice_v5_cancelled_runs);
UPDATE "AnalysisBatchItem" SET "status" = 'CANCELLED', "planningToken" = NULL, "planningUntil" = NULL,
  "lastError" = 'PRACTICE_V5_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "status" IN ('PENDING', 'PLANNING', 'QUEUED', 'ATTACHED')
  AND ("batchId" IN (SELECT "id" FROM practice_v5_cancelled_batches)
    OR "analysisJobId" IN (SELECT "id" FROM practice_v5_cancelled_jobs));
UPDATE "AnalysisBatch" batch SET "status" = 'CANCELLED', "pendingItems" = 0,
  "queuedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'QUEUED'),
  "attachedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'ATTACHED'),
  "skippedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'SKIPPED'),
  "failedItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'FAILED'),
  "cancelledItems" = (SELECT COUNT(*) FROM "AnalysisBatchItem" WHERE "batchId" = batch."id" AND "status" = 'CANCELLED'),
  "completedAt" = CURRENT_TIMESTAMP, "lastError" = 'PRACTICE_V5_RESET', "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" IN (SELECT "id" FROM practice_v5_cancelled_batches);
DELETE FROM "AnalysisOutbox" WHERE "status" IN ('PENDING', 'LEASED')
  AND ("batchId" IN (SELECT "id" FROM practice_v5_cancelled_batches)
    OR "analysisJobId" IN (SELECT "id" FROM practice_v5_cancelled_jobs));
DELETE FROM "AnalysisRunCheckpoint" WHERE "runId" IN (SELECT "id" FROM practice_v5_obsolete_runs);

-- Invalidate only old current projections; source PGN and historical billing stay.
UPDATE "AnalyzedGame" game SET "analysis" = 'null'::jsonb,
  "whiteAccuracy" = NULL, "blackAccuracy" = NULL, "analyzedAt" = NULL,
  "currentAnalysisRunId" = NULL, "currentAnalysisValid" = FALSE, "updatedAt" = CURRENT_TIMESTAMP
WHERE game."currentAnalysisRunId" IN (SELECT "id" FROM practice_v5_obsolete_runs)
  OR (game."currentAnalysisRunId" IS NULL AND (game."currentAnalysisValid" OR game."analyzedAt" IS NOT NULL
    OR game."analysis" ? 'moves' OR game."analysis" ? 'trainingExtraction'));

-- Remove incompatible Practice graphs, including attempts/projections through FK cascades.
DELETE FROM "TrainingMoment" moment WHERE NOT EXISTS (
  SELECT 1 FROM "SolutionRevision" revision WHERE revision."id" = moment."currentSolutionRevisionId"
    AND revision."manifest"->>'contractVersion' = '5');
DELETE FROM "PracticeReviewState" state USING "SolutionRevision" revision
WHERE revision."momentId" = state."trainingMomentId" AND revision."solutionHash" = state."solutionHash"
  AND revision."manifest"->>'contractVersion' IS DISTINCT FROM '5';
DELETE FROM "SolutionRevision" WHERE "manifest"->>'contractVersion' IS DISTINCT FROM '5';
DELETE FROM "PracticeDueSweep";

CREATE TEMP TABLE practice_v5_obsolete_master_runs ON COMMIT DROP AS
SELECT "id" FROM "MasterPipelineRun"
WHERE COALESCE("configSnapshot" #>> '{analysis,snapshot,extraction,extractor,selectionPolicyId}', '')
  NOT IN ('practice-selection-t2-v1', 'practice-selection-corroborated-v1');
CREATE TEMP TABLE practice_v5_obsolete_publications ON COMMIT DROP AS
SELECT publication."id" FROM "MasterPublication" publication JOIN "MasterCandidate" candidate ON candidate."id" = publication."candidateId"
WHERE publication."promptPayload" #>> '{grading,contractVersion}' IS DISTINCT FROM '5'
  OR candidate."manifest"->>'contractVersion' IS DISTINCT FROM '5';
UPDATE "MasterSlot" SET "version" = "version" + 1, "resolvedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
WHERE "currentPublicationId" IN (SELECT "id" FROM practice_v5_obsolete_publications)
  OR "fallbackPublicationId" IN (SELECT "id" FROM practice_v5_obsolete_publications);
DELETE FROM "MasterPublication" WHERE "id" IN (SELECT "id" FROM practice_v5_obsolete_publications);
DELETE FROM "MasterCandidate" WHERE "manifest"->>'contractVersion' IS DISTINCT FROM '5';
DELETE FROM "MasterAnalysisReceipt" WHERE "pipelineRunId" IN (SELECT "id" FROM practice_v5_obsolete_master_runs);
-- Reset old daily keys/leases. Source snapshots have ON DELETE SET NULL and remain.
DELETE FROM "MasterPipelineRun" run WHERE run."id" IN (SELECT "id" FROM practice_v5_obsolete_master_runs)
  AND NOT EXISTS (SELECT 1 FROM "MasterCandidate" candidate WHERE candidate."pipelineRunId" = run."id");
COMMIT;
