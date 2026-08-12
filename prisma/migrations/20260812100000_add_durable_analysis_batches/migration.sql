CREATE TYPE "AnalysisBatchStatus" AS ENUM ('PENDING', 'PLANNING', 'QUEUED', 'PARTIAL', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "AnalysisBatchItemStatus" AS ENUM ('PENDING', 'PLANNING', 'QUEUED', 'ATTACHED', 'SKIPPED', 'FAILED', 'CANCELLED');
CREATE TYPE "AnalysisOutboxKind" AS ENUM ('ANALYSIS_BATCH_PLAN', 'ANALYSIS_JOB');
CREATE TYPE "AnalysisOutboxStatus" AS ENUM ('PENDING', 'LEASED', 'PUBLISHED', 'FAILED');

CREATE TABLE "AnalysisBatch" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "status" "AnalysisBatchStatus" NOT NULL DEFAULT 'PENDING',
    "payloadHash" TEXT NOT NULL,
    "force" BOOLEAN NOT NULL DEFAULT false,
    "queuedReason" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "analysisQuality" "AnalysisQuality" NOT NULL,
    "creditCost" INTEGER NOT NULL,
    "totalItems" INTEGER NOT NULL,
    "pendingItems" INTEGER NOT NULL,
    "queuedItems" INTEGER NOT NULL DEFAULT 0,
    "attachedItems" INTEGER NOT NULL DEFAULT 0,
    "skippedItems" INTEGER NOT NULL DEFAULT 0,
    "failedItems" INTEGER NOT NULL DEFAULT 0,
    "cancelledItems" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisBatch_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnalysisBatch_counts_nonnegative" CHECK (
        "totalItems" >= 0 AND "pendingItems" >= 0 AND "queuedItems" >= 0 AND
        "attachedItems" >= 0 AND "skippedItems" >= 0 AND "failedItems" >= 0 AND
        "cancelledItems" >= 0 AND "creditCost" > 0
    )
);

CREATE TABLE "AnalysisBatchItem" (
    "id" UUID NOT NULL,
    "batchId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "analysisJobId" UUID,
    "analysisRunId" UUID,
    "status" "AnalysisBatchItemStatus" NOT NULL DEFAULT 'PENDING',
    "planningToken" UUID,
    "planningUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisBatchItem_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalysisOutbox" (
    "id" UUID NOT NULL,
    "batchId" UUID,
    "analysisJobId" UUID,
    "kind" "AnalysisOutboxKind" NOT NULL,
    "status" "AnalysisOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" UUID,
    "lockedUntil" TIMESTAMP(3),
    "messageId" TEXT,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisOutbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AnalysisOutbox_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE TABLE "AnalysisRunCheckpoint" (
    "runId" UUID NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'EXTRACTING',
    "cursor" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "state" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisRunCheckpoint_pkey" PRIMARY KEY ("runId"),
    CONSTRAINT "AnalysisRunCheckpoint_version_nonnegative" CHECK ("version" >= 0)
);

CREATE TABLE "AnalysisMaintenanceLease" (
    "key" TEXT NOT NULL,
    "leaseToken" UUID NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnalysisMaintenanceLease_pkey" PRIMARY KEY ("key")
);

CREATE UNIQUE INDEX "AnalysisBatch_userId_requestId_key" ON "AnalysisBatch"("userId", "requestId");
CREATE UNIQUE INDEX "AnalysisBatch_id_userId_key" ON "AnalysisBatch"("id", "userId");
CREATE INDEX "AnalysisBatch_userId_createdAt_idx" ON "AnalysisBatch"("userId", "createdAt");
CREATE INDEX "AnalysisBatch_status_updatedAt_idx" ON "AnalysisBatch"("status", "updatedAt");
CREATE UNIQUE INDEX "AnalysisBatchItem_batchId_gameId_key" ON "AnalysisBatchItem"("batchId", "gameId");
CREATE INDEX "AnalysisBatchItem_batchId_status_createdAt_idx" ON "AnalysisBatchItem"("batchId", "status", "createdAt");
CREATE INDEX "AnalysisBatchItem_planningUntil_idx" ON "AnalysisBatchItem"("planningUntil");
CREATE INDEX "AnalysisBatchItem_analysisJobId_idx" ON "AnalysisBatchItem"("analysisJobId");
CREATE INDEX "AnalysisBatchItem_analysisRunId_idx" ON "AnalysisBatchItem"("analysisRunId");
CREATE INDEX "AnalysisBatchItem_gameId_userId_idx" ON "AnalysisBatchItem"("gameId", "userId");
CREATE UNIQUE INDEX "AnalysisOutbox_idempotencyKey_key" ON "AnalysisOutbox"("idempotencyKey");
CREATE INDEX "AnalysisOutbox_status_availableAt_idx" ON "AnalysisOutbox"("status", "availableAt");
CREATE INDEX "AnalysisOutbox_lockedUntil_idx" ON "AnalysisOutbox"("lockedUntil");
CREATE INDEX "AnalysisOutbox_batchId_idx" ON "AnalysisOutbox"("batchId");
CREATE INDEX "AnalysisOutbox_analysisJobId_idx" ON "AnalysisOutbox"("analysisJobId");
CREATE INDEX "AnalysisMaintenanceLease_lockedUntil_idx" ON "AnalysisMaintenanceLease"("lockedUntil");

ALTER TABLE "AnalysisBatch" ADD CONSTRAINT "AnalysisBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisBatchItem" ADD CONSTRAINT "AnalysisBatchItem_batchId_userId_fkey" FOREIGN KEY ("batchId", "userId") REFERENCES "AnalysisBatch"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisBatchItem" ADD CONSTRAINT "AnalysisBatchItem_gameId_userId_fkey" FOREIGN KEY ("gameId", "userId") REFERENCES "AnalyzedGame"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisBatchItem" ADD CONSTRAINT "AnalysisBatchItem_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "AnalysisJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalysisBatchItem" ADD CONSTRAINT "AnalysisBatchItem_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AnalysisOutbox" ADD CONSTRAINT "AnalysisOutbox_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "AnalysisBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisOutbox" ADD CONSTRAINT "AnalysisOutbox_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "AnalysisJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisRunCheckpoint" ADD CONSTRAINT "AnalysisRunCheckpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "enforce_analysis_checkpoint_monotonic_version"() RETURNS trigger AS $$
BEGIN
    IF NEW."version" < OLD."version" THEN
        RAISE EXCEPTION 'AnalysisRunCheckpoint version cannot decrease';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AnalysisRunCheckpoint_monotonic_version"
BEFORE UPDATE OF "version" ON "AnalysisRunCheckpoint"
FOR EACH ROW EXECUTE FUNCTION "enforce_analysis_checkpoint_monotonic_version"();
