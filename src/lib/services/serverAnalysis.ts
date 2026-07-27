import { Prisma } from '@prisma/client';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { extractPuzzlesFromGames } from '@/lib/analysis/extractPuzzles';
import { dbGameToNormalized, gameAnalysisToJson } from '@/lib/api/games';
import { replaceGamePuzzlesInTransaction } from '@/lib/api/puzzlePersistence';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { prisma } from '@/lib/prisma';
import {
    ensureAnalysisRunForJob,
    markAnalysisJobFailed,
    markAnalysisJobRunning,
    markAnalysisJobSucceeded,
    SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
    SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
    serverAnalysisConfigFromPreferences,
    transitionAnalysisRunForJob,
} from '@/lib/services/analysisJobs';
import {
    completeAnalysisRunWithGameAnalysis,
    markAnalysisRunFailed,
} from '@/lib/services/analysisRuns';
import {
    consumeServerAnalysisCredits,
    releaseServerAnalysisCredits,
} from '@/lib/services/billingAccounts';

export type AnalyzeGameJobResult = {
    jobId: string;
    gameId: string;
    status: 'SUCCEEDED' | 'RETRY_SCHEDULED' | 'FAILED';
    puzzles: number;
    error?: string;
};

export async function analyzeGameJob(jobId: string): Promise<AnalyzeGameJobResult> {
    const running = await markAnalysisJobRunning(jobId);
    if (!running) {
        throw new Error('Analysis job is not claimable');
    }
    const engine = new ServerStockfishClient();
    let analysisRunId: string | null = null;

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
        const { options, config } = serverAnalysisConfigFromPreferences(
            job.user.preferences
        );
        const run = await ensureAnalysisRunForJob({
            job,
            config,
            status: 'RUNNING',
        });
        analysisRunId = run?.id ?? null;
        await transitionAnalysisRunForJob({
            jobId: job.id,
            status: 'RUNNING',
            queuedReason: job.queuedReason,
            config,
            startedAt: running.startedAt,
        });

        if (job.game.analyzedAt && running.queuedReason !== 'manual-reanalysis') {
            const completed = await markAnalysisJobSucceeded(job.id);
            await transitionAnalysisRunForJob({
                jobId: job.id,
                status: 'SUCCEEDED',
                queuedReason: job.queuedReason,
                config,
                startedAt: completed.startedAt,
                completedAt: completed.completedAt,
                result: {
                    puzzles: 0,
                    skippedAlreadyAnalyzed: true,
                },
            });
            await releaseAnalysisJobReservation({
                userId: job.userId,
                gameId: job.gameId,
                analysisJobId: job.id,
                analysisRunId,
                reason: 'already-analyzed',
            });
            return {
                jobId: job.id,
                gameId: job.gameId,
                status: 'SUCCEEDED',
                puzzles: 0,
            };
        }

        const normalized = dbGameToNormalized(job.game);
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
        if (run) {
            await completeAnalysisRunWithGameAnalysis({
                runId: run.id,
                userId: job.userId,
                gameId: job.gameId,
                analysis,
                puzzles: puzzlesForGame,
                consumedCredits: SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
            });
        } else {
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
        }

        await markAnalysisJobSucceeded(job.id);
        await consumeAnalysisJobReservation({
            userId: job.userId,
            gameId: job.gameId,
            analysisJobId: job.id,
            analysisRunId,
            reason: 'analysis-succeeded',
        });
        return {
            jobId: job.id,
            gameId: job.gameId,
            status: 'SUCCEEDED',
            puzzles: puzzlesForGame.length,
        };
    } catch (error) {
        const updated = await markAnalysisJobFailed(running.id, error);
        if (updated.status === 'QUEUED') {
            await transitionAnalysisRunForJob({
                jobId: running.id,
                status: 'QUEUED',
                error,
            }).catch(() => undefined);
            return {
                jobId: running.id,
                gameId: running.gameId,
                status: 'RETRY_SCHEDULED',
                puzzles: 0,
                error: errorMessage(error),
            };
        }

        if (analysisRunId) {
            await markAnalysisRunFailed({
                runId: analysisRunId,
                error,
                consumedCredits: SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
            }).catch(() => undefined);
        }
        if (running) {
            await releaseAnalysisJobReservation({
                userId: running.userId,
                gameId: running.gameId,
                analysisJobId: running.id,
                analysisRunId,
                reason: 'analysis-failed',
            });
        }
        return {
            jobId: running.id,
            gameId: running.gameId,
            status: 'FAILED',
            puzzles: 0,
            error: errorMessage(error),
        };
    } finally {
        engine.terminate();
    }
}

async function consumeAnalysisJobReservation(args: {
    userId: string;
    gameId: string;
    analysisJobId: string;
    analysisRunId: string | null;
    reason: string;
}) {
    await consumeServerAnalysisCredits({
        userId: args.userId,
        gameId: args.gameId,
        analysisJobId: args.analysisJobId,
        analysisRunId: args.analysisRunId,
        credits: SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
        idempotencyKey: ledgerIdempotencyKey(args, 'consume'),
        reason: args.reason,
    }).catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('[credit ledger] consume skipped:', error);
        }
    });
}

async function releaseAnalysisJobReservation(args: {
    userId: string;
    gameId: string;
    analysisJobId: string;
    analysisRunId: string | null;
    reason: string;
}) {
    await releaseServerAnalysisCredits({
        userId: args.userId,
        gameId: args.gameId,
        analysisJobId: args.analysisJobId,
        analysisRunId: args.analysisRunId,
        credits: SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
        idempotencyKey: ledgerIdempotencyKey(args, 'release'),
        reason: args.reason,
    }).catch((error) => {
        if (process.env.NODE_ENV !== 'production') {
            console.warn('[credit ledger] release skipped:', error);
        }
    });
}

function ledgerIdempotencyKey(
    args: { analysisJobId: string; analysisRunId: string | null },
    action: 'consume' | 'release'
) {
    return args.analysisRunId
        ? `analysis-run:${args.analysisRunId}:${action}`
        : `analysis-job:${args.analysisJobId}:${action}`;
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
