import { Prisma, type AnalysisJob } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    createAnalysisDispatchToken,
    type AnalysisDispatchFence,
} from '@/lib/services/analysisDispatchFence';
import { releaseServerAnalysisCreditsAndMarkRunReleased } from '@/lib/services/billingAccounts';
import {
    DEFAULT_ANALYSIS_JOB_LEASE_MS,
    DEFAULT_ANALYSIS_RETRY_BACKOFF_BASE_MS,
    DEFAULT_ANALYSIS_RETRY_BACKOFF_MAX_MS,
    DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS,
    getAnalysisRetryScheduledFor,
    getAnalysisJobLockedUntil,
} from '@/lib/services/analysisJobLeases';
import { stageAnalysisOutboxMessage } from '@/lib/services/analysisOutbox';
import { recordAnalysisFailed } from '@/lib/notifications/service';
export { cancelUnexecutableAnalysisJobs } from '@/lib/services/analysisQueueCancellation';

export const DEFAULT_ANALYSIS_DISPATCH_GLOBAL_LIMIT = 25;
export const DEFAULT_ANALYSIS_DISPATCH_PER_USER_LIMIT = 1;
export const DEFAULT_ANALYSIS_DISPATCH_SCAN_LIMIT = 2_500;
export const DEFAULT_ANALYSIS_DISPATCH_USER_SCAN_LIMIT = 1_000;
export const DEFAULT_ANALYSIS_RECOVERY_SCAN_LIMIT = 500;

export type AnalysisDispatchCandidate = Pick<
    AnalysisJob,
    | 'id'
    | 'userId'
    | 'gameId'
    | 'status'
    | 'priority'
    | 'attempts'
    | 'dispatchedCount'
    | 'lockedAt'
    | 'lockedUntil'
    | 'queuedReason'
    | 'createdAt'
    | 'updatedAt'
> & {
    scheduledFor?: Date | null;
};

export type UserDispatchCounts =
    | ReadonlyMap<string, number>
    | Readonly<Record<string, number>>;

export type AnalysisDispatchPlanOptions = {
    globalLimit?: number;
    perUserLimit?: number;
    now?: Date;
    runningByUser?: UserDispatchCounts;
    dispatchedByUser?: UserDispatchCounts;
    includeLockedJobs?: boolean;
    leaseMs?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
};

export type AnalysisDispatchPlan = {
    selectedJobs: AnalysisDispatchCandidate[];
    selectedJobIds: string[];
    selectedByUser: Record<string, number>;
    skipped: {
        locked: number;
        scheduledForLater: number;
        retryBackoff: number;
        perUserLimit: number;
        notQueued: number;
    };
};

export type ClaimNextAnalysisJobsOptions = AnalysisDispatchPlanOptions & {
    candidateLimit?: number;
    userScanLimit?: number;
    userIds?: string[];
};

export type ClaimNextAnalysisJobsResult = AnalysisDispatchPlan & {
    claimedJobs: AnalysisDispatchCandidate[];
    claimedJobIds: string[];
    claimMisses: string[];
};

export type RecoverExpiredAnalysisJobsResult = {
    requeued: number;
    failed: number;
    releasedReservations: number;
    settlementErrors: Array<{ jobId: string; error: string }>;
};

export type AnalysisDispatchPublishResult = {
    jobId: string;
    queued: boolean;
    messageId: string | null;
    dispatchToken: string;
    unavailableReason?: 'disabled' | 'publish-failed';
    error?: unknown;
};

export type DispatchQueuedAnalysisJobsOptions = ClaimNextAnalysisJobsOptions & {
    releaseUnpublishedLocks?: boolean;
    throwOnPublishError?: boolean;
};

export type DispatchQueuedAnalysisJobsResult = ClaimNextAnalysisJobsResult & {
    published: AnalysisDispatchPublishResult[];
};

type MutableUserQueues = Map<string, AnalysisDispatchCandidate[]>;

