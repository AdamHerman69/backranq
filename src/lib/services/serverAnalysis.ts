import { Prisma } from '@prisma/client';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { extractPuzzlesFromGames } from '@/lib/analysis/extractPuzzles';
import { gameAnalysisToJson, dbGameToNormalized } from '@/lib/api/games';
import { replaceGamePuzzlesInTransaction } from '@/lib/api/puzzlePersistence';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { prisma } from '@/lib/prisma';
import {
    analysisDefaultsToExtractOptions,
    defaultPreferences,
    mergePreferences,
    pickAnalysisDefaults,
    type PartialPreferences,
} from '@/lib/preferences';
import {
    markAnalysisJobFailed,
    markAnalysisJobRunning,
    markAnalysisJobSucceeded,
} from '@/lib/services/analysisJobs';

export type AnalyzeGameJobResult = {
    jobId: string;
    gameId: string;
    puzzles: number;
};

export async function analyzeGameJob(jobId: string): Promise<AnalyzeGameJobResult> {
    const running = await markAnalysisJobRunning(jobId);
    const engine = new ServerStockfishClient();

    try {
        const job = await prisma.analysisJob.findUnique({
            where: { id: running.id },
            include: {
                game: true,
                user: {
                    select: {
                        preferences: true,
                        lichessUsername: true,
                        chesscomUsername: true,
                    },
                },
            },
        });
        if (!job) throw new Error('Analysis job not found');
        if (job.game.analyzedAt && running.queuedReason !== 'manual-reanalysis') {
            await markAnalysisJobSucceeded(job.id);
            return { jobId: job.id, gameId: job.gameId, puzzles: 0 };
        }

        const normalized = dbGameToNormalized(job.game);
        const prefs = mergePreferences(
            defaultPreferences(),
            (job.user.preferences ?? {}) as PartialPreferences
        );
        const options = analysisDefaultsToExtractOptions(
            pickAnalysisDefaults(prefs),
            { returnAnalysis: true }
        );
        const out = await extractPuzzlesFromGames({
            games: [normalized],
            selectedGameIds: new Set([normalized.id]),
            engine,
            usernameByProvider: {
                lichess: job.user.lichessUsername ?? undefined,
                chesscom: job.user.chesscomUsername ?? undefined,
            },
            options,
        });

        const analysis = out.analysis?.get(normalized.id) as
            | GameAnalysis
            | undefined;
        if (!analysis) throw new Error('Analysis produced no result');

        const puzzlesForGame = out.puzzles.filter(
            (puzzle) => puzzle.sourceGameId === normalized.id
        );
        await prisma.$transaction(async (tx) => {
            await tx.analyzedGame.update({
                where: { id: job.gameId },
                data: {
                    analysis: gameAnalysisToJson(
                        analysis
                    ) as Prisma.InputJsonValue,
                    analyzedAt: new Date(),
                },
            });
            await replaceGamePuzzlesInTransaction({
                tx,
                userId: job.userId,
                gameId: job.gameId,
                puzzles: puzzlesForGame,
            });
        });

        await markAnalysisJobSucceeded(job.id);
        return {
            jobId: job.id,
            gameId: job.gameId,
            puzzles: puzzlesForGame.length,
        };
    } catch (error) {
        await markAnalysisJobFailed(running.id, error);
        throw error;
    } finally {
        engine.terminate();
    }
}
