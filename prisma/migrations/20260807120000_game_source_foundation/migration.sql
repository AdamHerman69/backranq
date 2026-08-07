CREATE TYPE "GameSource" AS ENUM ('LICHESS', 'CHESSCOM', 'MANUAL_PGN', 'BACKRANQ_COACH');
CREATE TYPE "SyncProvider" AS ENUM ('LICHESS', 'CHESSCOM');
CREATE TYPE "ConnectionOrigin" AS ENUM ('OAUTH_ACCOUNT', 'PUBLIC_PROFILE');

-- Game evidence and synchronization are intentionally separate domains.
ALTER TABLE "AnalyzedGame"
    ALTER COLUMN "provider" TYPE "GameSource" USING ("provider"::text::"GameSource");
ALTER TABLE "TrainingAttempt"
    ALTER COLUMN "contextProvider" TYPE "GameSource" USING ("contextProvider"::text::"GameSource");
ALTER TABLE "ProgressAnalyticsEvent"
    ALTER COLUMN "provider" TYPE "GameSource" USING ("provider"::text::"GameSource");

ALTER TABLE "ProviderSyncState"
    ALTER COLUMN "provider" TYPE "SyncProvider" USING ("provider"::text::"SyncProvider");
ALTER TABLE "HistoryImportQuota"
    ALTER COLUMN "provider" TYPE "SyncProvider" USING ("provider"::text::"SyncProvider");
ALTER TABLE "SyncJob"
    ALTER COLUMN "provider" TYPE "SyncProvider" USING ("provider"::text::"SyncProvider");
ALTER TABLE "OnboardingAnalyticsEvent"
    ALTER COLUMN "provider" TYPE "SyncProvider" USING ("provider"::text::"SyncProvider");
ALTER TABLE "MasterAccount"
    ALTER COLUMN "provider" TYPE "SyncProvider" USING ("provider"::text::"SyncProvider");
ALTER TABLE "MasterSourceGame"
    ALTER COLUMN "provider" TYPE "SyncProvider" USING ("provider"::text::"SyncProvider");

CREATE TABLE "ChessAccountConnection" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "SyncProvider" NOT NULL,
    "providerAccountId" TEXT,
    "username" TEXT NOT NULL,
    "usernameNormalized" TEXT NOT NULL,
    "origin" "ConnectionOrigin" NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChessAccountConnection_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChessAccountConnection_username_nonempty" CHECK (
        char_length(btrim("username")) BETWEEN 1 AND 64 AND
        char_length("usernameNormalized") BETWEEN 1 AND 64 AND
        "usernameNormalized" = lower(btrim("username"))
    ),
    CONSTRAINT "ChessAccountConnection_origin_shape" CHECK (
        "origin" <> 'OAUTH_ACCOUNT' OR "providerAccountId" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "ChessAccountConnection_userId_provider_key"
    ON "ChessAccountConnection"("userId", "provider");
CREATE INDEX "ChessAccountConnection_provider_usernameNormalized_idx"
    ON "ChessAccountConnection"("provider", "usernameNormalized");

ALTER TABLE "ChessAccountConnection"
    ADD CONSTRAINT "ChessAccountConnection_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backranq is pre-user: rows without a verifiable frozen perspective are
-- deliberately removed instead of carrying an ambiguous compatibility state.
DELETE FROM "AnalyzedGame"
WHERE "sourceUsername" IS NULL
   OR "userSide" = 'UNKNOWN'
   OR ("userSide" = 'WHITE' AND lower(btrim("sourceUsername")) <> lower(btrim("whiteName")))
   OR ("userSide" = 'BLACK' AND lower(btrim("sourceUsername")) <> lower(btrim("blackName")));

ALTER TABLE "AnalyzedGame"
    ALTER COLUMN "sourceUsername" SET NOT NULL,
    ALTER COLUMN "userSide" DROP DEFAULT,
    ADD CONSTRAINT "AnalyzedGame_frozen_perspective_check" CHECK (
        ("userSide" = 'WHITE' AND lower(btrim("sourceUsername")) = lower(btrim("whiteName"))) OR
        ("userSide" = 'BLACK' AND lower(btrim("sourceUsername")) = lower(btrim("blackName")))
    );

CREATE FUNCTION public.prevent_analyzed_game_provenance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF OLD."provider" IS DISTINCT FROM NEW."provider"
       OR OLD."externalId" IS DISTINCT FROM NEW."externalId"
       OR OLD."sourceUsername" IS DISTINCT FROM NEW."sourceUsername"
       OR OLD."sourceAccountId" IS DISTINCT FROM NEW."sourceAccountId"
       OR OLD."userSide" IS DISTINCT FROM NEW."userSide"
       OR (
           OLD."provider" = 'BACKRANQ_COACH' AND
           OLD."pgn" IS DISTINCT FROM NEW."pgn"
       ) THEN
        RAISE EXCEPTION 'AnalyzedGame source provenance is immutable';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AnalyzedGame_prevent_provenance_mutation"
BEFORE UPDATE ON "AnalyzedGame"
FOR EACH ROW EXECUTE FUNCTION public.prevent_analyzed_game_provenance_mutation();

ALTER TABLE public."ChessAccountConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ChessAccountConnection" FORCE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public."ChessAccountConnection" FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.prevent_analyzed_game_provenance_mutation() FROM PUBLIC, anon, authenticated;

ALTER TABLE "User"
    DROP COLUMN "lichessUsername",
    DROP COLUMN "chesscomUsername";

DROP TYPE "Provider";