export function planAnalysisDispatch(args: {
    jobs: AnalysisDispatchCandidate[];
    options?: AnalysisDispatchPlanOptions;
}): AnalysisDispatchPlan {
    const now = args.options?.now ?? new Date();
    const globalLimit = normalizeLimit(
        args.options?.globalLimit,
        DEFAULT_ANALYSIS_DISPATCH_GLOBAL_LIMIT
    );
    const perUserLimit = normalizeLimit(
        args.options?.perUserLimit,
        DEFAULT_ANALYSIS_DISPATCH_PER_USER_LIMIT
    );
    const runningByUser = normalizeCounts(args.options?.runningByUser);
    const dispatchedByUser = normalizeCounts(args.options?.dispatchedByUser);
    const skipped = {
        locked: 0,
        scheduledForLater: 0,
        retryBackoff: 0,
        perUserLimit: 0,
        notQueued: 0,
    };

    if (globalLimit <= 0 || perUserLimit <= 0) {
        return {
            selectedJobs: [],
            selectedJobIds: [],
            selectedByUser: {},
            skipped: {
                ...skipped,
                perUserLimit: args.jobs.length,
            },
        };
    }

    const queues: MutableUserQueues = new Map();
    for (const job of args.jobs) {
        if (job.status !== 'QUEUED') {
            skipped.notQueued += 1;
            continue;
        }
        if (
            job.lockedUntil &&
            job.lockedUntil.getTime() > now.getTime() &&
            !args.options?.includeLockedJobs
        ) {
            skipped.locked += 1;
            continue;
        }
        if (job.scheduledFor) {
            if (job.scheduledFor.getTime() > now.getTime()) {
                skipped.scheduledForLater += 1;
                continue;
            }
        } else if (!retryBackoffElapsed(job, args.options, now)) {
            skipped.retryBackoff += 1;
            continue;
        }

        const userId = job.userId;
        const current =
            (runningByUser.get(userId) ?? 0) +
            (dispatchedByUser.get(userId) ?? 0);
        if (current >= perUserLimit) {
            skipped.perUserLimit += 1;
            continue;
        }

        const userQueue = queues.get(userId) ?? [];
        userQueue.push(job);
        queues.set(userId, userQueue);
    }

    for (const queue of queues.values()) {
        queue.sort(compareAnalysisDispatchCandidates);
    }

    const selectedJobs: AnalysisDispatchCandidate[] = [];
    const selectedByUser: Record<string, number> = {};

    while (selectedJobs.length < globalLimit) {
        const activeUsers = Array.from(queues.entries())
            .filter(([userId, queue]) => {
                if (queue.length === 0) return false;
                const current =
                    (runningByUser.get(userId) ?? 0) +
                    (dispatchedByUser.get(userId) ?? 0) +
                    (selectedByUser[userId] ?? 0);
                return current < perUserLimit;
            })
            .sort(([, leftQueue], [, rightQueue]) =>
                compareAnalysisDispatchCandidates(leftQueue[0], rightQueue[0])
            );

        if (activeUsers.length === 0) break;

        for (const [userId, queue] of activeUsers) {
            if (selectedJobs.length >= globalLimit) break;
            const current =
                (runningByUser.get(userId) ?? 0) +
                (dispatchedByUser.get(userId) ?? 0) +
                (selectedByUser[userId] ?? 0);
            if (current >= perUserLimit) continue;

            const job = queue.shift();
            if (!job) continue;
            selectedJobs.push(job);
            selectedByUser[userId] = (selectedByUser[userId] ?? 0) + 1;
        }
    }

    return {
        selectedJobs,
        selectedJobIds: selectedJobs.map((job) => job.id),
        selectedByUser,
        skipped,
    };
}

