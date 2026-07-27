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
    type PartialPreferences,
} from '@/lib/preferences';
import {
    createAnalysisRun,
    createAnalysisRunInTransaction,
    hashAnalysisConfig,
    type CreateAnalysisRunArgs,
} from '@/lib/services/analysisRuns';
import {
    DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS,
    analysisJobClearedLeaseData,
    analysisJobRunningLeaseData,
    getAnalysisRetryScheduledFor,
} from '@/lib/services/analysisJobLeases';
import {
    reserveServerAnalysisCreditsInTransaction,
    SERVER_ANALYSIS_BILLING_POLICY_V1,
    type BillingTransactionClient,
} from '@/lib/services/billingAccounts';

export const SERVER_ANALYSIS_EXECUTION_MODE =
    'SERVER_QUEUE' satisfies AnalysisExecutionMode;
export const SERVER_ANALYSIS_CONSUMED_CREDITS_V1 = 0;
export const SERVER_ANALYSIS_ESTIMATED_CREDITS_V1 = 1;
export const SERVER_ANALYSIS_CREDIT_POLICY =
    SERVER_ANALYSIS_BILLING_POLICY_V1;

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
            if (existing.status === 'SUCCEEDED' && !args.force) {
                return { job: existing, created: false, queued: false };
            }
            if (existing.status === 'QUEUED' || existing.status === 'RUNNING') {
                return { job: existing, created: false, queued: false };
            }
            const job = await tx.analysisJob.update({
                where: { id: existing.id },
                data: {
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
                    startedAt: null,
                    completedAt: null,
                    lastError: null,
                    queuedReason: args.queuedReason ?? existing.queuedReason,
                },
            });
            const run = await createAnalysisRunProvenanceInTransaction({
                tx,
                job,
                queuedReason: args.queuedReason ?? existing.queuedReason,
                config: args.config,
                status: 'QUEUED',
            });
            await reserveCreditsForQueuedAnalysisJob({ tx, job, run });
            return { job, created: false, queued: true };
        }

        const job = await tx.analysisJob.create({
            data: {
                userId: args.userId,
                gameId: args.gameId,
                priority: args.priority ?? 0,
                scheduledFor: args.scheduledFor ?? null,
                estimatedCredits:
                    args.estimatedCredits ?? SERVER_ANALYSIS_ESTIMATED_CREDITS_V1,
                weight: args.weight ?? 0,
                queuedReason: args.queuedReason,
            },
        });
        const run = await createAnalysisRunProvenanceInTransaction({
            tx,
            job,
            queuedReason: args.queuedReason,
            config: args.config,
            status: 'QUEUED',
        });
        await reserveCreditsForQueuedAnalysisJob({ tx, job, run });
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

export async function markAnalysisJobRunning(jobId: string) {
    const now = new Date();
    const updated = await prisma.analysisJob.updateMany({
        where: {
            id: jobId,
            status: 'QUEUED',
            lockedUntil: { gt: now },
            OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
        },
        data: {
            status: 'RUNNING',
            ...analysisJobRunningLeaseData({ now }),
            lastError: null,
        },
    });
    if (updated.count !== 1) return null;
    return prisma.analysisJob.findUnique({ where: { id: jobId } });
}

export async function markAnalysisJobSucceeded(jobId: string) {
    return prisma.analysisJob.update({
        where: { id: jobId },
        data: {
            status: 'SUCCEEDED',
            ...analysisJobClearedLeaseData(),
            completedAt: new Date(),
            lastError: null,
        },
    });
}

export async function markAnalysisJobFailed(jobId: string, error: unknown) {
    const now = new Date();
    const job = await prisma.analysisJob.findUnique({ where: { id: jobId } });
    if (job && job.attempts < DEFAULT_ANALYSIS_RETRY_MAX_ATTEMPTS) {
        return prisma.analysisJob.update({
            where: { id: jobId },
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
    }

    return prisma.analysisJob.update({
        where: { id: jobId },
        data: {
            status: 'FAILED',
            ...analysisJobClearedLeaseData(),
            completedAt: new Date(),
            lastError: errorMessage(error),
        },
    });
}

export async function markAnalysisJobRetryable(jobId: string, error: unknown) {
    return prisma.analysisJob.update({
        where: { id: jobId },
        data: {
            status: 'QUEUED',
            ...analysisJobClearedLeaseData(),
            completedAt: null,
            lastError: errorMessage(error),
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
            provider: 'stockfish.wasm',
            client: 'ServerStockfishClient',
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

export async function createAnalysisRunProvenance(args: {
    job: Pick<
        AnalysisJob,
        'id' | 'userId' | 'gameId' | 'createdAt' | 'startedAt'
    >;
    queuedReason?: string | null;
    config?: ServerAnalysisConfig;
    status: AnalysisJobStatus;
}) {
    try {
        const run = await createAnalysisRun(analysisRunProvenancePayload(args));
        return analysisRunToSummary(run);
    } catch (error) {
        warnAnalysisRunUnavailable(error);
        return null;
    }
}

async function createAnalysisRunProvenanceInTransaction(args: {
    tx: Parameters<typeof createAnalysisRunInTransaction>[0]['tx'];
    job: Pick<
        AnalysisJob,
        'id' | 'userId' | 'gameId' | 'createdAt' | 'startedAt'
    >;
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
    job: Pick<
        AnalysisJob,
        'id' | 'userId' | 'gameId' | 'createdAt' | 'startedAt'
    >;
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
            name: 'stockfish',
            source: 'stockfish.wasm/server',
        },
        configSnapshot: args.config?.snapshot,
        configHash: args.config?.hash,
        startedAt:
            args.status === 'RUNNING'
                ? (args.job.startedAt ?? new Date())
                : null,
        consumedCredits: SERVER_ANALYSIS_CONSUMED_CREDITS_V1,
        analysisJobId: args.job.id,
    };
}

export async function ensureAnalysisRunForJob(args: {
    job: Pick<
        AnalysisJob,
        | 'id'
        | 'userId'
        | 'gameId'
        | 'createdAt'
        | 'startedAt'
        | 'queuedReason'
    >;
    config?: ServerAnalysisConfig;
    status: AnalysisJobStatus;
}) {
    const existing = await getAnalysisRunSummaryForJob(args.job.id);
    if (existing) return existing;
    return createAnalysisRunProvenance({
        job: args.job,
        queuedReason: args.job.queuedReason,
        config: args.config,
        status: args.status,
    });
}

export async function transitionAnalysisRunForJob(args: {
    jobId: string;
    status: AnalysisJobStatus;
    queuedReason?: string | null;
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
                queuedReason: args.queuedReason ?? undefined,
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
    tx: BillingTransactionClient;
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

    await reserveServerAnalysisCreditsInTransaction({
        tx,
        userId: job.userId,
        gameId: job.gameId,
        analysisJobId: job.id,
        analysisRunId: run?.id,
        credits,
        idempotencyKey,
        reason: job.queuedReason,
        enforceAutoAnalysisCaps: job.queuedReason === 'auto-sync',
        enforceStopThreshold: true,
        metadata: {
            executionMode: SERVER_ANALYSIS_EXECUTION_MODE,
            estimatedCredits: credits,
            policy: SERVER_ANALYSIS_CREDIT_POLICY,
        },
    });
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
