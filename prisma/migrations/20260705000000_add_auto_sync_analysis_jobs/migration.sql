CREATE TYPE "AnalysisJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "ProviderSyncState" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedPlayedAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "etag" TEXT,
    "lastModified" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderSyncState_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AnalysisJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "status" "AnalysisJobStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "queuedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderSyncState_userId_provider_key" ON "ProviderSyncState"("userId", "provider");
CREATE INDEX "ProviderSyncState_provider_enabled_idx" ON "ProviderSyncState"("provider", "enabled");
CREATE INDEX "ProviderSyncState_lastAttemptAt_idx" ON "ProviderSyncState"("lastAttemptAt");

CREATE UNIQUE INDEX "AnalysisJob_gameId_key" ON "AnalysisJob"("gameId");
CREATE INDEX "AnalysisJob_userId_status_idx" ON "AnalysisJob"("userId", "status");
CREATE INDEX "AnalysisJob_status_priority_createdAt_idx" ON "AnalysisJob"("status", "priority", "createdAt");
CREATE INDEX "AnalysisJob_lockedAt_idx" ON "AnalysisJob"("lockedAt");

ALTER TABLE "ProviderSyncState"
    ADD CONSTRAINT "ProviderSyncState_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalysisJob"
    ADD CONSTRAINT "AnalysisJob_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AnalysisJob"
    ADD CONSTRAINT "AnalysisJob_gameId_fkey"
    FOREIGN KEY ("gameId") REFERENCES "AnalyzedGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;
