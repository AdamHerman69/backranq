ALTER TABLE "HistoryImportQuota"
    ADD COLUMN "fetchLeaseToken" TEXT,
    ADD COLUMN "fetchLeaseUntil" TIMESTAMP(3);
