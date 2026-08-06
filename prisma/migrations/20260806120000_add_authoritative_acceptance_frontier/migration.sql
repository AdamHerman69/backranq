ALTER TYPE "AttemptGrade" ADD VALUE 'STRONG' AFTER 'BEST';

-- Pre-user reset: V2 revisions/publications cannot satisfy the authoritative
-- V3 accepted-set contract and must never be served as if they did.
DELETE FROM "TrainingMoment";
DELETE FROM "MasterPublication";
DELETE FROM "MasterCandidate";

ALTER TABLE "SolutionRevision"
ADD COLUMN "acceptanceFrontier" JSONB NOT NULL;

ALTER TABLE "MasterCandidate"
ADD COLUMN "acceptanceFrontier" JSONB NOT NULL;
