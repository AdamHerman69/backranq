import type {
    AnalysisExecutionMode,
    AnalysisJob,
    AnalysisJobStatus,
    AnalysisRun,
    AnalysisRunStatus,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    analysisDefaultsToExtractOptions,
    defaultPreferences,
    mergePreferences,
    pickAnalysisDefaults,
    type AnalysisDefaults,
    type PartialPreferences,
} from '@/lib/preferences';
import {
    createAnalysisRunInTransaction,
    hashAnalysisConfig,
    type CreateAnalysisRunArgs,
} from '@/lib/services/analysisRuns';
import {
    DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS,
    analysisJobClearedLeaseData,
    getAnalysisJobLockedUntil,
    getAnalysisRetryScheduledFor,
} from '@/lib/services/analysisJobLeases';
import {
    parseAnalysisDispatchToken,
    type AnalysisDispatchFence,
} from '@/lib/services/analysisDispatchFence';
import { autoAnalysisRulesFromPreferences } from '@/lib/services/analysisEligibility';
import {
    reserveServerAnalysisCreditsInTransaction,
    releaseServerAnalysisCreditsInTransaction,
    SERVER_ANALYSIS_BILLING_POLICY_V1,
} from '@/lib/services/billingAccounts';

export const SERVER_ANALYSIS_EXECUTION_MODE =
    'SERVER_QUEUE' satisfies AnalysisExecutionMode;
export const SERVER_ANALYSIS_CONSUMED_CREDITS_V1 = 0;
export const SERVER_ANALYSIS_ESTIMATED_CREDITS_V1 = 1;
export const SERVER_ANALYSIS_CREDIT_POLICY =
    SERVER_ANALYSIS_BILLING_POLICY_V1;
export const AUTO_ANALYSIS_QUEUED_REASONS = [
    'auto-sync',
    'auto-analysis',
] as const;
export class AutoAnalysisDisabledError extends Error {
    constructor(message = 'Automatic analysis is disabled') {
        super(message);
        this.name = 'AutoAnalysisDisabledError';
    }
}

export class AnalysisJobOwnershipError extends Error {
    constructor(gameId: string) {
        super(`Analysis job ownership mismatch for game ${gameId}`);
        this.name = 'AnalysisJobOwnershipError';
    }
}

export type ServerAnalysisConfig = {
    snapshot: Prisma.InputJsonObject;
    hash: string;
};

export type AnalysisRunSummary = {
    id: string;
    status: string | null;
    executionMode: string | null;
    queuedReason: string | null;
    configHash: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    durationMs: number | null;
    consumedCredits: number | null;
    lastError: string | null;
};

export type EnqueueAnalysisJobResult = {
    job: AnalysisJob;
    created: boolean;
    queued: boolean;
};

export type EnqueueAnalysisJobsForGamesResult = {
    results: EnqueueAnalysisJobResult[];
    errors: Array<{ gameId: string; error: string }>;
};

export async function enqueueAnalysisJob(args: {
    userId: string;
    gameId: string;
    queuedReason?: string;
    priority?: number;
    scheduledFor?: Date | null;
    estimatedCredits?: number;
    weight?: number;
    force?: boolean;
    config?: ServerAnalysisConfig;
}): Promise<EnqueueAnalysisJobResult> {
    try {
        return await enqueueAnalysisJobOnce(args);
    } catch (error) {
        if (!isPrismaUniqueError(error)) throw error;
        return enqueueAnalysisJobOnce(args);
    }
}

