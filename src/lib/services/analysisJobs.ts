import type { AnalysisJob, AnalysisJobStatus } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export type EnqueueAnalysisJobResult = {
    job: AnalysisJob;
    created: boolean;
    queued: boolean;
};

export async function enqueueAnalysisJob(args: {
    userId: string;
    gameId: string;
    queuedReason?: string;
    priority?: number;
    force?: boolean;
}): Promise<EnqueueAnalysisJobResult> {
    const existing = await prisma.analysisJob.findUnique({
        where: { gameId: args.gameId },
    });

    if (existing) {
        if (existing.status === 'SUCCEEDED' && !args.force) {
            return { job: existing, created: false, queued: false };
        }
        const job = await prisma.analysisJob.update({
            where: { id: existing.id },
            data: {
                status: 'QUEUED',
                priority: args.priority ?? existing.priority,
                lockedAt: null,
                startedAt: null,
                completedAt: null,
                lastError: null,
                queuedReason: args.queuedReason ?? existing.queuedReason,
            },
        });
        return { job, created: false, queued: true };
    }

    const job = await prisma.analysisJob.create({
        data: {
            userId: args.userId,
            gameId: args.gameId,
            priority: args.priority ?? 0,
            queuedReason: args.queuedReason,
        },
    });
    return { job, created: true, queued: true };
}

export async function enqueueAnalysisJobsForGames(args: {
    userId: string;
    gameIds: string[];
    queuedReason?: string;
    force?: boolean;
}) {
    const results: EnqueueAnalysisJobResult[] = [];
    for (const gameId of Array.from(new Set(args.gameIds.filter(Boolean)))) {
        results.push(
            await enqueueAnalysisJob({
                userId: args.userId,
                gameId,
                queuedReason: args.queuedReason,
                force: args.force,
            })
        );
    }
    return results;
}

export async function markAnalysisJobRunning(jobId: string) {
    return prisma.analysisJob.update({
        where: { id: jobId },
        data: {
            status: 'RUNNING',
            attempts: { increment: 1 },
            lockedAt: new Date(),
            startedAt: new Date(),
            lastError: null,
        },
    });
}

export async function markAnalysisJobSucceeded(jobId: string) {
    return prisma.analysisJob.update({
        where: { id: jobId },
        data: {
            status: 'SUCCEEDED',
            lockedAt: null,
            completedAt: new Date(),
            lastError: null,
        },
    });
}

export async function markAnalysisJobFailed(jobId: string, error: unknown) {
    return prisma.analysisJob.update({
        where: { id: jobId },
        data: {
            status: 'FAILED',
            lockedAt: null,
            completedAt: new Date(),
            lastError:
                error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : String(error).slice(0, 2_000),
        },
    });
}

export async function getAnalysisJobCounts(userId: string) {
    const queued = await prisma.analysisJob.count({
        where: { userId, status: 'QUEUED' },
    });
    const running = await prisma.analysisJob.count({
        where: { userId, status: 'RUNNING' },
    });
    const failed = await prisma.analysisJob.count({
        where: { userId, status: 'FAILED' },
    });
    return { queued, running, failed };
}

export function analysisJobStatusFilter(
    status: string | null
): AnalysisJobStatus | undefined {
    if (
        status === 'QUEUED' ||
        status === 'RUNNING' ||
        status === 'SUCCEEDED' ||
        status === 'FAILED' ||
        status === 'CANCELLED'
    ) {
        return status;
    }
    return undefined;
}

export function isPrismaUniqueError(error: unknown) {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
    );
}
