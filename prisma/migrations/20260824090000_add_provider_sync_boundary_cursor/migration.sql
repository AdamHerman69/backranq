ALTER TABLE "ProviderSyncState"
ADD COLUMN "cursorBoundaryIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
