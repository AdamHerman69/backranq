-- CreateEnum
CREATE TYPE "AnalysisExecutionMode" AS ENUM ('LOCAL_BROWSER', 'SERVER_QUEUE', 'EXTERNAL_WORKER');

-- CreateEnum
CREATE TYPE "AnalysisRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "AnalyzedGame" ADD COLUMN "currentAnalysisRunId" UUID;

-- AlterTable
ALTER TABLE "AnalysisJob" ADD COLUMN "analysisRunId" UUID;

-- AlterTable
ALTER TABLE "Puzzle" ADD COLUMN "analysisConfigHash" TEXT,
ADD COLUMN "analysisRunId" UUID;

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "executionMode" "AnalysisExecutionMode" NOT NULL,
    "status" "AnalysisRunStatus" NOT NULL DEFAULT 'QUEUED',
    "queuedReason" TEXT,
    "engineName" TEXT,
    "engineVersion" TEXT,
    "engineSource" TEXT,
    "appVersion" TEXT,
    "configSnapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "configHash" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "consumedCredits" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisRun_userId_status_idx" ON "AnalysisRun"("userId", "status");

-- CreateIndex
CREATE INDEX "AnalysisRun_gameId_createdAt_idx" ON "AnalysisRun"("gameId", "createdAt");

-- CreateIndex
CREATE INDEX "AnalysisRun_executionMode_status_idx" ON "AnalysisRun"("executionMode", "status");

-- CreateIndex
CREATE INDEX "AnalysisRun_configHash_idx" ON "AnalysisRun"("configHash");

-- CreateIndex
CREATE INDEX "AnalyzedGame_currentAnalysisRunId_idx" ON "AnalyzedGame"("currentAnalysisRunId");

-- CreateIndex
CREATE INDEX "AnalysisJob_analysisRunId_idx" ON "AnalysisJob"("analysisRunId");

-- CreateIndex
CREATE INDEX "Puzzle_analysisRunId_idx" ON "Puzzle"("analysisRunId");

-- CreateIndex
CREATE INDEX "Puzzle_analysisConfigHash_idx" ON "Puzzle"("analysisConfigHash");

-- AddForeignKey
ALTER TABLE "AnalyzedGame" ADD CONSTRAINT "AnalyzedGame_currentAnalysisRunId_fkey" FOREIGN KEY ("currentAnalysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyzedGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Puzzle" ADD CONSTRAINT "Puzzle_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
