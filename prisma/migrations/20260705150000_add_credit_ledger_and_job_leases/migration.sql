-- CreateEnum
CREATE TYPE "CreditLedgerEntryType" AS ENUM ('RESERVED', 'CONSUMED', 'REFUNDED', 'RELEASED', 'EXPIRED');

-- AlterTable
ALTER TABLE "AnalysisJob"
ADD COLUMN "scheduledFor" TIMESTAMP(3),
ADD COLUMN "lockedUntil" TIMESTAMP(3),
ADD COLUMN "lastDispatchedAt" TIMESTAMP(3),
ADD COLUMN "dispatchedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "weight" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "estimatedCredits" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "CreditLedgerEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "userId" UUID NOT NULL,
    "analysisJobId" UUID,
    "analysisRunId" UUID,
    "gameId" UUID,
    "type" "CreditLedgerEntryType" NOT NULL,
    "credits" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreditLedgerEntry_credits_positive_check" CHECK ("credits" > 0)
);

-- CreateIndex
CREATE INDEX "AnalysisJob_status_scheduledFor_priority_createdAt_idx" ON "AnalysisJob"("status", "scheduledFor", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisJob_lockedUntil_idx" ON "AnalysisJob"("lockedUntil");

-- CreateIndex
CREATE INDEX "AnalysisJob_lastDispatchedAt_idx" ON "AnalysisJob"("lastDispatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CreditLedgerEntry_idempotencyKey_key" ON "CreditLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_userId_createdAt_idx" ON "CreditLedgerEntry"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_userId_type_createdAt_idx" ON "CreditLedgerEntry"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_analysisJobId_idx" ON "CreditLedgerEntry"("analysisJobId");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_analysisRunId_idx" ON "CreditLedgerEntry"("analysisRunId");

-- CreateIndex
CREATE INDEX "CreditLedgerEntry_gameId_idx" ON "CreditLedgerEntry"("gameId");

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_analysisJobId_fkey" FOREIGN KEY ("analysisJobId") REFERENCES "AnalysisJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyzedGame"("id") ON DELETE SET NULL ON UPDATE CASCADE;
