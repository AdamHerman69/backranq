-- Progress foundations: immutable import/attempt context, append-only Practice
-- evidence, review scheduling, and a deliberately bounded analytics vocabulary.
-- This is an additive pre-launch migration; there are no legacy user rows to
-- fabricate provenance for.

-- pgcrypto provides the same SHA-256 primitive used by hashSourcePgn. Supabase
-- conventionally keeps extensions out of public; both schemas are searched so
-- this also works if pgcrypto was installed in public by a local environment.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
SET search_path = public, extensions;

CREATE TYPE "GameUserSide" AS ENUM ('WHITE', 'BLACK', 'UNKNOWN');
CREATE TYPE "PracticeFocus" AS ENUM ('ALL', 'MEANINGFUL', 'MAJOR');
CREATE TYPE "PracticeEntrySurface" AS ENUM ('PRACTICE', 'HOME', 'GAMES', 'PROGRESS');
CREATE TYPE "PracticeExposureEventKind" AS ENUM ('SHOWN', 'TERMINAL');
CREATE TYPE "PracticeExposureTerminalReason" AS ENUM ('MOVE_SUBMITTED', 'REVEALED', 'ABANDONED', 'REPLACED', 'NAVIGATED_AWAY');
CREATE TYPE "TrainingAttemptStatusEventReason" AS ENUM ('SUBMITTED', 'RETRY', 'GRADED', 'REVEALED', 'ENGINE_UNAVAILABLE', 'UNSTABLE_EVIDENCE', 'MISSING_OUTCOME_EVIDENCE', 'STALE_PENDING');
CREATE TYPE "PracticeReviewOutcome" AS ENUM ('SUCCESS', 'LAPSE', 'REVEAL', 'UNRESOLVED');
CREATE TYPE "ProgressAnalyticsEventName" AS ENUM ('PROGRESS_VIEWED', 'INSIGHT_EXPANDED', 'ACTION_CLICKED', 'PRACTICE_STARTED_FROM_PROGRESS');

ALTER TABLE "AnalyzedGame"
ADD COLUMN "sourcePgnHash" TEXT,
ADD COLUMN "sourceUsername" TEXT,
ADD COLUMN "sourceAccountId" TEXT,
ADD COLUMN "userSide" "GameUserSide" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "timeControlRaw" TEXT,
ADD COLUMN "timeControlInitialSeconds" INTEGER,
ADD COLUMN "timeControlIncrementSeconds" INTEGER,
ADD COLUMN "currentAnalysisValid" BOOLEAN NOT NULL DEFAULT FALSE,
ADD CONSTRAINT "AnalyzedGame_time_control_nonnegative" CHECK (
    ("timeControlInitialSeconds" IS NULL OR "timeControlInitialSeconds" >= 0) AND
    ("timeControlIncrementSeconds" IS NULL OR "timeControlIncrementSeconds" >= 0)
);

ALTER TABLE "TrainingAttempt"
ADD COLUMN "contextPhase" "GamePhase",
ADD COLUMN "contextCpLoss" DOUBLE PRECISION,
ADD COLUMN "contextWinChanceLoss" DOUBLE PRECISION,
ADD COLUMN "contextSourceKinds" "TrainingSourceKind"[] NOT NULL DEFAULT ARRAY[]::"TrainingSourceKind"[],
ADD COLUMN "contextLessonKinds" "TrainingLessonKind"[] NOT NULL DEFAULT ARRAY[]::"TrainingLessonKind"[],
ADD COLUMN "contextThemes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "contextThemeTaxonomyVersion" TEXT NOT NULL DEFAULT 'backranq-theme-v1',
ADD COLUMN "contextProvider" "Provider",
ADD COLUMN "contextTimeClass" "TimeClass",
ADD COLUMN "contextConfigHash" TEXT,
ADD COLUMN "contextSolutionHash" TEXT;

-- Match src/lib/chess/pgn.ts exactly for normal PGN input: normalize CRLF/CR
-- to LF, trim surrounding whitespace, prepend the versioned domain and a NUL,
-- then hex-encode SHA-256.
UPDATE "AnalyzedGame"
SET "sourcePgnHash" = encode(
    digest(
        convert_to('backranq-source-pgn', 'UTF8') ||
        decode('00', 'hex') ||
        convert_to(
            regexp_replace(
                regexp_replace("pgn", E'\\r\\n?', E'\\n', 'g'),
                E'^\\s+|\\s+$',
                '',
                'g'
            ),
            'UTF8'
        ),
        'sha256'
    ),
    'hex'
)
WHERE "sourcePgnHash" IS NULL;

