import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { releaseServerAnalysisCreditsInTransaction } from '@/lib/services/billingAccounts';

export async function cancelUnexecutableAnalysisJobs(args: {
    userId: string;
    jobIds: string[];
    reason: string;
}) {
    const jobIds = Array.from(new Set(args.jobIds.filter(Boolean)));
    let cancelled = 0;
    for (const jobId of jobIds) {
        const didCancel = await prisma.$transaction(async (tx) => {
            const job = await tx.analysisJob.findFirst({
                where: {
                    id: jobId,
                    userId: args.userId,
                    status: 'QUEUED',
                },
                select: {
                    id: true,
                    gameId: true,
                    analysisRunId: true,
                    analysisRun: { select: { creditCost: true } },
                },
            });
            if (!job) return false;

            const now = new Date();
            const updated = await tx.analysisJob.updateMany({
                where: {
                    id: job.id,
                    userId: args.userId,
                    status: 'QUEUED',
                },
                data: {
                    status: 'CANCELLED',
                    lockedAt: null,
                    lockedUntil: null,
                    scheduledFor: null,
                    completedAt: now,
                    lastError: args.reason.slice(0, 2_000),
                },
            });
            if (updated.count !== 1) return false;

            if (job.analysisRunId) {
                await tx.analysisRun.updateMany({
                    where: {
                        id: job.analysisRunId,
                        userId: args.userId,
                        status: 'QUEUED',
                    },
                    data: {
                        status: 'CANCELLED',
                        completedAt: now,
                        consumedCredits: 0,
                        lastError: args.reason.slice(0, 2_000),
                    },
                });
            }

            await releaseServerAnalysisCreditsInTransaction({
                tx,
                userId: args.userId,
                gameId: job.gameId,
                analysisJobId: job.id,
                analysisRunId: job.analysisRunId,
                credits: job.analysisRun.creditCost,
                idempotencyKey: job.analysisRunId
                    ? `analysis-run:${job.analysisRunId}:queue-unavailable-release`
                    : `analysis-job:${job.id}:queue-unavailable-release`,
                reason: 'queue-unavailable',
                metadata: {
                    settlement: 'release',
                    queueUnavailable: true,
                } satisfies Prisma.InputJsonObject,
            });
            return true;
        });
        if (didCancel) cancelled += 1;
    }
    return { cancelled };
}

export async function cancelUnavailableAnalysisBatch(args: {
    batchId: string;
    reason: string;
}) {
    const batch = await prisma.$transaction(async (tx) => {
        const found = await tx.analysisBatch.findUnique({
            where: { id: args.batchId },
            select: { id: true, userId: true },
        });
        if (!found) return null;

        await tx.analysisBatchItem.updateMany({
            where: {
                batchId: found.id,
                status: { in: ['PENDING', 'PLANNING'] },
            },
            data: {
                status: 'CANCELLED',
                planningToken: null,
                planningUntil: null,
                lastError: args.reason.slice(0, 2_000),
            },
        });
        const linked = await tx.analysisBatchItem.findMany({
            where: {
                batchId: found.id,
                analysisJobId: { not: null },
                status: 'QUEUED',
            },
            distinct: ['analysisJobId'],
            select: { analysisJobId: true },
        });
        return {
            ...found,
            jobIds: linked.flatMap((item) =>
                item.analysisJobId ? [item.analysisJobId] : []
            ),
        };
    });
    if (!batch) return { cancelled: 0 };

    return cancelUnexecutableAnalysisJobs({
        userId: batch.userId,
        jobIds: batch.jobIds,
        reason: args.reason,
    });
}