async function enqueueAnalysisJobOnce(args: {
    userId: string;
    gameId: string;
    queuedReason?: string;
    priority?: number;
    scheduledFor?: Date | null;
    estimatedCredits?: number;
    weight?: number;
    force?: boolean;
    config?: ServerAnalysisConfig;
}): Promise<EnqueueAnalysisJobResult> {
    return prisma.$transaction(async (tx) => {
        const existing = await tx.analysisJob.findUnique({
            where: { gameId: args.gameId },
        });

        if (existing) {
            if (existing.userId !== args.userId) {
                throw new AnalysisJobOwnershipError(args.gameId);
            }
            if (existing.status === 'SUCCEEDED' && !args.force) {
                return { job: existing, created: false, queued: false };
            }
            if (existing.status === 'QUEUED' || existing.status === 'RUNNING') {
                return { job: existing, created: false, queued: false };
            }
            const run = await createAnalysisRunProvenanceInTransaction({
                tx,
                job: existing,
                queuedReason: args.queuedReason ?? existing.queuedReason,
                config: args.config,
                status: 'QUEUED',
            });
            const job = await tx.analysisJob.update({
                where: { id: existing.id },
                data: {
                    analysisRunId: run.id,
                    status: 'QUEUED',
                    priority: args.priority ?? existing.priority,
                    scheduledFor: args.scheduledFor ?? null,
                    estimatedCredits:
                        args.estimatedCredits ??
                        existing.estimatedCredits ??
                        SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
                    weight: args.weight ?? existing.weight ?? 0,
                    lockedAt: null,
                    lockedUntil: null,
                    attempts: 0,
                    startedAt: null,
                    completedAt: null,
                    lastError: null,
                    queuedReason: args.queuedReason ?? existing.queuedReason,
                },
            });
            await reserveCreditsForQueuedAnalysisJob({
                tx,
                job,
                run,
            });
            return { job, created: false, queued: true };
        }

        const run = await createAnalysisRunProvenanceInTransaction({
            tx,
            job: {
                userId: args.userId,
                gameId: args.gameId,
                startedAt: null,
            },
            queuedReason: args.queuedReason,
            config: args.config,
            status: 'QUEUED',
        });
        const job = await tx.analysisJob.create({
            data: {
                userId: args.userId,
                gameId: args.gameId,
                analysisRunId: run.id,
                priority: args.priority ?? 0,
                scheduledFor: args.scheduledFor ?? null,
                estimatedCredits:
                    args.estimatedCredits ?? SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
                weight: args.weight ?? 0,
                queuedReason: args.queuedReason,
            },
        });
        await reserveCreditsForQueuedAnalysisJob({
            tx,
            job,
            run,
        });
        return { job, created: true, queued: true };
    }, serializableTransactionOptions());
}

export async function enqueueAnalysisJobsForGames(args: {
    userId: string;
    gameIds: string[];
    queuedReason?: string;
    scheduledFor?: Date | null;
    force?: boolean;
    config?: ServerAnalysisConfig;
}): Promise<EnqueueAnalysisJobsForGamesResult> {
    const results: EnqueueAnalysisJobResult[] = [];
    const errors: EnqueueAnalysisJobsForGamesResult['errors'] = [];
    for (const gameId of Array.from(new Set(args.gameIds.filter(Boolean)))) {
        try {
            results.push(await enqueueAnalysisJob({
                userId: args.userId,
                gameId,
                queuedReason: args.queuedReason,
                scheduledFor: args.scheduledFor,
                force: args.force,
                config: args.config,
            }));
        } catch (error) {
            errors.push({ gameId, error: errorMessage(error) });
        }
    }
    return { results, errors };
}

export class StaleAnalysisDeliveryError extends Error {
    constructor(jobId: string) {
        super(`Analysis delivery is stale or no longer claimable: ${jobId}`);
        this.name = 'StaleAnalysisDeliveryError';
    }
}

export class MissingAnalysisRunProvenanceError extends Error {
    constructor(jobId: string) {
        super(
            `Analysis job is missing immutable enqueue-time run provenance: ${jobId}`
        );
        this.name = 'MissingAnalysisRunProvenanceError';
    }
}

export async function markAnalysisJobRunning(
    jobId: string,
    dispatchToken: string
) {
    const fence = requireAnalysisDispatchFence(jobId, dispatchToken);
    const now = new Date();
    const claimableWhere = {
        id: jobId,
        status: 'QUEUED' as const,
        lockedAt: fence.lockedAt,
        dispatchedCount: fence.dispatchedCount,
        lockedUntil: { gt: now },
        OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
    };
    const updated = await prisma.analysisJob.updateMany({
        where: {
            ...claimableWhere,
            analysisRun: { is: {} },
        },
        data: {
            status: 'RUNNING',
            attempts: { increment: 1 },
            lockedUntil: getAnalysisJobLockedUntil({ now }),
            startedAt: now,
            lastError: null,
        },
    });
    if (updated.count !== 1) {
        const runless = await prisma.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`
                SELECT "id"
                FROM "AnalysisJob"
                WHERE "id" = ${jobId}::uuid
                  AND "status" = 'QUEUED'
                  AND "lockedAt" = ${fence.lockedAt}
                  AND "dispatchedCount" = ${fence.dispatchedCount}
                  AND "lockedUntil" > ${now}
                  AND ("scheduledFor" IS NULL OR "scheduledFor" <= ${now})
                  AND "analysisRunId" IS NULL
                LIMIT 1
            `
        );
        if (runless?.[0]) throw new MissingAnalysisRunProvenanceError(jobId);
        return null;
    }
    return prisma.analysisJob.findUnique({ where: { id: jobId } });
}