export async function claimNextAnalysisJobs(
    options: ClaimNextAnalysisJobsOptions = {}
): Promise<ClaimNextAnalysisJobsResult> {
    const now = options.now ?? new Date();
    await recoverExpiredAnalysisJobs({ now });
    const globalLimit = normalizeLimit(
        options.globalLimit,
        DEFAULT_ANALYSIS_DISPATCH_GLOBAL_LIMIT
    );
    const userScanLimit = normalizeLimit(
        options.userScanLimit,
        DEFAULT_ANALYSIS_DISPATCH_USER_SCAN_LIMIT
    );
    const requestedUserIds = Array.from(
        new Set((options.userIds ?? []).filter(Boolean))
    );
    const candidateUsers = await prisma.analysisJob.findMany({
        where: {
            status: 'QUEUED',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
            AND: [
                {
                    OR: [
                        { scheduledFor: null },
                        { scheduledFor: { lte: now } },
                    ],
                },
            ],
            ...(requestedUserIds.length > 0
                ? { userId: { in: requestedUserIds } }
                : {}),
        },
        distinct: ['userId'],
        orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }],
        take: userScanLimit,
        select: { userId: true },
    });
    const claimedJobs: AnalysisDispatchCandidate[] = [];
    const claimMisses: string[] = [];
    for (const candidate of candidateUsers) {
        if (claimedJobs.length >= globalLimit) break;
        const job = await claimOneAnalysisJobForUser({
            userId: candidate.userId,
            now,
            leaseMs: options.leaseMs ?? DEFAULT_ANALYSIS_JOB_LEASE_MS,
            stageOutbox: false,
        });
        if (job) claimedJobs.push(job);
        else claimMisses.push(candidate.userId);
    }

    return {
        selectedJobs: claimedJobs,
        selectedJobIds: claimedJobs.map((job) => job.id),
        selectedByUser: Object.fromEntries(
            claimedJobs.map((job) => [job.userId, 1])
        ),
        skipped: {
            locked: 0,
            scheduledForLater: 0,
            retryBackoff: 0,
            perUserLimit: claimMisses.length,
            notQueued: 0,
        },
        claimedJobs,
        claimedJobIds: claimedJobs.map((job) => job.id),
        claimMisses,
    };
}

