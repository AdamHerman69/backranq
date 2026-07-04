ALTER TABLE "Puzzle" ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE INDEX "Puzzle_userId_archivedAt_idx" ON "Puzzle"("userId", "archivedAt");
CREATE INDEX "Puzzle_gameId_archivedAt_idx" ON "Puzzle"("gameId", "archivedAt");
