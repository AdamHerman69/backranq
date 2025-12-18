-- CreateEnum
CREATE TYPE "PuzzleKind" AS ENUM ('BLUNDER', 'MISSED_WIN', 'MISSED_TACTIC');

-- CreateEnum
CREATE TYPE "GamePhase" AS ENUM ('OPENING', 'MIDDLEGAME', 'ENDGAME');

-- AlterTable
ALTER TABLE "Puzzle" ADD COLUMN     "kind" "PuzzleKind" NOT NULL DEFAULT 'BLUNDER';
ALTER TABLE "Puzzle" ADD COLUMN     "phase" "GamePhase";

-- Backfill kind from legacy kind:* tags
UPDATE "Puzzle" SET "kind" = 'MISSED_WIN' WHERE "tags" @> ARRAY['kind:missedWin']::TEXT[];
UPDATE "Puzzle" SET "kind" = 'MISSED_TACTIC' WHERE "tags" @> ARRAY['kind:missedTactic']::TEXT[];

-- Strip legacy pseudo-tags (category/opening/kind) from tags array
UPDATE "Puzzle" p
SET "tags" = (
    SELECT COALESCE(array_agg(t ORDER BY t), ARRAY[]::TEXT[])
    FROM unnest(p."tags") AS t
    WHERE
        t <> 'avoidBlunder'
        AND t <> 'punishBlunder'
        AND t !~ '^kind:'
        AND t !~ '^eco:'
        AND t !~ '^opening:'
        AND t !~ '^openingVar:'
);