export async function recoverExpiredAnalysisJobs(args: {
    now?: Date;
    limit?: number;
    maxAttempts?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
} = {}): Promise<RecoverExpiredAnalysisJobsResult> {
    const now = args.now ?? new Date();
    const maxAttempts =
        args.maxAttempts ?? DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS;
    const expired = await prisma.analysisJob.findMany({
        where: {
            status: 'RUNNING',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        orderBy: [{ lockedUntil: 'asc' }, { updatedAt: 'asc' }],
        take: args.limit ?? DEFAULT_ANALYSIS_RECOVERY_SCAN_LIMIT,
        select: {
            id: true,
            userId: true,
            gameId: true,
            analysisRunId: true,
            analysisRun: { select: { creditCost: true } },
            attempts: true,
            lockedAt: true,
            dispatchedCount: true,
        },
    });

    let requeued = 0;
    let failed = 0;
    let releasedReservations = 0;
    const settlementErrors: RecoverExpiredAnalysisJobsResult['settlementErrors'] =
        [];
    for (const job of expired) {
        if (job.attempts >= maxAttempts) {
            const result = await prisma.$transaction(async (tx) => {
                const updated = await tx.analysisJob.updateMany({
                    where: {
                        id: job.id,
                        status: 'RUNNING',
                        lockedAt: job.lockedAt,
                        dispatchedCount: job.dispatchedCount,
                        OR: [
                            { lockedUntil: null },
                            { lockedUntil: { lte: now } },
                        ],
                    },
                    data: {
                        status: 'FAILED',
                        lockedAt: null,
                        lockedUntil: null,
                        completedAt: now,
                        lastError:
                            'Analysis job lease expired after maximum attempts',
                    },
                });
                if (updated.count === 1 && job.analysisRunId) {
                    await tx.analysisRun.updateMany({
                        where: {
                            id: job.analysisRunId,
                            status: { in: ['QUEUED', 'RUNNING'] },
                        },
                        data: {
                            status: 'FAILED',
                            completedAt: now,
                            consumedCredits: null,
                            lastError:
                                'Analysis job lease expired after maximum attempts',
                        },
                    });
                    await tx.analysisRunCheckpoint.deleteMany({
                        where: { runId: job.analysisRunId },
                    });
                }
                return updated;
            });
            failed += result.count;
            if (result.count === 1) {
                try {
                    if (!job.analysisRunId) {
                        throw new Error(
                            'Analysis run is required for credit release'
                        );
                    }
                    await releaseServerAnalysisCreditsAndMarkRunReleased({
                        userId: job.userId,
                        gameId: job.gameId,
                        analysisJobId: job.id,
                        analysisRunId: job.analysisRunId,
                        credits: job.analysisRun.creditCost,
                        idempotencyKey: job.analysisRunId
                            ? `analysis-run:${job.analysisRunId}:release`
                            : `analysis-job:${job.id}:release`,
                        reason: 'analysis-max-attempts-exhausted',
                    });
                    releasedReservations += 1;
                } catch (error) {
                    settlementErrors.push({
                        jobId: job.id,
                        error: errorMessage(error),
                    });
                    await recordAnalysisReleaseSettlementPending({
                        jobId: job.id,
                        analysisRunId: job.analysisRunId,
                        error,
                    });
                    console.error(
                        JSON.stringify({
                            event: 'analysis_credit_settlement_failed',
                            action: 'release',
                            jobId: job.id,
                            analysisRunId: job.analysisRunId,
                            reason: 'analysis-max-attempts-exhausted',
                            error: structuredError(error),
                        })
                    );
                }
                try {
                    await recordAnalysisFailed({
                        userId: job.userId,
                        jobId: job.id,
                        gameId: job.gameId,
                        error: 'Analysis job lease expired after maximum attempts',
                    });
                } catch (notificationError) {
                    console.error(
                        JSON.stringify({
                            event: 'analysis_failure_notification_failed',
                            jobId: job.id,
                            analysisRunId: job.analysisRunId,
                            error: structuredError(notificationError),
                        })
                    );
                }
            }
            continue;
        }

        const result = await prisma.$transaction(async (tx) => {
            const updated = await tx.analysisJob.updateMany({
                where: {
                    id: job.id,
                    status: 'RUNNING',
                    lockedAt: job.lockedAt,
                    dispatchedCount: job.dispatchedCount,
                    OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
                },
                data: {
                    status: 'QUEUED',
                    lockedAt: null,
                    lockedUntil: null,
                    completedAt: null,
                    scheduledFor: getAnalysisRetryScheduledFor({
                        attempts: Math.max(1, job.attempts),
                        now,
                        retryBackoffBaseMs: args.retryBackoffBaseMs,
                        retryBackoffMaxMs: args.retryBackoffMaxMs,
                    }),
                    lastError: 'Analysis job lease expired and was requeued',
                },
            });
            if (updated.count === 1 && job.analysisRunId) {
                await tx.analysisRun.updateMany({
                    where: {
                        id: job.analysisRunId,
                        status: 'RUNNING',
                    },
                    data: {
                        status: 'QUEUED',
                        completedAt: null,
                        lastError:
                            'Analysis job lease expired and was requeued',
                    },
                });
            }
            return updated;
        });
        requeued += result.count;
    }

    return { requeued, failed, releasedReservations, settlementErrors };
}

async function recordAnalysisReleaseSettlementPending(args: {
    jobId: string;
    analysisRunId: string;
    error: unknown;
}) {
    const message = `CREDIT_SETTLEMENT_PENDING:release:${errorMessage(
        args.error
    ).slice(0, 1_800)}`;
    await prisma.$transaction(async (tx) => {
        await tx.analysisJob.updateMany({
            where: {
                id: args.jobId,
                analysisRunId: args.analysisRunId,
                status: 'FAILED',
            },
            data: { lastError: message },
        });
        await tx.analysisRun.updateMany({
            where: {
                id: args.analysisRunId,
                status: 'FAILED',
            },
            data: { lastError: message },
        });
    });
}

export async function dispatchQueuedAnalysisJobs(
    options: DispatchQueuedAnalysisJobsOptions = {}
): Promise<DispatchQueuedAnalysisJobsResult> {
    const now = options.now ?? new Date();
    await recoverExpiredAnalysisJobs({ now });
    const globalLimit = normalizeLimit(
        options.globalLimit,
        DEFAULT_ANALYSIS_DISPATCH_GLOBAL_LIMIT
    );
    const userScanLimit = normalizeLimit(
        options.userScanLimit,
        DEFAULT_ANALYSIS_DISPATCH_USER_SCAN_LIMIT
    );
    const requestedUserIds = Array.from(
        new Set((options.userIds ?? []).filter(Boolean))
    );
    const candidateUsers = await prisma.analysisJob.findMany({
        where: {
            status: 'QUEUED',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
            AND: [
                {
                    OR: [
                        { scheduledFor: null },
                        { scheduledFor: { lte: now } },
                    ],
                },
            ],
            ...(requestedUserIds.length > 0
                ? { userId: { in: requestedUserIds } }
                : {}),
        },
        distinct: ['userId'],
        orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }],
        take: userScanLimit,
        select: { userId: true },
    });

    const claimedJobs: AnalysisDispatchCandidate[] = [];
    for (const { userId } of candidateUsers) {
        if (claimedJobs.length >= globalLimit) break;
        const claimed = await claimOneAnalysisJobForUser({
            userId,
            now,
            leaseMs: options.leaseMs ?? DEFAULT_ANALYSIS_JOB_LEASE_MS,
            stageOutbox: true,
        });
        if (claimed) claimedJobs.push(claimed);
    }

    const published: AnalysisDispatchPublishResult[] = [];
    for (const job of claimedJobs) {
        if (!job.lockedAt) {
            throw new Error(`Claimed analysis job ${job.id} has no dispatch lock`);
        }
        const dispatchToken = createAnalysisDispatchToken({
            jobId: job.id,
            lockedAt: job.lockedAt,
            dispatchedCount: job.dispatchedCount,
        });
        // The durable outbox was committed in the same transaction as the job
        // lease. `queued` here means durably staged, not remotely published.
        published.push({
            jobId: job.id,
            queued: true,
            messageId: null,
            dispatchToken,
        });
    }

    return {
        selectedJobs: claimedJobs,
        selectedJobIds: claimedJobs.map((job) => job.id),
        selectedByUser: Object.fromEntries(
            claimedJobs.map((job) => [job.userId, 1])
        ),
        skipped: {
            locked: 0,
            scheduledForLater: 0,
            retryBackoff: 0,
            perUserLimit: Math.max(0, candidateUsers.length - claimedJobs.length),
            notQueued: 0,
        },
        claimedJobs,
        claimedJobIds: claimedJobs.map((job) => job.id),
        claimMisses: candidateUsers
            .map((candidate) => candidate.userId)
            .filter(
                (userId) => !claimedJobs.some((job) => job.userId === userId)
            ),
        published,
    };
}

