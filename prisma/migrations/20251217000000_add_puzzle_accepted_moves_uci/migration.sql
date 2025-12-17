-- AlterTable
ALTER TABLE "Puzzle" ADD COLUMN     "acceptedMovesUci" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