UPDATE "AnalyzedGame" AS game
SET "currentAnalysisValid" = TRUE
FROM "AnalysisRun" AS run
WHERE game."currentAnalysisRunId" = run."id"
  AND run."status" = 'SUCCEEDED'
  AND run."inputPgnHash" = game."sourcePgnHash";

UPDATE "AnalyzedGame" AS game
SET
    "sourceUsername" = CASE
        WHEN game."provider" = 'LICHESS' THEN owner."lichessUsername"
        WHEN game."provider" = 'CHESSCOM' THEN owner."chesscomUsername"
        ELSE NULL
    END,
    "userSide" = CASE
        WHEN lower(btrim(game."whiteName")) = lower(btrim(
            CASE
                WHEN game."provider" = 'LICHESS' THEN owner."lichessUsername"
                WHEN game."provider" = 'CHESSCOM' THEN owner."chesscomUsername"
                ELSE NULL
            END
        ))
        AND lower(btrim(game."blackName")) <> lower(btrim(
            CASE
                WHEN game."provider" = 'LICHESS' THEN owner."lichessUsername"
                WHEN game."provider" = 'CHESSCOM' THEN owner."chesscomUsername"
                ELSE NULL
            END
        ))
        THEN 'WHITE'::"GameUserSide"
        WHEN lower(btrim(game."blackName")) = lower(btrim(
            CASE
                WHEN game."provider" = 'LICHESS' THEN owner."lichessUsername"
                WHEN game."provider" = 'CHESSCOM' THEN owner."chesscomUsername"
                ELSE NULL
            END
        ))
        AND lower(btrim(game."whiteName")) <> lower(btrim(
            CASE
                WHEN game."provider" = 'LICHESS' THEN owner."lichessUsername"
                WHEN game."provider" = 'CHESSCOM' THEN owner."chesscomUsername"
                ELSE NULL
            END
        ))
        THEN 'BLACK'::"GameUserSide"
        ELSE 'UNKNOWN'::"GameUserSide"
    END
FROM "User" AS owner
WHERE owner."id" = game."userId"
  AND (
      (game."provider" = 'LICHESS' AND owner."lichessUsername" IS NOT NULL) OR
      (game."provider" = 'CHESSCOM' AND owner."chesscomUsername" IS NOT NULL)
  );

UPDATE "TrainingAttempt" AS attempt
SET
    "contextPhase" = moment."phase",
    "contextCpLoss" = moment."cpLoss",
    "contextWinChanceLoss" = moment."winChanceLoss",
    "contextSourceKinds" = moment."sourceKinds",
    "contextLessonKinds" = moment."lessonKinds",
    "contextThemes" = moment."themes",
    "contextProvider" = game."provider",
    "contextTimeClass" = game."timeClass",
    "contextConfigHash" = revision."configHash",
    "contextSolutionHash" = revision."solutionHash"
FROM "TrainingMoment" AS moment, "AnalyzedGame" AS game, "SolutionRevision" AS revision
WHERE moment."id" = attempt."trainingMomentId"
  AND moment."userId" = attempt."userId"
  AND game."id" = moment."gameId"
  AND game."userId" = moment."userId"
  AND revision."id" = attempt."solutionRevisionId"
  AND revision."momentId" = moment."id";

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "AnalyzedGame"
        WHERE "sourcePgnHash" IS NULL OR "sourcePgnHash" !~ '^[0-9a-f]{64}$'
    ) THEN
        RAISE EXCEPTION 'cannot backfill exact source PGN provenance';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM "TrainingAttempt"
        WHERE "contextProvider" IS NULL
           OR "contextTimeClass" IS NULL
           OR "contextConfigHash" IS NULL
           OR "contextSolutionHash" IS NULL
    ) THEN
        RAISE EXCEPTION 'cannot backfill immutable attempt context';
    END IF;
END;
$$;

ALTER TABLE "AnalyzedGame"
ALTER COLUMN "sourcePgnHash" SET NOT NULL;

