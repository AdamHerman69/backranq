DROP INDEX "ProviderSyncState_provider_enabled_idx";

ALTER TABLE "ProviderSyncState"
DROP COLUMN "enabled",
ADD COLUMN "importPolicyHash" TEXT;