export async function markAnalysisJobSucceeded(
    jobId: string,
    fence: AnalysisDispatchFence
) {
    const now = new Date();
    const updated = await prisma.analysisJob.updateMany({
        where: runningFenceWhere(jobId, fence),
        data: {
            status: 'SUCCEEDED',
            ...analysisJobClearedLeaseData(),
            completedAt: now,
            lastError: null,
        },
    });
    if (updated.count !== 1) return null;
    return prisma.analysisJob.findUnique({ where: { id: jobId } });
}

export async function markAnalysisJobFailed(
    jobId: string,
    fence: AnalysisDispatchFence,
    error: unknown
) {
    const now = new Date();
    const job = await prisma.analysisJob.findFirst({
        where: runningFenceWhere(jobId, fence),
    });
    if (!job) return null;

    if (job && job.attempts < DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS) {
        const updated = await prisma.$transaction(async (tx) => {
            const result = await tx.analysisJob.updateMany({
                where: runningFenceWhere(jobId, fence),
                data: {
                    status: 'QUEUED',
                    ...analysisJobClearedLeaseData(),
                    scheduledFor: getAnalysisRetryScheduledFor({
                        attempts: Math.max(1, job.attempts),
                        now,
                    }),
                    completedAt: null,
                    lastError: errorMessage(error),
                },
            });
            if (result.count === 1 && job.analysisRunId) {
                await tx.analysisRun.updateMany({
                    where: {
                        id: job.analysisRunId,
                        status: 'RUNNING',
                    },
                    data: {
                        status: 'QUEUED',
                        completedAt: null,
                        durationMs: null,
                        lastError: errorMessage(error),
                    },
                });
            }
            return result;
        });
        if (updated.count !== 1) return null;
        return prisma.analysisJob.findUnique({ where: { id: jobId } });
    }

    const updated = await prisma.$transaction(async (tx) => {
        const result = await tx.analysisJob.updateMany({
            where: runningFenceWhere(jobId, fence),
            data: {
                status: 'FAILED',
                ...analysisJobClearedLeaseData(),
                completedAt: now,
                lastError: errorMessage(error),
            },
        });
        if (result.count === 1 && job.analysisRunId) {
            await tx.analysisRun.updateMany({
                where: {
                    id: job.analysisRunId,
                    status: 'RUNNING',
                },
                data: {
                    status: 'FAILED',
                    completedAt: now,
                    consumedCredits: SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
                    lastError: errorMessage(error),
                },
            });
        }
        return result;
    });
    if (updated.count !== 1) return null;
    return prisma.analysisJob.findUnique({ where: { id: jobId } });
}