ALTER TABLE "AnalyzedGame"
ADD CONSTRAINT "AnalyzedGame_current_analysis_valid_requires_run"
CHECK (NOT "currentAnalysisValid" OR "currentAnalysisRunId" IS NOT NULL);

CREATE OR REPLACE FUNCTION public.invalidate_current_analysis_on_source_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW."currentAnalysisRunId" IS NULL
       OR NEW."sourcePgnHash" IS DISTINCT FROM OLD."sourcePgnHash" THEN
        NEW."currentAnalysisValid" := FALSE;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "invalidate_current_analysis_on_source_change" ON public."AnalyzedGame";
CREATE TRIGGER "invalidate_current_analysis_on_source_change"
BEFORE UPDATE OF "sourcePgnHash", "currentAnalysisRunId"
ON public."AnalyzedGame"
FOR EACH ROW
EXECUTE FUNCTION public.invalidate_current_analysis_on_source_change();

ALTER TABLE "TrainingAttempt"
ALTER COLUMN "contextProvider" SET NOT NULL,
ALTER COLUMN "contextTimeClass" SET NOT NULL,
ALTER COLUMN "contextConfigHash" SET NOT NULL,
ALTER COLUMN "contextSolutionHash" SET NOT NULL;

RESET search_path;

CREATE TABLE "PracticeExposure" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "trainingMomentId" UUID NOT NULL,
    "solutionRevisionId" UUID NOT NULL,
    "attemptId" UUID,
    "clientExposureId" TEXT NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "kind" "PracticeExposureEventKind" NOT NULL,
    "shownAt" TIMESTAMP(3) NOT NULL,
    "clientOccurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entrySurface" "PracticeEntrySurface" NOT NULL,
    "recommendationKey" TEXT,
    "focus" "PracticeFocus",
    "terminalReason" "PracticeExposureTerminalReason",

    CONSTRAINT "PracticeExposure_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PracticeExposure_kind_payload" CHECK (
        (
            "kind" = 'SHOWN' AND
            "attemptId" IS NULL AND
            "terminalReason" IS NULL
        ) OR (
            "kind" = 'TERMINAL' AND
            "terminalReason" IN ('MOVE_SUBMITTED', 'REVEALED') AND
            "attemptId" IS NOT NULL
        ) OR (
            "kind" = 'TERMINAL' AND
            "terminalReason" IN ('ABANDONED', 'REPLACED', 'NAVIGATED_AWAY') AND
            "attemptId" IS NULL
        )
    )
);

CREATE TABLE "TrainingAttemptStatusEvent" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "status" "AttemptStatus" NOT NULL,
    "grade" "AttemptGrade",
    "reason" "TrainingAttemptStatusEventReason" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAttemptStatusEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainingAttemptStatusEvent_payload" CHECK (
        ("status" = 'GRADED' AND "grade" IS NOT NULL AND "reason" = 'GRADED') OR
        ("status" <> 'GRADED' AND "grade" IS NULL)
    )
);

CREATE TABLE "PracticeReviewState" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "trainingMomentId" UUID NOT NULL,
    "solutionHash" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "intervalDays" INTEGER NOT NULL,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "successes" INTEGER NOT NULL DEFAULT 0,
    "algorithmVersion" TEXT NOT NULL,
    "lastReviewedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PracticeReviewState_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PracticeReviewState_counters_nonnegative" CHECK (
        "intervalDays" >= 0 AND "lapses" >= 0 AND "successes" >= 0
    )
);

CREATE TABLE "PracticeReviewEvent" (
    "id" UUID NOT NULL,
    "stateId" UUID NOT NULL,
    "attemptId" UUID,
    "userId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "outcome" "PracticeReviewOutcome" NOT NULL,
    "grade" "AttemptGrade",
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "intervalBeforeDays" INTEGER NOT NULL,
    "intervalAfterDays" INTEGER NOT NULL,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "algorithmVersion" TEXT NOT NULL,

    CONSTRAINT "PracticeReviewEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PracticeReviewEvent_intervals_nonnegative" CHECK (
        "intervalBeforeDays" >= 0 AND "intervalAfterDays" >= 0
    ),
    CONSTRAINT "PracticeReviewEvent_grade_payload" CHECK (
        ("outcome" IN ('SUCCESS', 'LAPSE') AND "grade" IS NOT NULL) OR
        ("outcome" IN ('REVEAL', 'UNRESOLVED') AND "grade" IS NULL)
    )
);

