CREATE TABLE "HistoryImportQuota" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "usernameNormalized" TEXT NOT NULL,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoryImportQuota_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoryImportQuota_userId_provider_usernameNormalized_key"
ON "HistoryImportQuota"("userId", "provider", "usernameNormalized");

CREATE INDEX "HistoryImportQuota_userId_provider_idx"
ON "HistoryImportQuota"("userId", "provider");

ALTER TABLE "HistoryImportQuota"
ADD CONSTRAINT "HistoryImportQuota_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "HistoryImportQuota"
ADD CONSTRAINT "HistoryImportQuota_createdCount_check"
CHECK ("createdCount" BETWEEN 0 AND 2000);