export async function markAnalysisJobRetryable(
    jobId: string,
    fence: AnalysisDispatchFence,
    error: unknown
) {
    const updated = await prisma.analysisJob.updateMany({
        where: runningFenceWhere(jobId, fence),
        data: {
            status: 'QUEUED',
            ...analysisJobClearedLeaseData(),
            completedAt: null,
            lastError: errorMessage(error),
        },
    });
    if (updated.count !== 1) return null;
    return prisma.analysisJob.findUnique({ where: { id: jobId } });
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

export async function getAnalysisJobWakeupAt(jobId: string) {
    const job = await prisma.analysisJob.findUnique({
        where: { id: jobId },
        select: {
            status: true,
            scheduledFor: true,
            lockedUntil: true,
        },
    });
    if (job?.status === 'RUNNING') return job.lockedUntil;
    if (job?.status === 'QUEUED') return job.scheduledFor;
    return null;
}

export async function getNextQueuedAnalysisRetry() {
    const job = await prisma.analysisJob.findFirst({
        where: {
            status: 'QUEUED',
            scheduledFor: { gt: new Date() },
        },
        orderBy: [{ scheduledFor: 'asc' }, { updatedAt: 'asc' }],
        select: {
            id: true,
            scheduledFor: true,
        },
    });
    return job?.scheduledFor
        ? { jobId: job.id, retryAt: job.scheduledFor }
        : null;
}

export function serverAnalysisConfigFromPreferences(
    preferences: unknown
): {
    prefs: ReturnType<typeof mergePreferences>;
    options: ReturnType<typeof analysisDefaultsToExtractOptions>;
    config: ServerAnalysisConfig;
} {
    const prefs = mergePreferences(
        defaultPreferences(),
        (preferences ?? {}) as PartialPreferences
    );
    const analysisDefaults = pickAnalysisDefaults(prefs);
    const extractOptions = analysisDefaultsToExtractOptions(analysisDefaults, {
        returnAnalysis: true,
    });
    const snapshot = {
        version: 1,
        executionMode: SERVER_ANALYSIS_EXECUTION_MODE,
        engine: {
            provider: 'stockfish@18.0.8',
            client: 'ServerStockfishClient',
            build: 'stockfish-18-lite-single',
            flavor: 'lite-single-nnue-wasm',
            options: {
                Threads: 1,
                Hash: 64,
                UCI_ShowWDL: true,
            },
        },
        analysisDefaults,
        extractOptions,
    } satisfies Prisma.InputJsonObject;

    return {
        prefs,
        options: extractOptions,
        config: {
            snapshot,
            hash: hashJson(snapshot),
        },
    };
}

export function serverAnalysisConfigFromSnapshot(args: {
    snapshot: unknown;
    hash: string;
}): {
    options: ReturnType<typeof analysisDefaultsToExtractOptions>;
    config: ServerAnalysisConfig;
} | null {
    if (!isRecord(args.snapshot)) return null;
    const analysisDefaults = args.snapshot.analysisDefaults;
    if (!isRecord(analysisDefaults)) return null;

    const snapshot = args.snapshot as Prisma.InputJsonObject;
    const computedHash = hashJson(snapshot);
    if (args.hash !== computedHash) return null;
    return {
        options: analysisDefaultsToExtractOptions(
            analysisDefaults as AnalysisDefaults,
            { returnAnalysis: true }
        ),
        config: {
            snapshot,
            hash: computedHash,
        },
    };
}

export function getAnalysisJobDurationMs(job: {
    startedAt: Date | null;
    completedAt: Date | null;
}) {
    if (!job.startedAt || !job.completedAt) return null;
    return Math.max(0, job.completedAt.getTime() - job.startedAt.getTime());
}

export function analysisJobCreditsMetadata(
    run?: Pick<AnalysisRunSummary, 'consumedCredits'> | null
) {
    return {
        consumedCredits:
            run?.consumedCredits ?? SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
        estimatedCredits: SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
        billable: true,
        reservedCredits: SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
        policy: SERVER_ANALYSIS_CREDIT_POLICY,
    };
}

async function createAnalysisRunProvenanceInTransaction(args: {
    tx: Parameters<typeof createAnalysisRunInTransaction>[0]['tx'];
    job: Pick<AnalysisJob, 'userId' | 'gameId' | 'startedAt'>;
    queuedReason?: string | null;
    config?: ServerAnalysisConfig;
    status: AnalysisJobStatus;
}) {
    const run = await createAnalysisRunInTransaction({
        tx: args.tx,
        ...analysisRunProvenancePayload(args),
    });
    return analysisRunToSummary(run);
}

function analysisRunProvenancePayload(args: {
    job: Pick<AnalysisJob, 'userId' | 'gameId' | 'startedAt'>;
    queuedReason?: string | null;
    config?: ServerAnalysisConfig;
    status: AnalysisJobStatus;
}): CreateAnalysisRunArgs {
    return {
        userId: args.job.userId,
        gameId: args.job.gameId,
        executionMode: SERVER_ANALYSIS_EXECUTION_MODE,
        status: analysisJobStatusToRunStatus(args.status),
        queuedReason: args.queuedReason,
        engine: {
            name: 'Stockfish 18',
            version: '18.0.8',
            source: 'stockfish@18.0.8/server/stockfish-18-lite-single',
            flavor: 'lite-single-nnue-wasm',
            options: {
                Threads: 1,
                Hash: 64,
                UCI_ShowWDL: true,
            },
        },
        configSnapshot: args.config?.snapshot,
        configHash: args.config?.hash,
        startedAt:
            args.status === 'RUNNING'
                ? (args.job.startedAt ?? new Date())
                : null,
        consumedCredits: SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
    };
}

export async function transitionAnalysisRunForJob(args: {
    jobId: string;
    status: AnalysisJobStatus;
    config?: ServerAnalysisConfig;
    startedAt?: Date | null;
    completedAt?: Date | null;
    error?: unknown;
    result?: Prisma.InputJsonObject;
}) {
    const run = await getAnalysisRunSummaryForJob(args.jobId);
    if (!run) return null;

    const startedAt = args.startedAt ?? run.startedAt;
    const completedAt =
        args.status === 'SUCCEEDED' || args.status === 'FAILED'
            ? (args.completedAt ?? new Date())
            : args.completedAt;
    const durationMs =
        startedAt && completedAt
            ? Math.max(0, completedAt.getTime() - startedAt.getTime())
            : null;
    const lastError =
        args.error == null
            ? args.status === 'SUCCEEDED'
                ? null
                : undefined
            : args.error instanceof Error
              ? args.error.message.slice(0, 2_000)
              : String(args.error).slice(0, 2_000);

    try {
        const updated = await prisma.analysisRun.update({
            where: { id: run.id },
            data: pruneUndefined({
                status: analysisJobStatusToRunStatus(args.status),
                configSnapshot: args.config?.snapshot,
                configHash: args.config?.hash,
                startedAt:
                    args.status === 'RUNNING'
                        ? (startedAt ?? new Date())
                        : undefined,
                completedAt,
                durationMs,
                consumedCredits: SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
                lastError,
            }),
        });

        void args.result;
        return analysisRunToSummary(updated);
    } catch (error) {
        warnAnalysisRunUnavailable(error);
        return null;
    }
}

export async function getAnalysisRunSummaryForJob(jobId: string) {
    try {
        const job = await prisma.analysisJob.findUnique({
            where: { id: jobId },
            select: {
                analysisRun: true,
            },
        });
        return job?.analysisRun ? analysisRunToSummary(job.analysisRun) : null;
    } catch (error) {
        warnAnalysisRunUnavailable(error);
        return null;
    }
}

function analysisRunToSummary(run: AnalysisRun): AnalysisRunSummary {
    return {
        id: run.id,
        status: run.status,
        executionMode: run.executionMode,
        queuedReason: run.queuedReason,
        configHash: run.configHash,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        durationMs: run.durationMs,
        consumedCredits: run.consumedCredits,
        lastError: run.lastError,
    };
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

function hashJson(value: Prisma.InputJsonValue) {
    return hashAnalysisConfig(value);
}

function pruneUndefined<T extends Record<string, unknown>>(value: T) {
    return Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined)
    ) as T;
}

