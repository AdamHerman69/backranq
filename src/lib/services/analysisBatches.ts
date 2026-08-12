import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AnalysisBatch, type AnalysisBatchItemStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import type { AnalysisDefaults } from '@/lib/preferences';
import {
    AnalysisJobConfigurationConflictError,
    AnalysisJobOwnershipError,
    enqueueAnalysisJob,
    serverAnalysisConfigFromPreferences,
    type ServerAnalysisConfig,
} from '@/lib/services/analysisJobs';
import { BillingAccountError } from '@/lib/services/billingAccounts';
import { stableCanonicalStringify } from '@/lib/training/contracts';

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 200;
const PLANNING_LEASE_MS = 5 * 60_000;

export class AnalysisBatchRequestConflictError extends Error {
    constructor() {
        super('The requestId has already been used with a different payload');
        this.name = 'AnalysisBatchRequestConflictError';
    }
}

export class AnalysisBatchGamesUnavailableError extends Error {
    constructor() {
        super('One or more games are not available for this user');
        this.name = 'AnalysisBatchGamesUnavailableError';
    }
}

export type CreateAnalysisBatchArgs = {
    userId: string;
    requestId: string;
    gameIds: string[];
    force: boolean;
    analysisDefaults?: AnalysisDefaults;
};

export type AnalysisBatchSummary = {
    id: string;
    requestId: string;
    status: string;
    force: boolean;
    analysisQuality: string;
    creditCost: number;
    configHash: string;
    counts: {
        total: number;
        pending: number;
        queued: number;
        attached: number;
        skipped: number;
        failed: number;
        cancelled: number;
        running: number;
        succeeded: number;
        jobFailed: number;
        jobCancelled: number;
    };
    completedAt: Date | null;
    lastError: string | null;
    createdAt: Date;
    updatedAt: Date;
};

export async function createAnalysisBatch(args: CreateAnalysisBatchArgs) {
    const gameIds = canonicalGameIds(args.gameIds);
    const payloadHash = hashBatchPayload({
        gameIds,
        force: args.force,
        analysisDefaults: args.analysisDefaults,
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return await prisma.$transaction(async (tx) => {
                const existing = await tx.analysisBatch.findUnique({
                    where: {
                        userId_requestId: {
                            userId: args.userId,
                            requestId: args.requestId,
                        },
                    },
                });
                if (existing) {
                    assertSamePayload(existing, payloadHash);
                    return { batch: existing, created: false };
                }

                const [ownedGames, user] = await Promise.all([
                    tx.analyzedGame.findMany({
                        where: { userId: args.userId, id: { in: gameIds } },
                        select: { id: true },
                    }),
                    tx.user.findUnique({
                        where: { id: args.userId },
                        select: { preferences: true },
                    }),
                ]);
                if (ownedGames.length !== gameIds.length) {
                    throw new AnalysisBatchGamesUnavailableError();
                }

                const { config } = serverAnalysisConfigFromPreferences(
                    user?.preferences,
                    args.analysisDefaults
                );
                const batch = await tx.analysisBatch.create({
                    data: {
                        userId: args.userId,
                        requestId: args.requestId,
                        payloadHash,
                        force: args.force,
                        queuedReason: args.force
                            ? 'manual-reanalysis'
                            : 'manual',
                        configSnapshot: config.snapshot,
                        configHash: config.hash,
                        analysisQuality: config.analysisQuality,
                        creditCost: config.creditCost,
                        totalItems: gameIds.length,
                        pendingItems: gameIds.length,
                    },
                });
                await tx.analysisBatchItem.createMany({
                    data: gameIds.map((gameId) => ({
                        batchId: batch.id,
                        userId: args.userId,
                        gameId,
                    })),
                });
                await tx.analysisOutbox.create({
                    data: {
                        batchId: batch.id,
                        kind: 'ANALYSIS_BATCH_PLAN',
                        idempotencyKey: initialPlanKey(batch.id),
                        payload: planPayload(batch.id),
                    },
                });
                return { batch, created: true };
            }, serializableTransactionOptions());
        } catch (error) {
            if (attempt < 3 && isRetryableWrite(error)) continue;
            if (isUniqueError(error)) {
                const existing = await prisma.analysisBatch.findUnique({
                    where: {
                        userId_requestId: {
                            userId: args.userId,
                            requestId: args.requestId,
                        },
                    },
                });
                if (existing) {
                    assertSamePayload(existing, payloadHash);
                    return { batch: existing, created: false };
                }
            }
            throw error;
        }
    }
    throw new Error('Analysis batch creation retry limit exceeded');
}

