import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    consumeServerAnalysisCreditsInTransaction,
    releaseServerAnalysisCreditsInTransaction,
} from '@/lib/services/billingAccounts';
import { summarizeCreditLedgerEntries } from '@/lib/services/creditLedger';

export class GameDeletionNotFoundError extends Error {
    constructor() {
        super('Game not found');
        this.name = 'GameDeletionNotFoundError';
    }
}

export class GameDeletionSettlementError extends Error {
    constructor(options?: ErrorOptions) {
        super('Analysis credit settlement failed', options);
        this.name = 'GameDeletionSettlementError';
    }
}

export class GameDeletionConflictError extends Error {
    constructor() {
        super('Game changed concurrently during deletion');
        this.name = 'GameDeletionConflictError';
    }
}

export type SafeGameDeletionResult = {
    cancelledJobs: number;
    consumedReservations: number;
    releasedReservations: number;
};

export async function deleteOwnedGameSafely(args: {
    userId: string;
    gameId: string;
}): Promise<SafeGameDeletionResult> {
    return prisma.$transaction(
        async (tx) => {
            const game = await tx.analyzedGame.findFirst({
                where: { id: args.gameId, userId: args.userId },
                select: { id: true },
            });
            if (!game) throw new GameDeletionNotFoundError();

            const jobs = await tx.analysisJob.findMany({
                where: {
                    gameId: game.id,
                    userId: args.userId,
                },
                select: {
                    id: true,
                    status: true,
                    analysisRunId: true,
                    lastError: true,
                    creditLedgerEntries: {
                        select: { type: true, credits: true },
                    },
                },
            });
            const result: SafeGameDeletionResult = {
                cancelledJobs: 0,
                consumedReservations: 0,
                releasedReservations: 0,
            };
            const completedAt = new Date();

            for (const job of jobs) {
                const isActive =
                    job.status === 'QUEUED' || job.status === 'RUNNING';
                const summary = summarizeCreditLedgerEntries(
                    job.creditLedgerEntries
                );
                const action =
                    !isActive &&
                    job.status === 'SUCCEEDED' &&
                    !job.lastError?.startsWith(
                        'CREDIT_SETTLEMENT_PENDING:release:'
                    )
                        ? 'consume'
                        : 'release';

                if (isActive) {
                    await tx.analysisJob.update({
                        where: { id: job.id },
                        data: {
                            status: 'CANCELLED',
                            lockedAt: null,
                            lockedUntil: null,
                            completedAt,
                            lastError: null,
                        },
                    });
                    if (job.analysisRunId) {
                        await tx.analysisRun.updateMany({
                            where: {
                                id: job.analysisRunId,
                                status: { in: ['QUEUED', 'RUNNING'] },
                            },
                            data: {
                                status: 'CANCELLED',
                                completedAt,
                                consumedCredits: 0,
                                lastError: null,
                            },
                        });
                    }
                    result.cancelledJobs += 1;
                }

                if (summary.outstandingReserved > 0) {
                    const creditArgs = {
                        tx,
                        userId: args.userId,
                        gameId: game.id,
                        analysisJobId: job.id,
                        analysisRunId: job.analysisRunId,
                        credits: summary.outstandingReserved,
                        idempotencyKey: job.analysisRunId
                            ? `analysis-run:${job.analysisRunId}:${action}`
                            : `analysis-job:${job.id}:${action}`,
                        reason: 'game-deleted',
                        metadata: {
                            deletedGameId: game.id,
                            deletedAnalysisJobId: job.id,
                            settlementAction: action,
                        } satisfies Prisma.InputJsonObject,
                    };
                    try {
                        if (action === 'consume') {
                            await consumeServerAnalysisCreditsInTransaction(
                                creditArgs
                            );
                            result.consumedReservations +=
                                summary.outstandingReserved;
                        } else {
                            await releaseServerAnalysisCreditsInTransaction(
                                creditArgs
                            );
                            result.releasedReservations +=
                                summary.outstandingReserved;
                        }
                    } catch (error) {
                        throw new GameDeletionSettlementError({
                            cause: error,
                        });
                    }
                }
            }

            const deleted = await tx.analyzedGame.deleteMany({
                where: { id: game.id, userId: args.userId },
            });
            if (deleted.count !== 1) {
                throw new GameDeletionConflictError();
            }
            return result;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
}