function analysisJobStatusToRunStatus(
    status: AnalysisJobStatus
): AnalysisRunStatus {
    return status;
}

function warnAnalysisRunUnavailable(error: unknown) {
    if (process.env.NODE_ENV === 'production') return;
    console.warn(
        '[analysis runs] provenance unavailable; preserving AnalysisJob behavior:',
        error
    );
}

async function reserveCreditsForQueuedAnalysisJob(args: {
    tx: Prisma.TransactionClient;
    job: Pick<
        AnalysisJob,
        'id' | 'userId' | 'gameId' | 'queuedReason' | 'estimatedCredits'
    >;
    run: AnalysisRunSummary | null;
}) {
    const { tx, job, run } = args;
    const credits = Math.max(
        1,
        Math.trunc(job.estimatedCredits ?? SERVER_ANALYSIS_ESTIMATED_CREDITS_V1)
    );
    const idempotencyKey = run
        ? `analysis-run:${run.id}:reserve`
        : `analysis-job:${job.id}:reserve`;

    const isAutomatic = isAutoAnalysisQueuedReason(job.queuedReason);
    let autoAnalysisBudget:
        | {
              dailyCap: number | null;
              monthlyCap: number | null;
              reserveCredits: number;
          }
        | undefined;
    if (isAutomatic) {
        const user = await tx.user.findUnique({
            where: { id: job.userId },
            select: { preferences: true },
        });
        const rules = autoAnalysisRulesFromPreferences(
            user?.preferences ?? {}
        );
        if (!rules.enabled) throw new AutoAnalysisDisabledError();
        // This canonical policy read and the reservation share the same
        // serializable transaction. A reconciliation snapshot may already be
        // stale if the user tightened or disabled automation.
        autoAnalysisBudget = {
            dailyCap: rules.dailyCap,
            monthlyCap: rules.monthlyCap,
            reserveCredits: rules.reserveCredits,
        };
    }

    await reserveServerAnalysisCreditsInTransaction({
        tx,
        userId: job.userId,
        gameId: job.gameId,
        analysisJobId: job.id,
        analysisRunId: run?.id,
        credits,
        idempotencyKey,
        reason: job.queuedReason,
        enforceAutoAnalysisCaps: isAutomatic,
        enforceStopThreshold: true,
        autoAnalysisBudget,
        metadata: {
            executionMode: SERVER_ANALYSIS_EXECUTION_MODE,
            estimatedCredits: credits,
            policy: SERVER_ANALYSIS_CREDIT_POLICY,
        },
    });
}

