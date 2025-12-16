-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('LICHESS', 'CHESSCOM');

-- CreateEnum
CREATE TYPE "TimeClass" AS ENUM ('BULLET', 'BLITZ', 'RAPID', 'CLASSICAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PuzzleType" AS ENUM ('AVOID_BLUNDER', 'PUNISH_BLUNDER');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "lichessUsername" TEXT,
    "chesscomUsername" TEXT,
    "preferences" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyzedGame" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "Provider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT,
    "pgn" TEXT NOT NULL,
    "playedAt" TIMESTAMP(3) NOT NULL,
    "timeClass" "TimeClass" NOT NULL,
    "rated" BOOLEAN,
    "result" TEXT,
    "termination" TEXT,
    "whiteName" TEXT NOT NULL,
    "whiteRating" INTEGER,
    "blackName" TEXT NOT NULL,
    "blackRating" INTEGER,
    "openingEco" TEXT,
    "openingName" TEXT,
    "openingVariation" TEXT,
    "analysis" JSONB NOT NULL,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyzedGame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Puzzle" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "gameId" UUID NOT NULL,
    "sourcePly" INTEGER NOT NULL,
    "fen" TEXT NOT NULL,
    "type" "PuzzleType" NOT NULL,
    "severity" TEXT,
    "bestMoveUci" TEXT NOT NULL,
    "bestLine" JSONB NOT NULL,
    "score" JSONB NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "openingEco" TEXT,
    "openingName" TEXT,
    "openingVariation" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Puzzle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PuzzleAttempt" (
    "id" UUID NOT NULL,
    "puzzleId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userMoveUci" TEXT NOT NULL,
    "wasCorrect" BOOLEAN NOT NULL,
    "timeSpentMs" INTEGER,

    CONSTRAINT "PuzzleAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "AnalyzedGame_userId_idx" ON "AnalyzedGame"("userId");

-- CreateIndex
CREATE INDEX "AnalyzedGame_provider_externalId_idx" ON "AnalyzedGame"("provider", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyzedGame_userId_provider_externalId_key" ON "AnalyzedGame"("userId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "Puzzle_userId_idx" ON "Puzzle"("userId");

-- CreateIndex
CREATE INDEX "Puzzle_gameId_idx" ON "Puzzle"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "Puzzle_gameId_sourcePly_fen_key" ON "Puzzle"("gameId", "sourcePly", "fen");

-- CreateIndex
CREATE INDEX "PuzzleAttempt_puzzleId_idx" ON "PuzzleAttempt"("puzzleId");

-- CreateIndex
CREATE INDEX "PuzzleAttempt_userId_idx" ON "PuzzleAttempt"("userId");

-- AddForeignKey
ALTER TABLE "AnalyzedGame" ADD CONSTRAINT "AnalyzedGame_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Puzzle" ADD CONSTRAINT "Puzzle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Puzzle" ADD CONSTRAINT "Puzzle_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "AnalyzedGame"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PuzzleAttempt" ADD CONSTRAINT "PuzzleAttempt_puzzleId_fkey" FOREIGN KEY ("puzzleId") REFERENCES "Puzzle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PuzzleAttempt" ADD CONSTRAINT "PuzzleAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
