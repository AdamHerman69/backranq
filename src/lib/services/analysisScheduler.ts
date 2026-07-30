import type { AnalysisJob, Prisma } from '@prisma/client';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { prisma } from '@/lib/prisma';
import {
    createAnalysisDispatchToken,
    type AnalysisDispatchFence,
} from '@/lib/services/analysisDispatchFence';
import {
    releaseServerAnalysisCredits,
    releaseServerAnalysisCreditsInTransaction,
} from '@/lib/services/billingAccounts';
import {
    DEFAULT_ANALYSIS_JOB_LEASE_MS,
    DEFAULT_ANALYSIS_RETRY_BACKOFF_BASE_MS,
    DEFAULT_ANALYSIS_RETRY_BACKOFF_MAX_MS,
    DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS,
    getAnalysisRetryScheduledFor,
    getAnalysisJobLockedUntil,
} from '@/lib/services/analysisJobLeases';

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
                    estimatedCredits: true,
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
                credits: Math.max(1, Math.trunc(job.estimatedCredits)),
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
    const candidateLimit = normalizeLimit(
        options.candidateLimit,
        Math.max(DEFAULT_ANALYSIS_DISPATCH_SCAN_LIMIT, globalLimit * 100)
    );
    const requestedUserIds = Array.from(
        new Set((options.userIds ?? []).filter(Boolean))
    );
    const queuedWhere = {
        status: 'QUEUED' as const,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        ...(requestedUserIds.length > 0
            ? { userId: { in: requestedUserIds } }
            : {}),
    };

    const candidateUsers = await prisma.analysisJob.findMany({
        where: queuedWhere,
        distinct: ['userId'],
        orderBy: [{ createdAt: 'asc' }, { priority: 'desc' }],
        take: userScanLimit,
        select: { userId: true },
    });
    const userIds = candidateUsers.map((user) => user.userId);

    if (userIds.length === 0) {
        const emptyPlan = planAnalysisDispatch({ jobs: [], options });
        return {
            ...emptyPlan,
            claimedJobs: [],
            claimedJobIds: [],
            claimMisses: [],
        };
    }

    const [jobs, runningRows, dispatchedRows] = await Promise.all([
        prisma.analysisJob.findMany({
            where: {
                ...queuedWhere,
                userId: { in: userIds },
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
            take: candidateLimit,
        }),
        prisma.analysisJob.groupBy({
            by: ['userId'],
            where: {
                userId: { in: userIds },
                status: 'RUNNING',
                lockedUntil: { gt: now },
            },
            _count: { _all: true },
        }),
        prisma.analysisJob.groupBy({
            by: ['userId'],
            where: {
                userId: { in: userIds },
                status: 'QUEUED',
                lockedUntil: { gt: now },
            },
            _count: { _all: true },
        }),
    ]);

    const plan = planAnalysisDispatch({
        jobs,
        options: {
            ...options,
            now,
            runningByUser: countRowsToRecord(runningRows),
            dispatchedByUser: countRowsToRecord(dispatchedRows),
        },
    });

    const claimedJobs: AnalysisDispatchCandidate[] = [];
    const claimMisses: string[] = [];
    const lockedUntil = getAnalysisJobLockedUntil({
        now,
        leaseMs: options.leaseMs ?? DEFAULT_ANALYSIS_JOB_LEASE_MS,
    });

    for (const job of plan.selectedJobs) {
        const result = await prisma.analysisJob.updateMany({
            where: {
                id: job.id,
                status: 'QUEUED',
                OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
            },
            data: {
                lockedAt: now,
                lockedUntil,
                lastDispatchedAt: now,
                dispatchedCount: { increment: 1 },
            },
        });
        if (result.count === 1) {
            claimedJobs.push({
                ...job,
                dispatchedCount: job.dispatchedCount + 1,
                lockedAt: now,
                lockedUntil,
            });
        } else {
            claimMisses.push(job.id);
        }
    }

    return {
        ...plan,
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
            estimatedCredits: true,
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
                            consumedCredits: 0,
                            lastError:
                                'Analysis job lease expired after maximum attempts',
                        },
                    });
                }
                return updated;
            });
            failed += result.count;
            if (result.count === 1) {
                try {
                    await releaseServerAnalysisCredits({
                        userId: job.userId,
                        gameId: job.gameId,
                        analysisJobId: job.id,
                        analysisRunId: job.analysisRunId,
                        credits: Math.max(1, job.estimatedCredits ?? 1),
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
                            error: errorMessage(error),
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
    const claim = await claimNextAnalysisJobs(options);
    const published: AnalysisDispatchPublishResult[] = [];

    for (const job of claim.claimedJobs) {
        if (!job.lockedAt) {
            throw new Error(`Claimed analysis job ${job.id} has no dispatch lock`);
        }
        const dispatchToken = createAnalysisDispatchToken({
            jobId: job.id,
            lockedAt: job.lockedAt,
            dispatchedCount: job.dispatchedCount,
        });
        try {
            const result = await publishBackranqQueueMessage(
                {
                    type: 'analysis-job',
                    jobId: job.id,
                    dispatchToken,
                },
                { idempotencyKey: analysisDispatchIdempotencyKey(job) }
            );
            published.push({
                jobId: job.id,
                queued: result.queued,
                messageId: result.messageId,
                dispatchToken,
                unavailableReason: result.unavailableReason,
                error: result.error,
            });
            if (!result.queued && options.releaseUnpublishedLocks !== false) {
                await releaseAnalysisDispatchLocks(
                    [job.id],
                    `QUEUE_PUBLISH_PENDING:${result.unavailableReason ?? 'unavailable'}`
                );
                if (result.unavailableReason === 'disabled') {
                    await cancelUnexecutableAnalysisJobs({
                        userId: job.userId,
                        jobIds: [job.id],
                        reason: 'Server analysis queue is disabled',
                    });
                }
            }
        } catch (error) {
            published.push({
                jobId: job.id,
                queued: false,
                messageId: null,
                dispatchToken,
                unavailableReason: 'publish-failed',
                error,
            });
            if (options.releaseUnpublishedLocks !== false) {
                await releaseAnalysisDispatchLocks(
                    [job.id],
                    `QUEUE_PUBLISH_PENDING:${errorMessage(error)}`
                );
            }
            if (options.throwOnPublishError !== false) throw error;
        }
    }

    return { ...claim, published };
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

function countRowsToRecord(
    rows: Array<{ userId: string; _count: { _all: number } }>
) {
    return Object.fromEntries(
        rows.map((row) => [row.userId, row._count._all])
    );
}

function errorMessage(error: unknown) {
    return error instanceof Error
        ? error.message.slice(0, 2_000)
        : String(error).slice(0, 2_000);
}
