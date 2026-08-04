import type { GameAnalysis } from '@/lib/analysis/classification';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { dbGameToNormalized } from '@/lib/api/games';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import { prisma } from '@/lib/prisma';
import {
    markAnalysisJobFailed,
    markAnalysisJobRunning,
    serverAnalysisConfigFromSnapshot,
    transitionAnalysisRunForJob,
    StaleAnalysisDeliveryError,
} from '@/lib/services/analysisJobs';
import { parseAnalysisDispatchToken } from '@/lib/services/analysisDispatchFence';
import {
    completeAnalysisRunWithGameAnalysis,
    completeAnalysisRunWithoutGameWrite,
} from '@/lib/services/analysisRuns';
import {
    consumeServerAnalysisCredits,
    releaseServerAnalysisCreditsAndMarkRunReleased,
} from '@/lib/services/billingAccounts';
import { recordStaleAnalysisDelivery } from '@/lib/services/analysisOps';
import { recordAnalysisFailed } from '@/lib/notifications/service';

export type AnalyzeGameJobResult = {
    jobId: string;
    gameId: string;
    status: 'SUCCEEDED' | 'RETRY_SCHEDULED' | 'FAILED';
    trainingMoments: number;
    error?: string;
    retryAt?: Date;
    settlementPending?: boolean;
};

