-- Add composite indexes to speed up EXISTS/NOT EXISTS checks used by /api/puzzles/random
-- (filtering attempts by userId+puzzleId and userId+puzzleId+wasCorrect).

CREATE INDEX "PuzzleAttempt_userId_puzzleId_idx"
ON "PuzzleAttempt" ("userId", "puzzleId");

CREATE INDEX "PuzzleAttempt_userId_puzzleId_wasCorrect_idx"
ON "PuzzleAttempt" ("userId", "puzzleId", "wasCorrect");




