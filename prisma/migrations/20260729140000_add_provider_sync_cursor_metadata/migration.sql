ALTER TABLE "ProviderSyncState"
    ADD COLUMN "providerUsernameNormalized" TEXT,
    ADD COLUMN "cursorSincePlayedAt" TIMESTAMP(3),
    ADD COLUMN "cursorUntilPlayedAt" TIMESTAMP(3),
    ADD COLUMN "cursorWindowEnd" TIMESTAMP(3);
