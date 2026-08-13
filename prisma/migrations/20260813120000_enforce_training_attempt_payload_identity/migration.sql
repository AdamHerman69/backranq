-- Practice attempts are pre-user data. Reset the derived review state so the
-- new authoritative/idempotent contract starts from one internally consistent
-- evidence set instead of preserving client-trusted grades.
DELETE FROM "TrainingAttempt";
DELETE FROM "PracticeReviewState";
UPDATE "TrainingMoment" SET "lastTrainedAt" = NULL;

ALTER TABLE "TrainingAttempt"
ADD COLUMN "clientPayloadHash" TEXT NOT NULL;