export async function analyzeGameJob(
    jobId: string,
    dispatchToken: string
): Promise<AnalyzeGameJobResult> {
    const fence = parseAnalysisDispatchToken({ jobId, dispatchToken });
    if (!fence) {
        return rejectStaleAnalysisDelivery(jobId);
    }

    const running = await markAnalysisJobRunning(jobId, dispatchToken);
    if (!running) {
        return rejectStaleAnalysisDelivery(jobId);
    }
    let engine: ServerStockfishClient | null = null;
    let analysisRunId: string | null = null;
    let completionCommitted = false;
    let creditCost = 0;

    try {
        const job = await prisma.analysisJob.findUnique({
            where: { id: running.id },
            include: {
                game: true,
                analysisRun: {
                    select: {
                        id: true,
                        configSnapshot: true,
                        configHash: true,
                        creditCost: true,
                    },
                },
                user: {
                    select: {
                        lichessUsername: true,
                        chesscomUsername: true,
                    },
                },
            },
        });
        if (!job) throw new Error('Analysis job not found');
        const run = job.analysisRun;
        analysisRunId = run.id;
        creditCost = run.creditCost;
        const resolvedConfig = serverAnalysisConfigFromSnapshot({
            snapshot: run.configSnapshot,
            hash: run.configHash,
        });
        if (!resolvedConfig) {
            throw new Error(
                'Analysis run has invalid enqueue-time configuration provenance'
            );
        }
        const { options, config } = resolvedConfig;
        const transitionedRun = await transitionAnalysisRunForJob({
            jobId: job.id,
            status: 'RUNNING',
            config,
            startedAt: running.startedAt,
        });
        if (!transitionedRun) {
            throw new Error(
                'Analysis run provenance could not transition to running'
            );
        }
        engine = new ServerStockfishClient();

        if (job.game.analyzedAt && running.queuedReason !== 'manual-reanalysis') {
            await completeAnalysisRunWithoutGameWrite({
                runId: run.id,
                analysisJobId: job.id,
                fence,
                consumedCredits: 0,
            });
            completionCommitted = true;
            try {
                await releaseAnalysisJobReservation({
                    userId: job.userId,
                    gameId: job.gameId,
                    analysisJobId: job.id,
                    analysisRunId,
                    credits: creditCost,
                    reason: 'already-analyzed',
                });
                await markSettlementComplete({
                    jobId: job.id,
                    analysisRunId: run.id,
                    consumedCredits: 0,
                });
            } catch (error) {
                await recordSettlementPending({
                    jobId: job.id,
                    analysisRunId,
                    action: 'release',
                    error,
                });
                return {
                    jobId: job.id,
                    gameId: job.gameId,
                    status: 'SUCCEEDED',
                    trainingMoments: 0,
                    settlementPending: true,
                    error: errorMessage(error),
                };
            }
            return {
                jobId: job.id,
                gameId: job.gameId,
                status: 'SUCCEEDED',
                trainingMoments: 0,
            };
        }

        const normalized = dbGameToNormalized(job.game);
        if (!run.configHash) {
            throw new Error('Analysis run config hash is required');
        }
        const out = await extractTrainingMomentsFromGames({
            games: [normalized],
            selectedGameIds: new Set([normalized.id]),
            engine,
            tablebase: new LichessTablebaseClient(),
            canonicalSourceGameIdByGameId: {
                [normalized.id]: job.gameId,
            },
            analysisConfigHash: run.configHash,
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

        const trainingMomentsForGame = out.moments.filter(
            (moment) => moment.sourceGameId === job.gameId
        );
        const extractionManifest = out.manifests.find(
            (manifest) => manifest.sourceGameId === job.gameId
        );
        if (!extractionManifest?.complete) {
            throw new Error('Training extraction did not complete');
        }
        await completeAnalysisRunWithGameAnalysis({
            runId: run.id,
            userId: job.userId,
            gameId: job.gameId,
            analysis,
            trainingMoments: trainingMomentsForGame,
            extractionManifest,
            consumedCredits: null,
            analysisJob: {
                id: job.id,
                fence,
            },
        });
        completionCommitted = true;

        try {
            await consumeAnalysisJobReservation({
                userId: job.userId,
                gameId: job.gameId,
                analysisJobId: job.id,
                analysisRunId,
                credits: creditCost,
                reason: 'analysis-succeeded',
            });
            await markSettlementComplete({
                jobId: job.id,
                analysisRunId: run.id,
                consumedCredits: creditCost,
            });
        } catch (error) {
            await recordSettlementPending({
                jobId: job.id,
                analysisRunId,
                action: 'consume',
                error,
            });
            return {
                jobId: job.id,
                gameId: job.gameId,
                status: 'SUCCEEDED',
                trainingMoments: trainingMomentsForGame.length,
                settlementPending: true,
                error: errorMessage(error),
            };
        }
        return {
            jobId: job.id,
            gameId: job.gameId,
            status: 'SUCCEEDED',
            trainingMoments: trainingMomentsForGame.length,
        };
    } catch (error) {
        if (error instanceof StaleAnalysisDeliveryError) throw error;
        if (completionCommitted) {
            await recordSettlementPending({
                jobId: running.id,
                analysisRunId,
                action: 'consume',
                error,
            });
            return {
                jobId: running.id,
                gameId: running.gameId,
                status: 'SUCCEEDED',
                trainingMoments: 0,
                settlementPending: true,
                error: errorMessage(error),
            };
        }

        const updated = await markAnalysisJobFailed(running.id, fence, error);
        if (!updated) throw new StaleAnalysisDeliveryError(running.id);
        if (updated.status === 'QUEUED') {
            return {
                jobId: running.id,
                gameId: running.gameId,
                status: 'RETRY_SCHEDULED',
                trainingMoments: 0,
                error: errorMessage(error),
                retryAt: updated.scheduledFor ?? undefined,
            };
        }

        let settlementPending = false;
        if (running) {
            try {
                await releaseAnalysisJobReservation({
                    userId: running.userId,
                    gameId: running.gameId,
                    analysisJobId: running.id,
                    analysisRunId,
                    credits: creditCost,
                    reason: 'analysis-failed',
                });
            } catch (settlementError) {
                settlementPending = true;
                await recordSettlementPending({
                    jobId: running.id,
                    analysisRunId,
                    action: 'release',
                    error: settlementError,
                });
            }
        }
        await recordAnalysisFailed({
            userId: running.userId,
            jobId: running.id,
            gameId: running.gameId,
            error: errorMessage(error),
        }).catch((notificationError) => {
            console.error('[notifications] analysis failure event was not recorded', notificationError);
        });
        return {
            jobId: running.id,
            gameId: running.gameId,
            status: 'FAILED',
            trainingMoments: 0,
            error: errorMessage(error),
            settlementPending,
        };
    } finally {
        engine?.terminate();
    }
}

async function rejectStaleAnalysisDelivery(jobId: string): Promise<never> {
    await recordStaleAnalysisDelivery();
    throw new StaleAnalysisDeliveryError(jobId);
}

async function consumeAnalysisJobReservation(args: {
    userId: string;
    gameId: string;
    analysisJobId: string;
    analysisRunId: string | null;
    credits: number;
    reason: string;
}) {
    await consumeServerAnalysisCredits({
        userId: args.userId,
        gameId: args.gameId,
        analysisJobId: args.analysisJobId,
        analysisRunId: args.analysisRunId,
        credits: args.credits,
        idempotencyKey: ledgerIdempotencyKey(args, 'consume'),
        reason: args.reason,
    });
}

async function releaseAnalysisJobReservation(args: {
    userId: string;
    gameId: string;
    analysisJobId: string;
    analysisRunId: string | null;
    credits: number;
    reason: string;
}) {
    if (!args.analysisRunId) {
        throw new Error('Analysis run is required for credit release');
    }
    await releaseServerAnalysisCreditsAndMarkRunReleased({
        userId: args.userId,
        gameId: args.gameId,
        analysisJobId: args.analysisJobId,
        analysisRunId: args.analysisRunId,
        credits: args.credits,
        idempotencyKey: ledgerIdempotencyKey(args, 'release'),
        reason: args.reason,
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

async function markSettlementComplete(args: {
    jobId: string;
    analysisRunId: string;
    consumedCredits: number;
}) {
    await prisma.$transaction(async (tx) => {
        await tx.analysisJob.updateMany({
            where: {
                id: args.jobId,
                status: 'SUCCEEDED',
                analysisRunId: args.analysisRunId,
                lastError: { startsWith: 'CREDIT_SETTLEMENT_PENDING:' },
            },
            data: { lastError: null },
        });
        await tx.analysisRun.updateMany({
            where: {
                id: args.analysisRunId,
                status: 'SUCCEEDED',
            },
            data: {
                consumedCredits: args.consumedCredits,
                lastError: null,
            },
        });
    });
}

async function recordSettlementPending(args: {
    jobId: string;
    analysisRunId: string | null;
    action: 'consume' | 'release';
    error: unknown;
}) {
    const message = `CREDIT_SETTLEMENT_PENDING:${args.action}:${errorMessage(
        args.error
    ).slice(0, 1_800)}`;
    await prisma.$transaction(async (tx) => {
        await tx.analysisJob.updateMany({
            where: {
                id: args.jobId,
                status: { in: ['SUCCEEDED', 'FAILED'] },
            },
            data: { lastError: message },
        });
        if (args.analysisRunId) {
            await tx.analysisRun.updateMany({
                where: {
                    id: args.analysisRunId,
                    status: { in: ['SUCCEEDED', 'FAILED'] },
                },
                data: { lastError: message },
            });
        }
    });
    console.error(
        JSON.stringify({
            event: 'analysis_credit_settlement_pending',
            action: args.action,
            jobId: args.jobId,
            analysisRunId: args.analysisRunId,
            error: errorMessage(args.error),
        })
    );
}