CREATE TABLE "ProgressAnalyticsEvent" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "clientEventId" TEXT NOT NULL,
    "eventName" "ProgressAnalyticsEventName" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "insightKey" TEXT,
    "actionKey" TEXT,
    "recommendationKey" TEXT,
    "windowDays" INTEGER,
    "provider" "Provider",
    "timeClass" "TimeClass",

    CONSTRAINT "ProgressAnalyticsEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProgressAnalyticsEvent_window_days" CHECK (
        "windowDays" IS NULL OR "windowDays" IN (28, 90)
    ),
    CONSTRAINT "ProgressAnalyticsEvent_payload" CHECK (
        (
            "eventName" = 'PROGRESS_VIEWED' AND
            "insightKey" IS NULL AND "actionKey" IS NULL AND "recommendationKey" IS NULL
        ) OR (
            "eventName" = 'INSIGHT_EXPANDED' AND
            "insightKey" IS NOT NULL AND "actionKey" IS NULL AND "recommendationKey" IS NULL
        ) OR (
            "eventName" = 'ACTION_CLICKED' AND
            "insightKey" IS NULL AND "actionKey" IS NOT NULL
        ) OR (
            "eventName" = 'PRACTICE_STARTED_FROM_PROGRESS' AND
            "insightKey" IS NULL AND "actionKey" IS NULL
        )
    )
);

CREATE TABLE "ProgressAnalyticsRateBucket" (
    "userId" UUID NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgressAnalyticsRateBucket_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "ProgressAnalyticsRateBucket_event_count" CHECK (
        "eventCount" >= 0 AND "eventCount" <= 60
    )
);

CREATE INDEX "AnalyzedGame_userId_playedAt_provider_timeClass_idx"
ON "AnalyzedGame"("userId", "playedAt", "provider", "timeClass");
CREATE INDEX "AnalyzedGame_userId_analyzedAt_idx"
ON "AnalyzedGame"("userId", "analyzedAt");
CREATE INDEX "AnalyzedGame_userId_currentAnalysisValid_playedAt_idx"
ON "AnalyzedGame"("userId", "currentAnalysisValid", "playedAt");
CREATE INDEX "AnalyzedGame_userId_sourcePgnHash_idx"
ON "AnalyzedGame"("userId", "sourcePgnHash");

CREATE UNIQUE INDEX "TrainingAttempt_id_userId_key"
ON "TrainingAttempt"("id", "userId");
CREATE INDEX "TrainingAttempt_user_status_time_idx"
ON "TrainingAttempt"("userId", "attemptedAt", "status");
CREATE INDEX "TrainingAttempt_user_provider_class_time_idx"
ON "TrainingAttempt"("userId", "contextProvider", "contextTimeClass", "attemptedAt");
CREATE INDEX "TrainingAttempt_user_phase_time_idx"
ON "TrainingAttempt"("userId", "contextPhase", "attemptedAt");

CREATE UNIQUE INDEX "PracticeExposure_userId_clientEventId_key"
ON "PracticeExposure"("userId", "clientEventId");
CREATE INDEX "PracticeExposure_userId_recordedAt_idx"
ON "PracticeExposure"("userId", "recordedAt");
CREATE INDEX "PracticeExposure_userId_kind_recordedAt_idx"
ON "PracticeExposure"("userId", "kind", "recordedAt");
CREATE INDEX "PracticeExposure_trainingMomentId_recordedAt_idx"
ON "PracticeExposure"("trainingMomentId", "recordedAt");
CREATE INDEX "PracticeExposure_solutionRevisionId_idx"
ON "PracticeExposure"("solutionRevisionId");
CREATE INDEX "PracticeExposure_attemptId_idx"
ON "PracticeExposure"("attemptId");
CREATE INDEX "PracticeExposure_user_exposure_time_idx"
ON "PracticeExposure"("userId", "clientExposureId", "recordedAt");

