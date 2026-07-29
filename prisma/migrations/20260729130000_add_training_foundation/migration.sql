-- Clean canonical training model. This migration is an intentional hard cut:
-- no legacy puzzle data is migrated or kept.

-- CreateEnum
CREATE TYPE "TrainingMomentStatus" AS ENUM ('ACTIVE', 'UNSTABLE', 'INVALIDATED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "TrainingSourceKind" AS ENUM ('MY_MISTAKE', 'MISSED_OPPORTUNITY');

-- CreateEnum
CREATE TYPE "TrainingLessonKind" AS ENUM ('AVOID_MISTAKE', 'PUNISH_MISTAKE', 'SAVE_DRAW', 'PRESERVE_WIN', 'CONVERT_ADVANTAGE', 'IMPROVE_POSITION');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('VERIFIED', 'AMBIGUOUS', 'UNSTABLE', 'INVALID');

-- CreateEnum
CREATE TYPE "SolutionShape" AS ENUM ('UNIQUE', 'MULTIPLE', 'OPEN');

-- CreateEnum
CREATE TYPE "GradingStrategy" AS ENUM ('PRECOMPUTED', 'OUTCOME_TOLERANCE', 'DYNAMIC', 'TABLEBASE');

-- CreateEnum
CREATE TYPE "ContinuationShape" AS ENUM ('SINGLE_DECISION', 'CONDITIONAL_LINE');

-- CreateEnum
CREATE TYPE "AttemptStatus" AS ENUM ('PENDING', 'GRADED', 'REVEALED', 'SKIPPED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "AttemptGrade" AS ENUM ('BEST', 'GOOD', 'IMPROVED', 'REPEATED_MISTAKE', 'DIFFERENT_MISTAKE');

-- CreateEnum
CREATE TYPE "MoveAssessmentSource" AS ENUM ('PRECOMPUTED', 'DYNAMIC', 'TABLEBASE');

-- CreateEnum
CREATE TYPE "MoveAssessmentStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "AttemptStepActor" AS ENUM ('USER', 'ENGINE');

-- AlterTable
ALTER TABLE "AnalysisRun"
ADD COLUMN "inputPgnHash" TEXT NOT NULL,
ADD COLUMN "engineFlavor" TEXT,
ADD COLUMN "engineEvalFile" TEXT,
ADD COLUMN "engineOptions" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- CreateTable
CREATE TABLE "TrainingMoment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "momentKey" TEXT NOT NULL,
    "sourcePgnHash" TEXT NOT NULL,
    "decisionPly" INTEGER NOT NULL,
    "fen" TEXT NOT NULL,
    "positionHistory" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sideToMove" TEXT NOT NULL,
    "originalMoveUci" TEXT NOT NULL,
    "scoreBefore" JSONB NOT NULL,
    "scoreAfter" JSONB NOT NULL,
    "cpLoss" DOUBLE PRECISION,
    "winChanceLoss" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "phase" "GamePhase",
    "status" "TrainingMomentStatus" NOT NULL DEFAULT 'ACTIVE',
    "sourceKinds" "TrainingSourceKind"[] NOT NULL DEFAULT ARRAY[]::"TrainingSourceKind"[],
    "lessonKinds" "TrainingLessonKind"[] NOT NULL DEFAULT ARRAY[]::"TrainingLessonKind"[],
    "themes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "currentSolutionRevisionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTrainedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingMoment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolutionRevision" (
    "id" UUID NOT NULL,
    "momentId" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "solutionHash" TEXT NOT NULL,
    "verificationStatus" "VerificationStatus" NOT NULL,
    "solutionShape" "SolutionShape" NOT NULL,
    "gradingStrategy" "GradingStrategy" NOT NULL,
    "continuationShape" "ContinuationShape" NOT NULL,
    "trainable" BOOLEAN NOT NULL DEFAULT true,
    "bestMoveUci" TEXT NOT NULL,
    "acceptedMovesUci" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "bestLine" JSONB NOT NULL,
    "solutionTree" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "scoreAtStart" JSONB,
    "playedMoveScore" JSONB,
    "targetOutcome" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "gradingPolicy" JSONB NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "generatorVersion" TEXT NOT NULL,
    "configHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolutionRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingMomentObservation" (
    "momentId" UUID NOT NULL,
    "analysisRunId" UUID NOT NULL,
    "solutionRevisionId" UUID NOT NULL,
    "observedSolutionHash" TEXT NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingMomentObservation_pkey" PRIMARY KEY ("momentId", "analysisRunId")
);

-- CreateTable
CREATE TABLE "SolutionMoveAssessment" (
    "id" UUID NOT NULL,
    "solutionRevisionId" UUID NOT NULL,
    "positionKey" TEXT NOT NULL,
    "decisionIndex" INTEGER NOT NULL,
    "fen" TEXT NOT NULL,
    "moveUci" TEXT NOT NULL,
    "source" "MoveAssessmentSource" NOT NULL,
    "status" "MoveAssessmentStatus" NOT NULL DEFAULT 'PENDING',
    "grade" "AttemptGrade",
    "scoreAfter" JSONB,
    "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolutionMoveAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingAttempt" (
    "id" UUID NOT NULL,
    "trainingMomentId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "solutionRevisionId" UUID NOT NULL,
    "clientAttemptId" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userMoveUci" TEXT,
    "timeSpentMs" INTEGER,
    "status" "AttemptStatus" NOT NULL DEFAULT 'PENDING',
    "grade" "AttemptGrade",
    "gradingSource" "MoveAssessmentSource",
    "gradingEvidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "bestGapCp" INTEGER,
    "bestGapWinChance" DOUBLE PRECISION,
    "recoveredCp" INTEGER,
    "recoveredWinChance" DOUBLE PRECISION,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "TrainingAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainingAttempt_time_nonnegative" CHECK ("timeSpentMs" IS NULL OR "timeSpentMs" >= 0),
    CONSTRAINT "TrainingAttempt_metrics_nonnegative" CHECK (
        ("bestGapCp" IS NULL OR "bestGapCp" >= 0) AND
        ("bestGapWinChance" IS NULL OR "bestGapWinChance" >= 0) AND
        ("recoveredCp" IS NULL OR "recoveredCp" >= 0) AND
        ("recoveredWinChance" IS NULL OR "recoveredWinChance" >= 0)
    ),
    CONSTRAINT "TrainingAttempt_status_payload" CHECK (
        (
            "status" = 'PENDING' AND
            "grade" IS NULL AND
            "completedAt" IS NULL
        ) OR (
            "status" = 'GRADED' AND
            "grade" IS NOT NULL AND
            "userMoveUci" IS NOT NULL AND
            "completedAt" IS NOT NULL
        ) OR (
            "status" = 'REVEALED' AND
            "grade" IS NULL AND
            "userMoveUci" IS NULL AND
            "completedAt" IS NOT NULL
        ) OR (
            "status" IN ('SKIPPED', 'UNRESOLVED') AND
            "grade" IS NULL AND
            "completedAt" IS NOT NULL
        )
    )
);

-- CreateTable
CREATE TABLE "TrainingAttemptStep" (
    "id" UUID NOT NULL,
    "attemptId" UUID NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "actor" "AttemptStepActor" NOT NULL,
    "fenBefore" TEXT NOT NULL,
    "moveUci" TEXT NOT NULL,
    "grade" "AttemptGrade",
    "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "timeSpentMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingAttemptStep_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TrainingAttemptStep_index_nonnegative" CHECK ("stepIndex" >= 0),
    CONSTRAINT "TrainingAttemptStep_time_nonnegative" CHECK ("timeSpentMs" IS NULL OR "timeSpentMs" >= 0),
    CONSTRAINT "TrainingAttemptStep_move_uci" CHECK ("moveUci" ~ '^[a-h][1-8][a-h][1-8][qrbn]?$')
);

-- CreateTable
CREATE TABLE "AnalysisOpsCounter" (
    "key" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalysisOpsCounter_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AnalysisRun_inputPgnHash_idx" ON "AnalysisRun"("inputPgnHash");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyzedGame_id_userId_key" ON "AnalyzedGame"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_id_gameId_userId_key" ON "AnalysisRun"("id", "gameId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisRun_one_active_per_game_key"
ON "AnalysisRun"("gameId")
WHERE "status" IN ('QUEUED', 'RUNNING');

-- CreateIndex
CREATE UNIQUE INDEX "TrainingMoment_momentKey_key" ON "TrainingMoment"("momentKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingMoment_currentSolutionRevisionId_key" ON "TrainingMoment"("currentSolutionRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingMoment_gameId_sourcePgnHash_decisionPly_key" ON "TrainingMoment"("gameId", "sourcePgnHash", "decisionPly");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingMoment_id_userId_key" ON "TrainingMoment"("id", "userId");

-- CreateIndex
CREATE INDEX "TrainingMoment_userId_status_archivedAt_idx" ON "TrainingMoment"("userId", "status", "archivedAt");
CREATE INDEX "TrainingMoment_userId_status_lastTrainedAt_createdAt_idx" ON "TrainingMoment"("userId", "status", "lastTrainedAt", "createdAt");

-- CreateIndex
CREATE INDEX "TrainingMoment_gameId_archivedAt_idx" ON "TrainingMoment"("gameId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "SolutionRevision_momentId_revision_key" ON "SolutionRevision"("momentId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "SolutionRevision_momentId_analysisRunId_key" ON "SolutionRevision"("momentId", "analysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "SolutionRevision_id_momentId_key" ON "SolutionRevision"("id", "momentId");

-- CreateIndex
CREATE INDEX "SolutionRevision_solutionHash_idx" ON "SolutionRevision"("solutionHash");

-- CreateIndex
CREATE INDEX "SolutionRevision_analysisRunId_idx" ON "SolutionRevision"("analysisRunId");

-- CreateIndex
CREATE INDEX "TrainingMomentObservation_analysisRunId_idx" ON "TrainingMomentObservation"("analysisRunId");

-- CreateIndex
CREATE INDEX "TrainingMomentObservation_solutionRevisionId_idx" ON "TrainingMomentObservation"("solutionRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "SolutionMoveAssessment_revision_decision_position_move_key" ON "SolutionMoveAssessment"("solutionRevisionId", "decisionIndex", "positionKey", "moveUci");

-- CreateIndex
CREATE INDEX "SolutionMoveAssessment_solutionRevisionId_decisionIndex_idx" ON "SolutionMoveAssessment"("solutionRevisionId", "decisionIndex");

-- CreateIndex
CREATE INDEX "SolutionMoveAssessment_status_lockedUntil_createdAt_idx" ON "SolutionMoveAssessment"("status", "lockedUntil", "createdAt");

-- CreateIndex
CREATE INDEX "TrainingAttempt_trainingMomentId_idx" ON "TrainingAttempt"("trainingMomentId");

-- CreateIndex
CREATE INDEX "TrainingAttempt_userId_idx" ON "TrainingAttempt"("userId");

-- CreateIndex
CREATE INDEX "TrainingAttempt_solutionRevisionId_idx" ON "TrainingAttempt"("solutionRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttempt_userId_clientAttemptId_key" ON "TrainingAttempt"("userId", "clientAttemptId");

-- CreateIndex
-- Bound dynamic grading to one active engine-backed attempt per user. The API
-- claims a slot by inserting/updating PENDING in the same transaction.
CREATE UNIQUE INDEX "TrainingAttempt_one_pending_per_user_key"
ON "TrainingAttempt"("userId")
WHERE "status" = 'PENDING';

-- CreateIndex
CREATE INDEX "TrainingAttempt_userId_trainingMomentId_idx" ON "TrainingAttempt"("userId", "trainingMomentId");

-- CreateIndex
CREATE INDEX "TrainingAttempt_userId_trainingMomentId_solutionRevisionId_idx" ON "TrainingAttempt"("userId", "trainingMomentId", "solutionRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingAttemptStep_attemptId_stepIndex_key" ON "TrainingAttemptStep"("attemptId", "stepIndex");

-- CreateIndex
CREATE INDEX "TrainingAttemptStep_attemptId_idx" ON "TrainingAttemptStep"("attemptId");

-- AddForeignKey
ALTER TABLE "TrainingMoment" ADD CONSTRAINT "TrainingMoment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingMoment" ADD CONSTRAINT "TrainingMoment_gameId_userId_fkey" FOREIGN KEY ("gameId", "userId") REFERENCES "AnalyzedGame"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Replace single-column ownership-blind game relations with composite ones.
ALTER TABLE "AnalysisRun" DROP CONSTRAINT "AnalysisRun_gameId_fkey";
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_gameId_userId_fkey" FOREIGN KEY ("gameId", "userId") REFERENCES "AnalyzedGame"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisJob" DROP CONSTRAINT "AnalysisJob_gameId_fkey";
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_gameId_userId_fkey" FOREIGN KEY ("gameId", "userId") REFERENCES "AnalyzedGame"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AnalysisJob" DROP CONSTRAINT "AnalysisJob_analysisRunId_fkey";
-- V2 has no runless queue lifecycle. The application has no production users,
-- so unsupported legacy jobs are discarded instead of receiving fabricated
-- provenance from current preferences.
DELETE FROM "AnalysisJob" WHERE "analysisRunId" IS NULL;
ALTER TABLE "AnalysisJob" ALTER COLUMN "analysisRunId" SET NOT NULL;
ALTER TABLE "AnalysisJob" ADD CONSTRAINT "AnalysisJob_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolutionRevision" ADD CONSTRAINT "SolutionRevision_momentId_fkey" FOREIGN KEY ("momentId") REFERENCES "TrainingMoment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolutionRevision" ADD CONSTRAINT "SolutionRevision_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingMoment" ADD CONSTRAINT "TrainingMoment_currentSolutionRevisionId_fkey" FOREIGN KEY ("currentSolutionRevisionId") REFERENCES "SolutionRevision"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingMomentObservation" ADD CONSTRAINT "TrainingMomentObservation_momentId_fkey" FOREIGN KEY ("momentId") REFERENCES "TrainingMoment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingMomentObservation" ADD CONSTRAINT "TrainingMomentObservation_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "AnalysisRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingMomentObservation" ADD CONSTRAINT "TrainingMomentObservation_solutionRevisionId_momentId_fkey" FOREIGN KEY ("solutionRevisionId", "momentId") REFERENCES "SolutionRevision"("id", "momentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolutionMoveAssessment" ADD CONSTRAINT "SolutionMoveAssessment_solutionRevisionId_fkey" FOREIGN KEY ("solutionRevisionId") REFERENCES "SolutionRevision"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_trainingMomentId_userId_fkey" FOREIGN KEY ("trainingMomentId", "userId") REFERENCES "TrainingMoment"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttempt" ADD CONSTRAINT "TrainingAttempt_solutionRevisionId_trainingMomentId_fkey" FOREIGN KEY ("solutionRevisionId", "trainingMomentId") REFERENCES "SolutionRevision"("id", "momentId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingAttemptStep" ADD CONSTRAINT "TrainingAttemptStep_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "TrainingAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Cross-row membership invariants that cannot be represented as CHECK
-- constraints. They reject cross-moment current pointers, mismatched
-- current-run/job links and observation provenance/hash drift.
CREATE FUNCTION "enforce_training_moment_current_revision"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."currentSolutionRevisionId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "SolutionRevision" r
        WHERE r."id" = NEW."currentSolutionRevisionId"
          AND r."momentId" = NEW."id"
    ) THEN
        RAISE EXCEPTION 'current solution revision belongs to another training moment';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "TrainingMoment_current_revision_membership"
BEFORE INSERT OR UPDATE OF "currentSolutionRevisionId" ON "TrainingMoment"
FOR EACH ROW EXECUTE FUNCTION "enforce_training_moment_current_revision"();

CREATE FUNCTION "enforce_analyzed_game_current_run"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."currentAnalysisRunId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AnalysisRun" r
        WHERE r."id" = NEW."currentAnalysisRunId"
          AND r."gameId" = NEW."id"
          AND r."userId" = NEW."userId"
    ) THEN
        RAISE EXCEPTION 'current analysis run belongs to another game or user';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AnalyzedGame_current_run_membership"
BEFORE INSERT OR UPDATE OF "currentAnalysisRunId" ON "AnalyzedGame"
FOR EACH ROW EXECUTE FUNCTION "enforce_analyzed_game_current_run"();

CREATE FUNCTION "enforce_analysis_job_run"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."analysisRunId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AnalysisRun" r
        WHERE r."id" = NEW."analysisRunId"
          AND r."gameId" = NEW."gameId"
          AND r."userId" = NEW."userId"
    ) THEN
        RAISE EXCEPTION 'analysis run belongs to another job game or user';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AnalysisJob_run_membership"
BEFORE INSERT OR UPDATE OF "analysisRunId", "gameId", "userId" ON "AnalysisJob"
FOR EACH ROW EXECUTE FUNCTION "enforce_analysis_job_run"();

CREATE FUNCTION "enforce_training_observation_provenance"()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "TrainingMoment" m
        JOIN "AnalysisRun" r
          ON r."id" = NEW."analysisRunId"
         AND r."gameId" = m."gameId"
         AND r."userId" = m."userId"
         AND r."inputPgnHash" = m."sourcePgnHash"
        JOIN "SolutionRevision" s
          ON s."id" = NEW."solutionRevisionId"
         AND s."momentId" = m."id"
         AND s."solutionHash" = NEW."observedSolutionHash"
        WHERE m."id" = NEW."momentId"
    ) THEN
        RAISE EXCEPTION 'training observation provenance mismatch';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "TrainingMomentObservation_provenance"
BEFORE INSERT OR UPDATE ON "TrainingMomentObservation"
FOR EACH ROW EXECUTE FUNCTION "enforce_training_observation_provenance"();

-- Match the existing private-table posture: server-side Prisma only.
ALTER TABLE public."TrainingMoment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SolutionRevision" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TrainingMomentObservation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SolutionMoveAssessment" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TrainingAttempt" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."TrainingAttemptStep" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."AnalysisOpsCounter" ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public."TrainingMoment" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."SolutionRevision" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."TrainingMomentObservation" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."SolutionMoveAssessment" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."TrainingAttempt" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."TrainingAttemptStep" FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public."AnalysisOpsCounter" FROM anon, authenticated;

-- Clean break: the application has no users to migrate and the canonical
-- TrainingMoment domain is the only supported training persistence model.
DROP TABLE "PuzzleAttempt";
DROP TABLE "Puzzle";
DROP TYPE "PuzzleKind";
DROP TYPE "PuzzleType";
