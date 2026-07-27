import { prisma } from '@/lib/prisma';

export type AnalysisOpsSnapshot = {
    analysisJobs: {
        queued: number;
        running: number;
        failed: number;
        lockedQueued: number;
        stuckRunning: number;
        oldestQueuedAgeSeconds: number | null;
        oldestRunningAgeSeconds: number | null;
        recentErrors: Array<{ id: string; gameId: string | null; error: string }>;
    };
    syncJobs: {
        queued: number;
        running: number;
        failed: number;
        stuckRunning: number;
        oldestQueuedAgeSeconds: number | null;
        oldestRunningAgeSeconds: number | null;
        recentErrors: Array<{ id: string; provider: string; error: string }>;
    };
    credits: {
        reserved: number;
        consumed: number;
        refunded: number;
        released: number;
    };
    stripeWebhooks: {
        processing: number;
        succeeded: number;
        failed: number;
        recentErrors: Array<{ id: string; type: string; error: string }>;
    };
};

export async function getAnalysisOpsSnapshot(args: { now?: Date } = {}) {
    const now = args.now ?? new Date();
    const [
        queued,
        running,
        failed,
        lockedQueued,
        stuckRunning,
        syncQueued,
        syncRunning,
        syncFailed,
        syncStuckRunning,
        oldestQueuedAnalysisJob,
        oldestRunningAnalysisJob,
        recentAnalysisErrors,
        oldestQueuedSyncJob,
        oldestRunningSyncJob,
        recentSyncErrors,
        stripeProcessing,
        stripeSucceeded,
        stripeFailed,
        recentStripeErrors,
        creditRows,
    ] = await Promise.all([
        prisma.analysisJob.count({ where: { status: 'QUEUED' } }),
        prisma.analysisJob.count({ where: { status: 'RUNNING' } }),
        prisma.analysisJob.count({ where: { status: 'FAILED' } }),
        prisma.analysisJob.count({
            where: { status: 'QUEUED', lockedUntil: { gt: now } },
        }),
        prisma.analysisJob.count({
            where: { status: 'RUNNING', lockedUntil: { lt: now } },
        }),
        prisma.syncJob.count({ where: { status: 'QUEUED' } }),
        prisma.syncJob.count({ where: { status: 'RUNNING' } }),
        prisma.syncJob.count({ where: { status: 'FAILED' } }),
        prisma.syncJob.count({
            where: { status: 'RUNNING', lockedUntil: { lt: now } },
        }),
        prisma.analysisJob.findFirst({
            where: { status: 'QUEUED' },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
        }),
        prisma.analysisJob.findFirst({
            where: { status: 'RUNNING' },
            orderBy: [{ startedAt: 'asc' }, { lockedAt: 'asc' }],
            select: { startedAt: true, lockedAt: true },
        }),
        prisma.analysisJob.findMany({
            where: { lastError: { not: null } },
            orderBy: { updatedAt: 'desc' },
            take: 5,
            select: { id: true, gameId: true, lastError: true },
        }),
        prisma.syncJob.findFirst({
            where: { status: 'QUEUED' },
            orderBy: { createdAt: 'asc' },
            select: { createdAt: true },
        }),
        prisma.syncJob.findFirst({
            where: { status: 'RUNNING' },
            orderBy: [{ startedAt: 'asc' }, { lockedUntil: 'asc' }],
            select: { startedAt: true, lockedUntil: true },
        }),
        prisma.syncJob.findMany({
            where: { lastError: { not: null } },
            orderBy: { updatedAt: 'desc' },
            take: 5,
            select: { id: true, provider: true, lastError: true },
        }),
        prisma.stripeWebhookEvent.count({ where: { status: 'PROCESSING' } }),
        prisma.stripeWebhookEvent.count({ where: { status: 'SUCCEEDED' } }),
        prisma.stripeWebhookEvent.count({ where: { status: 'FAILED' } }),
        prisma.stripeWebhookEvent.findMany({
            where: { status: 'FAILED' },
            orderBy: { updatedAt: 'desc' },
            take: 5,
            select: { id: true, type: true, lastError: true },
        }),
        prisma.creditLedgerEntry.groupBy({
            by: ['type'],
            _sum: { credits: true },
        }),
    ]);

    const credits = {
        reserved: 0,
        consumed: 0,
        refunded: 0,
        released: 0,
    };
    for (const row of creditRows) {
        const value = row._sum.credits ?? 0;
        if (row.type === 'RESERVED') credits.reserved = value;
        if (row.type === 'CONSUMED') credits.consumed = value;
        if (row.type === 'REFUNDED') credits.refunded = value;
        if (row.type === 'RELEASED') credits.released = value;
    }

    return {
        analysisJobs: {
            queued,
            running,
            failed,
            lockedQueued,
            stuckRunning,
            oldestQueuedAgeSeconds: ageSeconds(
                oldestQueuedAnalysisJob?.createdAt,
                now
            ),
            oldestRunningAgeSeconds: ageSeconds(
                oldestRunningAnalysisJob?.startedAt ??
                    oldestRunningAnalysisJob?.lockedAt,
                now
            ),
            recentErrors: recentAnalysisErrors.map((job) => ({
                id: job.id,
                gameId: job.gameId,
                error: job.lastError ?? '',
            })),
        },
        syncJobs: {
            queued: syncQueued,
            running: syncRunning,
            failed: syncFailed,
            stuckRunning: syncStuckRunning,
            oldestQueuedAgeSeconds: ageSeconds(oldestQueuedSyncJob?.createdAt, now),
            oldestRunningAgeSeconds: ageSeconds(
                oldestRunningSyncJob?.startedAt ??
                    oldestRunningSyncJob?.lockedUntil,
                now
            ),
            recentErrors: recentSyncErrors.map((job) => ({
                id: job.id,
                provider: job.provider,
                error: job.lastError ?? '',
            })),
        },
        credits,
        stripeWebhooks: {
            processing: stripeProcessing,
            succeeded: stripeSucceeded,
            failed: stripeFailed,
            recentErrors: recentStripeErrors.map((event) => ({
                id: event.id,
                type: event.type,
                error: event.lastError ?? '',
            })),
        },
    } satisfies AnalysisOpsSnapshot;
}

function ageSeconds(date: Date | null | undefined, now: Date) {
    if (!date) return null;
    return Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1_000));
}