CREATE UNIQUE INDEX "TrainingAttemptStatusEvent_attemptId_eventKey_key"
ON "TrainingAttemptStatusEvent"("attemptId", "eventKey");
CREATE INDEX "TrainingAttemptStatusEvent_user_time_idx"
ON "TrainingAttemptStatusEvent"("userId", "occurredAt");
CREATE INDEX "TrainingAttemptStatusEvent_user_status_time_idx"
ON "TrainingAttemptStatusEvent"("userId", "status", "occurredAt");

CREATE UNIQUE INDEX "PracticeReviewState_user_moment_semantics_key"
ON "PracticeReviewState"("userId", "trainingMomentId", "solutionHash", "configHash");
CREATE INDEX "PracticeReviewState_user_due_idx"
ON "PracticeReviewState"("userId", "nextDueAt");
CREATE INDEX "PracticeReviewState_trainingMomentId_idx"
ON "PracticeReviewState"("trainingMomentId");

CREATE UNIQUE INDEX "PracticeReviewEvent_userId_eventKey_key"
ON "PracticeReviewEvent"("userId", "eventKey");
CREATE INDEX "PracticeReviewEvent_user_time_idx"
ON "PracticeReviewEvent"("userId", "occurredAt");
CREATE INDEX "PracticeReviewEvent_state_time_idx"
ON "PracticeReviewEvent"("stateId", "occurredAt");
CREATE INDEX "PracticeReviewEvent_attemptId_idx"
ON "PracticeReviewEvent"("attemptId");

CREATE UNIQUE INDEX "ProgressAnalyticsEvent_userId_clientEventId_key"
ON "ProgressAnalyticsEvent"("userId", "clientEventId");
CREATE INDEX "ProgressAnalyticsEvent_user_event_time_idx"
ON "ProgressAnalyticsEvent"("userId", "eventName", "occurredAt");
CREATE INDEX "ProgressAnalyticsEvent_user_time_idx"
ON "ProgressAnalyticsEvent"("userId", "occurredAt");
CREATE INDEX "ProgressAnalyticsEvent_user_recorded_time_idx"
ON "ProgressAnalyticsEvent"("userId", "recordedAt");

ALTER TABLE "PracticeExposure"
ADD CONSTRAINT "PracticeExposure_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "PracticeExposure_trainingMomentId_userId_fkey"
FOREIGN KEY ("trainingMomentId", "userId") REFERENCES "TrainingMoment"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "PracticeExposure_solutionRevision_moment_fkey"
FOREIGN KEY ("solutionRevisionId", "trainingMomentId") REFERENCES "SolutionRevision"("id", "momentId") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "PracticeExposure_attemptId_userId_fkey"
FOREIGN KEY ("attemptId", "userId") REFERENCES "TrainingAttempt"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TrainingAttemptStatusEvent"
ADD CONSTRAINT "TrainingAttemptStatusEvent_attempt_user_fkey"
FOREIGN KEY ("attemptId", "userId") REFERENCES "TrainingAttempt"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "TrainingAttemptStatusEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeReviewState"
ADD CONSTRAINT "PracticeReviewState_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "PracticeReviewState_moment_user_fkey"
FOREIGN KEY ("trainingMomentId", "userId") REFERENCES "TrainingMoment"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PracticeReviewEvent"
ADD CONSTRAINT "PracticeReviewEvent_stateId_fkey"
FOREIGN KEY ("stateId") REFERENCES "PracticeReviewState"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "PracticeReviewEvent_attempt_user_fkey"
FOREIGN KEY ("attemptId", "userId") REFERENCES "TrainingAttempt"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "PracticeReviewEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgressAnalyticsEvent"
ADD CONSTRAINT "ProgressAnalyticsEvent_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProgressAnalyticsRateBucket"
ADD CONSTRAINT "ProgressAnalyticsRateBucket_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE public."PracticeExposure" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TrainingAttemptStatusEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeReviewState" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeReviewEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProgressAnalyticsEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."ProgressAnalyticsRateBucket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeExposure" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."TrainingAttemptStatusEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeReviewState" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."PracticeReviewEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."ProgressAnalyticsEvent" FORCE ROW LEVEL SECURITY;
ALTER TABLE public."ProgressAnalyticsRateBucket" FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."PracticeExposure" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."TrainingAttemptStatusEvent" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."PracticeReviewState" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."PracticeReviewEvent" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."ProgressAnalyticsEvent" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."ProgressAnalyticsRateBucket" FROM anon, authenticated;