export function isAutoAnalysisQueuedReason(reason: string | null | undefined) {
    return AUTO_ANALYSIS_QUEUED_REASONS.includes(
        reason as (typeof AUTO_ANALYSIS_QUEUED_REASONS)[number]
    );
}

/**
 * Disabling automation cancels every still-QUEUED auto job, including one
 * whose delivery has already been published. The worker's QUEUED→RUNNING CAS
 * then rejects that stale delivery. Jobs which won the race to RUNNING and all
 * manual work are deliberately untouched. The caller can include this helper
 * in the same transaction as the preferences update.
 */
export async function cancelQueuedAutoAnalysisJobsInTransaction(args: {
    tx: Prisma.TransactionClient;
    userId: string;
}) {
    const jobs = await args.tx.analysisJob.findMany({
        where: {
            userId: args.userId,
            status: 'QUEUED',
            queuedReason: { in: [...AUTO_ANALYSIS_QUEUED_REASONS] },
        },
        select: {
            id: true,
            userId: true,
            gameId: true,
            analysisRunId: true,
            estimatedCredits: true,
        },
    });
    let cancelled = 0;
    for (const job of jobs) {
        const update = await args.tx.analysisJob.updateMany({
            where: {
                id: job.id,
                status: 'QUEUED',
            },
            data: {
                status: 'CANCELLED',
                ...analysisJobClearedLeaseData(),
                completedAt: new Date(),
                scheduledFor: null,
                lastError: null,
            },
        });
        if (update.count !== 1) continue;
        cancelled += 1;
        await args.tx.analysisRun.updateMany({
            where: { id: job.analysisRunId, status: 'QUEUED' },
            data: {
                status: 'CANCELLED',
                completedAt: new Date(),
                lastError: null,
            },
        });

        const credits = Math.max(1, Math.trunc(job.estimatedCredits ?? 1));
        const entries = await args.tx.creditLedgerEntry.findMany({
            where: { analysisJobId: job.id },
            select: { type: true, credits: true },
        });
        const reserved = entries.reduce((total, entry) => {
            if (entry.type === 'RESERVED') return total + entry.credits;
            if (
                entry.type === 'CONSUMED' ||
                entry.type === 'RELEASED' ||
                entry.type === 'EXPIRED'
            ) {
                return total - entry.credits;
            }
            return total;
        }, 0);
        if (reserved < credits) continue;
        await releaseServerAnalysisCreditsInTransaction({
            tx: args.tx,
            userId: job.userId,
            gameId: job.gameId,
            analysisJobId: job.id,
            analysisRunId: job.analysisRunId,
            credits,
            idempotencyKey:
                `analysis-run:${job.analysisRunId}:disabled-release`,
            reason: 'auto-analysis-disabled',
        });
    }
    return { cancelled };
}

function errorMessage(error: unknown) {
    return error instanceof Error
        ? error.message.slice(0, 2_000)
        : String(error).slice(0, 2_000);
}

function serializableTransactionOptions() {
    return {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireAnalysisDispatchFence(
    jobId: string,
    dispatchToken: string
): AnalysisDispatchFence {
    const fence = parseAnalysisDispatchToken({ jobId, dispatchToken });
    if (!fence) throw new StaleAnalysisDeliveryError(jobId);
    return fence;
}

function runningFenceWhere(jobId: string, fence: AnalysisDispatchFence) {
    return {
        id: jobId,
        status: 'RUNNING' as const,
        lockedAt: fence.lockedAt,
        dispatchedCount: fence.dispatchedCount,
    };
}