export async function getOwnedAnalysisBatchByRequestId(
    userId: string,
    requestId: string
) {
    return prisma.analysisBatch.findUnique({
        where: { userId_requestId: { userId, requestId } },
    });
}

export async function getOwnedAnalysisBatch(
    userId: string,
    batchId: string,
    options: { cursor?: string; limit?: number } = {}
) {
    const batch = await prisma.analysisBatch.findFirst({
        where: { id: batchId, userId },
    });
    if (!batch) return null;
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
    const items = await prisma.analysisBatchItem.findMany({
        where: { batchId, ...(options.cursor ? { id: { gt: options.cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: limit + 1,
        select: {
            id: true,
            gameId: true,
            status: true,
            analysisJobId: true,
            analysisRunId: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
            analysisJob: {
                select: { status: true, attempts: true, lastError: true },
            },
            analysisRun: {
                select: {
                    status: true,
                    consumedCredits: true,
                    completedAt: true,
                },
            },
        },
    });
    const hasMore = items.length > limit;
    const page = items.slice(0, limit);
    return {
        batch: await analysisBatchSummary(batch),
        items: page,
        nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    };
}

export async function analysisBatchSummary(
    batch: AnalysisBatch
): Promise<AnalysisBatchSummary> {
    const jobCounts = await prisma.analysisBatchItem.groupBy({
        by: ['status'],
        where: { batchId: batch.id },
        _count: { _all: true },
    });
    const linkedRuns = await prisma.analysisRun.groupBy({
        by: ['status'],
        where: {
            batchItems: {
                some: {
                    batchId: batch.id,
                    status: { in: ['QUEUED', 'ATTACHED'] },
                },
            },
        },
        _count: { _all: true },
    });
    const items = countsByStatus(jobCounts);
    const runs = countsByStatus(linkedRuns);
    return {
        id: batch.id,
        requestId: batch.requestId,
        status: batch.status,
        force: batch.force,
        analysisQuality: batch.analysisQuality,
        creditCost: batch.creditCost,
        configHash: batch.configHash,
        counts: {
            total: batch.totalItems,
            pending: (items.PENDING ?? 0) + (items.PLANNING ?? 0),
            queued: runs.QUEUED ?? 0,
            attached: items.ATTACHED ?? 0,
            skipped: items.SKIPPED ?? 0,
            failed: items.FAILED ?? 0,
            cancelled: items.CANCELLED ?? 0,
            running: runs.RUNNING ?? 0,
            succeeded: runs.SUCCEEDED ?? 0,
            jobFailed: runs.FAILED ?? 0,
            jobCancelled: runs.CANCELLED ?? 0,
        },
        completedAt: batch.completedAt,
        lastError: batch.lastError,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
    };
}

export async function processAnalysisBatchPage(
    batchId: string,
    requestedLimit = DEFAULT_PAGE_SIZE
): Promise<{
    batchId: string;
    claimed: number;
    queued: number;
    attached: number;
    skipped: number;
    failed: number;
    remaining: number;
    continuationOutboxId: string | null;
}> {
    const limit = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(requestedLimit)));
    const batch = await prisma.analysisBatch.findUnique({
        where: { id: batchId },
    });
    if (!batch) throw new Error('Analysis batch not found');
    if (isTerminalBatchStatus(batch.status)) {
        return {
            batchId,
            claimed: 0,
            queued: 0,
            attached: 0,
            skipped: 0,
            failed: 0,
            remaining: 0,
            continuationOutboxId: null,
        };
    }
    const token = randomUUID();
    const now = new Date();
    const planningUntil = new Date(now.getTime() + PLANNING_LEASE_MS);
    const claimed = await prisma.$transaction(async (tx) => {
        await tx.analysisBatchItem.updateMany({
            where: {
                batchId,
                status: 'PLANNING',
                planningUntil: { lte: now },
            },
            data: { status: 'PENDING', planningToken: null, planningUntil: null },
        });
        const candidates = await tx.analysisBatchItem.findMany({
            where: { batchId, status: 'PENDING' },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: limit,
            select: { id: true },
        });
        const ids: string[] = [];
        for (const candidate of candidates) {
            const claim = await tx.analysisBatchItem.updateMany({
                where: { id: candidate.id, batchId, status: 'PENDING' },
                data: { status: 'PLANNING', planningToken: token, planningUntil },
            });
            if (claim.count === 1) ids.push(candidate.id);
        }
        if (ids.length > 0) {
            await tx.analysisBatch.updateMany({
                where: { id: batchId, status: { in: ['PENDING', 'PLANNING'] } },
                data: { status: 'PLANNING' },
            });
        }
        return tx.analysisBatchItem.findMany({
            where: { id: { in: ids }, planningToken: token },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
    }, serializableTransactionOptions());

    const config = batchConfig(batch);
    const result = { queued: 0, attached: 0, skipped: 0, failed: 0 };

    for (const item of claimed) {
        try {
            const enqueued = await enqueueAnalysisJob({
                userId: batch.userId,
                gameId: item.gameId,
                queuedReason: batch.queuedReason,
                force: batch.force,
                config,
                batchItem: {
                    id: item.id,
                    batchId,
                    planningToken: token,
                },
            });
            const status: AnalysisBatchItemStatus =
                enqueued.batchItemStatus ??
                (enqueued.queued
                    ? 'QUEUED'
                    : enqueued.job.status === 'QUEUED' ||
                        enqueued.job.status === 'RUNNING'
                      ? 'ATTACHED'
                      : 'SKIPPED');
            result[
                status === 'QUEUED'
                    ? 'queued'
                    : status === 'ATTACHED'
                      ? 'attached'
                      : 'skipped'
            ] += 1;
        } catch (error) {
            if (!isTerminalEnqueueError(error)) {
                await prisma.analysisBatchItem.updateMany({
                    where: {
                        batchId,
                        status: 'PLANNING',
                        planningToken: token,
                    },
                    data: {
                        status: 'PENDING',
                        planningToken: null,
                        planningUntil: null,
                    },
                });
                throw error;
            }
            result.failed += 1;
            await prisma.analysisBatchItem.updateMany({
                where: { id: item.id, status: 'PLANNING', planningToken: token },
                data: {
                    status: 'FAILED',
                    planningToken: null,
                    planningUntil: null,
                    lastError: errorMessage(error),
                },
            });
        }
    }

    const final = await refreshAnalysisBatchAggregate(batchId);
    let continuationOutboxId: string | null = null;
    if (final.remaining > 0 && final.nextPendingItemId) {
        const outbox = await prisma.analysisOutbox.upsert({
            where: {
                idempotencyKey: continuationPlanKey(
                    batchId,
                    final.nextPendingItemId
                ),
            },
            update: {},
            create: {
                batchId,
                kind: 'ANALYSIS_BATCH_PLAN',
                idempotencyKey: continuationPlanKey(
                    batchId,
                    final.nextPendingItemId
                ),
                payload: planPayload(batchId),
            },
        });
        continuationOutboxId = outbox.id;
    }

    return {
        batchId,
        claimed: claimed.length,
        ...result,
        remaining: final.remaining,
        continuationOutboxId,
    };
}

export async function refreshAnalysisBatchAggregate(batchId: string) {
    return prisma.$transaction(async (tx) => {
        const rows = await tx.analysisBatchItem.groupBy({
            by: ['status'],
            where: { batchId },
            _count: { _all: true },
        });
        const counts = countsByStatus(rows);
        const remaining = (counts.PENDING ?? 0) + (counts.PLANNING ?? 0);
        const failed = counts.FAILED ?? 0;
        const linkedItems = await tx.analysisBatchItem.findMany({
            where: {
                batchId,
                status: { in: ['QUEUED', 'ATTACHED'] },
            },
            select: { analysisRun: { select: { status: true } } },
        });
        const activeJobs = linkedItems.filter(
            (item) =>
                !item.analysisRun ||
                item.analysisRun.status === 'QUEUED' ||
                item.analysisRun.status === 'RUNNING'
        ).length;
        const succeededJobs = linkedItems.filter(
            (item) => item.analysisRun?.status === 'SUCCEEDED'
        ).length;
        const failedJobs = linkedItems.filter(
            (item) => item.analysisRun?.status === 'FAILED'
        ).length;
        const cancelledJobs = linkedItems.filter(
            (item) => item.analysisRun?.status === 'CANCELLED'
        ).length;
        const terminal = remaining === 0 && activeJobs === 0;
        const successful = succeededJobs + (counts.SKIPPED ?? 0);
        const unsuccessful = failed + failedJobs + cancelledJobs + (counts.CANCELLED ?? 0);
        const status = !terminal
            ? remaining > 0
                ? 'PLANNING'
                : 'QUEUED'
            : unsuccessful === 0
              ? 'COMPLETED'
              : successful === 0
                ? 'FAILED'
                : 'PARTIAL';
        const persistedBatch = await tx.analysisBatch.findUnique({
            where: { id: batchId },
            select: { completedAt: true },
        });
        await tx.analysisBatch.update({
            where: { id: batchId },
            data: {
                status,
                pendingItems: remaining,
                queuedItems: counts.QUEUED ?? 0,
                attachedItems: counts.ATTACHED ?? 0,
                skippedItems: counts.SKIPPED ?? 0,
                failedItems: failed,
                cancelledItems: counts.CANCELLED ?? 0,
                completedAt: terminal
                    ? (persistedBatch?.completedAt ?? new Date())
                    : null,
            },
        });
        const next = remaining
            ? await tx.analysisBatchItem.findFirst({
                  where: { batchId, status: 'PENDING' },
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                  select: { id: true },
              })
            : null;
        return { remaining, nextPendingItemId: next?.id ?? null };
    }, serializableTransactionOptions());
}

export async function reconcileAnalysisBatchCompletions(limit = 100): Promise<{
    scanned: number;
    completed: number;
    partial: number;
    failed: number;
}> {
    const batches = await prisma.analysisBatch.findMany({
        where: {
            status: { in: ['PENDING', 'PLANNING', 'QUEUED'] },
        },
        orderBy: { updatedAt: 'asc' },
        take: Math.max(1, Math.min(500, Math.trunc(limit))),
        select: { id: true },
    });
    const result = {
        scanned: batches.length,
        completed: 0,
        partial: 0,
        failed: 0,
    };
    for (const batch of batches) {
        await refreshAnalysisBatchAggregate(batch.id);
        const current = await prisma.analysisBatch.findUnique({
            where: { id: batch.id },
            select: { status: true },
        });
        if (current?.status === 'COMPLETED') result.completed += 1;
        if (current?.status === 'PARTIAL') result.partial += 1;
        if (current?.status === 'FAILED') result.failed += 1;
    }
    return result;
}

export async function recoverAnalysisBatchPlanOutbox(limit = 100): Promise<{
    scanned: number;
    recovered: number;
}> {
    const now = new Date();
    const batches = await prisma.analysisBatch.findMany({
        where: {
            status: { in: ['PENDING', 'PLANNING', 'QUEUED'] },
            items: {
                some: {
                    OR: [
                        { status: 'PENDING' },
                        { status: 'PLANNING', planningUntil: { lte: now } },
                    ],
                },
            },
        },
        orderBy: { updatedAt: 'asc' },
        take: Math.max(1, Math.min(500, Math.trunc(limit))),
        select: { id: true },
    });
    let recovered = 0;
    for (const batch of batches) {
        try {
            const created = await prisma.$transaction(async (tx) => {
                const active = await tx.analysisOutbox.findFirst({
                    where: {
                        batchId: batch.id,
                        kind: 'ANALYSIS_BATCH_PLAN',
                        OR: [
                            { status: 'PENDING' },
                            { status: 'LEASED', lockedUntil: { gt: now } },
                        ],
                    },
                    select: { id: true },
                });
                if (active) return false;
                const next = await tx.analysisBatchItem.findFirst({
                    where: {
                        batchId: batch.id,
                        OR: [
                            { status: 'PENDING' },
                            {
                                status: 'PLANNING',
                                planningUntil: { lte: now },
                            },
                        ],
                    },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    select: { id: true },
                });
                if (!next) return false;
                const generation = await tx.analysisOutbox.count({
                    where: {
                        batchId: batch.id,
                        kind: 'ANALYSIS_BATCH_PLAN',
                    },
                });
                await tx.analysisOutbox.create({
                    data: {
                        batchId: batch.id,
                        kind: 'ANALYSIS_BATCH_PLAN',
                        idempotencyKey: `analysis-batch:${batch.id}:plan:recovery:${next.id}:${generation}`,
                        payload: planPayload(batch.id),
                    },
                });
                return true;
            }, serializableTransactionOptions());
            if (created) recovered += 1;
        } catch (error) {
            if (!isRetryableWrite(error)) throw error;
            // A concurrent recovery won the deterministic outbox generation.
        }
    }
    return { scanned: batches.length, recovered };
}

function batchConfig(batch: AnalysisBatch): ServerAnalysisConfig {
    return {
        snapshot: batch.configSnapshot as Prisma.InputJsonObject,
        hash: batch.configHash,
        analysisQuality: batch.analysisQuality,
        creditCost: batch.creditCost,
    };
}

function canonicalGameIds(gameIds: string[]) {
    return Array.from(new Set(gameIds)).sort();
}

function hashBatchPayload(value: {
    gameIds: string[];
    force: boolean;
    analysisDefaults?: AnalysisDefaults;
}) {
    return createHash('sha256')
        .update(
            stableCanonicalStringify({
                gameIds: value.gameIds,
                force: value.force,
                analysisDefaults: value.analysisDefaults ?? null,
            })
        )
        .digest('hex');
}

function assertSamePayload(batch: AnalysisBatch, payloadHash: string) {
    if (batch.payloadHash !== payloadHash) {
        throw new AnalysisBatchRequestConflictError();
    }
}

function countsByStatus(
    rows: Array<{ status: string; _count: { _all: number } }>
) {
    return Object.fromEntries(rows.map((row) => [row.status, row._count._all])) as Record<string, number>;
}

function planPayload(batchId: string) {
    return { type: 'analysis-batch', batchId } satisfies Prisma.InputJsonObject;
}

function initialPlanKey(batchId: string) {
    return `analysis-batch:${batchId}:plan:initial`;
}

function continuationPlanKey(batchId: string, nextPendingItemId: string) {
    return `analysis-batch:${batchId}:plan:${nextPendingItemId}`;
}

function errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function isTerminalEnqueueError(error: unknown) {
    return (
        error instanceof BillingAccountError ||
        error instanceof AnalysisJobOwnershipError ||
        error instanceof AnalysisJobConfigurationConflictError
    );
}

function isTerminalBatchStatus(status: string) {
    return (
        status === 'COMPLETED' ||
        status === 'PARTIAL' ||
        status === 'FAILED' ||
        status === 'CANCELLED'
    );
}

function isUniqueError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isRetryableWrite(error: unknown) {
    return isUniqueError(error) ||
        (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'P2034');
}

function serializableTransactionOptions() {
    return { isolationLevel: Prisma.TransactionIsolationLevel.Serializable };
}