async function claimOneAnalysisJobForUser(args: {
    userId: string;
    now: Date;
    leaseMs: number;
    stageOutbox: boolean;
}) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw(
            Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`analysis-dispatch:${args.userId}`}, 0))`
        );

        const active = await tx.analysisJob.count({
            where: {
                userId: args.userId,
                lockedUntil: { gt: args.now },
                OR: [{ status: 'RUNNING' }, { status: 'QUEUED' }],
            },
        });
        if (active >= 1) return null;

        const jobs = await tx.analysisJob.findMany({
            where: {
                userId: args.userId,
                status: 'QUEUED',
                OR: [{ lockedUntil: null }, { lockedUntil: { lte: args.now } }],
                AND: [
                    {
                        OR: [
                            { scheduledFor: null },
                            { scheduledFor: { lte: args.now } },
                        ],
                    },
                ],
            },
            orderBy: [{ createdAt: 'asc' }],
            take: 100,
        });
        const job = jobs.sort(compareAnalysisDispatchCandidates)[0];
        if (!job) return null;

        const lockedUntil = getAnalysisJobLockedUntil({
            now: args.now,
            leaseMs: args.leaseMs,
        });
        const updated = await tx.analysisJob.updateMany({
            where: {
                id: job.id,
                status: 'QUEUED',
                OR: [{ lockedUntil: null }, { lockedUntil: { lte: args.now } }],
            },
            data: {
                lockedAt: args.now,
                lockedUntil,
                lastDispatchedAt: args.now,
                dispatchedCount: { increment: 1 },
            },
        });
        if (updated.count !== 1) return null;

        const claimed: AnalysisDispatchCandidate = {
            ...job,
            dispatchedCount: job.dispatchedCount + 1,
            lockedAt: args.now,
            lockedUntil,
        };
        const dispatchToken = createAnalysisDispatchToken({
            jobId: claimed.id,
            lockedAt: args.now,
            dispatchedCount: claimed.dispatchedCount,
        });
        if (args.stageOutbox) {
            await stageAnalysisOutboxMessage({
                tx,
                kind: 'ANALYSIS_JOB',
                idempotencyKey: analysisDispatchIdempotencyKey(claimed),
                analysisJobId: claimed.id,
                message: {
                    type: 'analysis-job',
                    jobId: claimed.id,
                    dispatchToken,
                },
            });
        }
        return claimed;
    });
}

export async function releaseAnalysisDispatchLocks(
    jobIds: string[],
    reason?: string
) {
    const ids = Array.from(new Set(jobIds.filter(Boolean)));
    if (ids.length === 0) return { count: 0 };
    return prisma.analysisJob.updateMany({
        where: {
            id: { in: ids },
            status: 'QUEUED',
        },
        data: {
            lockedAt: null,
            lockedUntil: null,
            ...(reason ? { lastError: reason.slice(0, 2_000) } : {}),
        },
    });
}

export function analysisDispatchIdempotencyKey(
    job: Pick<
        AnalysisDispatchCandidate,
        'id' | 'gameId' | 'dispatchedCount'
    >
) {
    return `analysis:${job.gameId}:${job.id}:delivery:${job.dispatchedCount}`;
}

export function analysisFenceWhere(
    jobId: string,
    fence: AnalysisDispatchFence
) {
    return {
        id: jobId,
        lockedAt: fence.lockedAt,
        dispatchedCount: fence.dispatchedCount,
    };
}

export function compareAnalysisDispatchCandidates(
    left: AnalysisDispatchCandidate,
    right: AnalysisDispatchCandidate
) {
    const reasonDiff =
        queuedReasonRank(left.queuedReason) - queuedReasonRank(right.queuedReason);
    if (reasonDiff !== 0) return reasonDiff;

    const createdDiff = left.createdAt.getTime() - right.createdAt.getTime();
    if (createdDiff !== 0) return createdDiff;

    const priorityDiff = right.priority - left.priority;
    if (priorityDiff !== 0) return priorityDiff;

    return left.id.localeCompare(right.id);
}

function queuedReasonRank(reason: string | null) {
    if (reason === 'manual' || reason === 'manual-reanalysis') return 0;
    if (reason === 'auto-sync') return 2;
    return 1;
}

function retryBackoffElapsed(
    job: AnalysisDispatchCandidate,
    options: AnalysisDispatchPlanOptions | undefined,
    now: Date
) {
    const baseMs =
        options?.retryBackoffBaseMs ?? DEFAULT_ANALYSIS_RETRY_BACKOFF_BASE_MS;
    if (baseMs <= 0 || job.attempts <= 0) return true;

    const maxMs =
        options?.retryBackoffMaxMs ?? DEFAULT_ANALYSIS_RETRY_BACKOFF_MAX_MS;
    const backoffMs = Math.min(
        maxMs,
        baseMs * 2 ** Math.max(0, job.attempts - 1)
    );
    return job.updatedAt.getTime() + backoffMs <= now.getTime();
}

function normalizeLimit(value: number | undefined, fallback: number) {
    if (value == null || !Number.isFinite(value)) return fallback;
    return Math.max(0, Math.trunc(value));
}

function normalizeCounts(counts: UserDispatchCounts | undefined) {
    if (!counts) return new Map<string, number>();
    if (counts instanceof Map) return new Map(counts);
    return new Map(Object.entries(counts));
}

function errorMessage(error: unknown) {
    return error instanceof Error
        ? error.message.slice(0, 2_000)
        : String(error).slice(0, 2_000);
}

function structuredError(error: unknown) {
    if (!(error instanceof Error)) {
        return { message: String(error).slice(0, 2_000) };
    }
    return {
        name: error.name.slice(0, 200),
        message: error.message.slice(0, 2_000),
        ...(error.stack ? { stack: error.stack.slice(0, 8_000) } : {}),
        ...(error.cause != null
            ? {
                  cause:
                      error.cause instanceof Error
                          ? {
                                name: error.cause.name.slice(0, 200),
                                message: error.cause.message.slice(0, 2_000),
                            }
                          : String(error.cause).slice(0, 2_000),
              }
            : {}),
    };
}
