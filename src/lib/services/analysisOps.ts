import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    consumeServerAnalysisCredits,
    releaseServerAnalysisCreditsAndMarkRunReleased,
} from '@/lib/services/billingAccounts';

export type AnalysisOpsSnapshot = {
    analysisJobs: {
        queued: number;
        running: number;
        failed: number;
        lockedQueued: number;
        readyQueued: number;
        retryScheduled: number;
        settlementPending: number;
        publishPending: number;
        totalDispatches: number;
        staleDeliveries: number;
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
        expired: number;
        outstandingReserved: number;
        invariantViolations: {
            activeWithoutReservation: number;
            terminalWithOutstandingReservation: number;
            oversettled: number;
        };
    };
    stripeWebhooks: {
        processing: number;
        succeeded: number;
        failed: number;
        recentErrors: Array<{ id: string; type: string; error: string }>;
    };
};

const STALE_ANALYSIS_DELIVERIES_COUNTER =
    'analysis_stale_deliveries_total';

type CreditInvariantRow = {
    activeWithoutReservation: bigint | number;
    terminalWithOutstandingReservation: bigint | number;
    oversettled: bigint | number;
};

export async function recordStaleAnalysisDelivery() {
    try {
        await prisma.analysisOpsCounter.upsert({
            where: { key: STALE_ANALYSIS_DELIVERIES_COUNTER },
            create: {
                key: STALE_ANALYSIS_DELIVERIES_COUNTER,
                value: BigInt(1),
            },
            update: { value: { increment: BigInt(1) } },
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: 'analysis_stale_delivery_metric_failed',
                error: error instanceof Error ? error.message : String(error),
            })
        );
    }
}

export type AnalysisCreditReconciliationResult = {
    scanned: number;
    consumed: number;
    released: number;
    errors: Array<{ jobId: string; action: 'consume' | 'release'; error: string }>;
};

export async function reconcileAnalysisCreditSettlements(args: {
    limit?: number;
} = {}): Promise<AnalysisCreditReconciliationResult> {
    const limit = Math.max(1, Math.min(500, Math.trunc(args.limit ?? 100)));
    const runs = await prisma.analysisRun.findMany({
        where: {
            status: { in: ['SUCCEEDED', 'FAILED', 'CANCELLED'] },
            OR: [
                {
                    lastError: {
                        startsWith: 'CREDIT_SETTLEMENT_PENDING:',
                    },
                },
                {
                    creditLedgerEntries: {
                        some: { type: 'RESERVED' },
                        none: {
                            type: {
                                in: [
                                    'CONSUMED',
                                    'RELEASED',
                                    'EXPIRED',
                                ],
                            },
                        },
                    },
                },
            ],
        },
        orderBy: [{ completedAt: 'asc' }, { updatedAt: 'asc' }],
        take: limit,
        select: {
            id: true,
            userId: true,
            gameId: true,
            status: true,
            creditCost: true,
            lastError: true,
            creditLedgerEntries: {
                where: { type: 'RESERVED' },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: { analysisJobId: true },
            },
        },
    });

    const result: AnalysisCreditReconciliationResult = {
        scanned: runs.length,
        consumed: 0,
        released: 0,
        errors: [],
    };

    for (const run of runs) {
        const analysisJobId = run.creditLedgerEntries[0]?.analysisJobId;
        const action =
            run.lastError?.startsWith('CREDIT_SETTLEMENT_PENDING:release:')
                ? 'release'
                : run.status === 'SUCCEEDED'
                  ? 'consume'
                  : 'release';
        const ref = {
            userId: run.userId,
            gameId: run.gameId,
            analysisJobId,
            analysisRunId: run.id,
            credits: run.creditCost,
            idempotencyKey: `analysis-run:${run.id}:${action}`,
            reason: 'analysis-credit-reconciliation',
        };
        try {
            if (action === 'consume') {
                await consumeServerAnalysisCredits(ref);
                result.consumed += 1;
            } else {
                await releaseServerAnalysisCreditsAndMarkRunReleased({
                    ...ref,
                    analysisRunId: run.id,
                });
                result.released += 1;
            }
            await prisma.$transaction(async (tx) => {
                await tx.analysisJob.updateMany({
                    where: {
                        analysisRunId: run.id,
                        lastError: {
                            startsWith: 'CREDIT_SETTLEMENT_PENDING:',
                        },
                    },
                    data: { lastError: null },
                });
                await tx.analysisRun.updateMany({
                    where: {
                        id: run.id,
                        status: run.status,
                    },
                    data: {
                        consumedCredits: action === 'consume' ? ref.credits : 0,
                    },
                });
                await tx.analysisRun.updateMany({
                    where: {
                        id: run.id,
                        status: run.status,
                        lastError: {
                            startsWith: 'CREDIT_SETTLEMENT_PENDING:',
                        },
                    },
                    data: {
                        lastError: null,
                    },
                });
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error);
            result.errors.push({
                jobId: analysisJobId ?? `run:${run.id}`,
                action,
                error: message,
            });
            console.error(
                JSON.stringify({
                    event: 'analysis_credit_reconciliation_failed',
                    jobId: analysisJobId ?? null,
                    analysisRunId: run.id,
                    action,
                    error: message,
                })
            );
        }
    }

    return result;
}

export async function getAnalysisOpsSnapshot(args: { now?: Date } = {}) {
    const now = args.now ?? new Date();
    const [
        queued,
        running,
        failed,
        lockedQueued,
        readyQueued,
        retryScheduled,
        settlementPending,
        publishPending,
        dispatchTotals,
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
        staleDeliveryCounter,
        creditInvariantRows,
    ] = await Promise.all([
        prisma.analysisJob.count({ where: { status: 'QUEUED' } }),
        prisma.analysisJob.count({ where: { status: 'RUNNING' } }),
        prisma.analysisJob.count({ where: { status: 'FAILED' } }),
        prisma.analysisJob.count({
            where: { status: 'QUEUED', lockedUntil: { gt: now } },
        }),
        prisma.analysisJob.count({
            where: {
                status: 'QUEUED',
                OR: [{ scheduledFor: null }, { scheduledFor: { lte: now } }],
                AND: [
                    {
                        OR: [
                            { lockedUntil: null },
                            { lockedUntil: { lte: now } },
                        ],
                    },
                ],
            },
        }),
        prisma.analysisJob.count({
            where: { status: 'QUEUED', scheduledFor: { gt: now } },
        }),
        prisma.analysisJob.count({
            where: {
                lastError: { startsWith: 'CREDIT_SETTLEMENT_PENDING:' },
            },
        }),
        prisma.analysisJob.count({
            where: { lastError: { startsWith: 'QUEUE_PUBLISH_PENDING:' } },
        }),
        prisma.analysisJob.aggregate({
            _sum: { dispatchedCount: true },
        }),
        prisma.analysisJob.count({
            where: {
                status: 'RUNNING',
                OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
            },
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
        prisma.analysisOpsCounter.findUnique({
            where: { key: STALE_ANALYSIS_DELIVERIES_COUNTER },
            select: { value: true },
        }),
        prisma.$queryRaw<CreditInvariantRow[]>(Prisma.sql`
            WITH "runCredits" AS (
                SELECT
                    "analysisRunId",
                    COALESCE(SUM("credits") FILTER (WHERE "type" = 'RESERVED'), 0)::bigint AS "reserved",
                    COALESCE(SUM("credits") FILTER (WHERE "type" = 'CONSUMED'), 0)::bigint AS "consumed",
                    COALESCE(SUM("credits") FILTER (WHERE "type" = 'REFUNDED'), 0)::bigint AS "refunded",
                    COALESCE(SUM("credits") FILTER (WHERE "type" = 'RELEASED'), 0)::bigint AS "released",
                    COALESCE(SUM("credits") FILTER (WHERE "type" = 'EXPIRED'), 0)::bigint AS "expired"
                FROM "CreditLedgerEntry"
                WHERE "analysisRunId" IS NOT NULL
                GROUP BY "analysisRunId"
            ),
            "serverRuns" AS (
                SELECT
                    run."status",
                    COALESCE(credits."reserved", 0)::bigint AS "reserved",
                    COALESCE(credits."consumed", 0)::bigint AS "consumed",
                    COALESCE(credits."refunded", 0)::bigint AS "refunded",
                    COALESCE(credits."released", 0)::bigint AS "released",
                    COALESCE(credits."expired", 0)::bigint AS "expired"
                FROM "AnalysisRun" run
                LEFT JOIN "runCredits" credits
                    ON credits."analysisRunId" = run."id"
                WHERE run."executionMode" = 'SERVER_QUEUE'
            )
            SELECT
                COUNT(*) FILTER (
                    WHERE "status" IN ('QUEUED', 'RUNNING')
                      AND "reserved" - "consumed" - "released" - "expired" <= 0
                )::bigint AS "activeWithoutReservation",
                COUNT(*) FILTER (
                    WHERE "status" IN ('SUCCEEDED', 'FAILED', 'CANCELLED')
                      AND "reserved" - "consumed" - "released" - "expired" > 0
                )::bigint AS "terminalWithOutstandingReservation",
                COUNT(*) FILTER (
                    WHERE "consumed" + "released" + "expired" > "reserved"
                       OR "refunded" > "consumed"
                )::bigint AS "oversettled"
            FROM "serverRuns"
        `),
    ]);

    const credits = {
        reserved: 0,
        consumed: 0,
        refunded: 0,
        released: 0,
        expired: 0,
        outstandingReserved: 0,
        invariantViolations: {
            activeWithoutReservation: 0,
            terminalWithOutstandingReservation: 0,
            oversettled: 0,
        },
    };
    for (const row of creditRows) {
        const value = row._sum.credits ?? 0;
        if (row.type === 'RESERVED') credits.reserved = value;
        if (row.type === 'CONSUMED') credits.consumed = value;
        if (row.type === 'REFUNDED') credits.refunded = value;
        if (row.type === 'RELEASED') credits.released = value;
        if (row.type === 'EXPIRED') credits.expired = value;
    }
    credits.outstandingReserved = Math.max(
        0,
        credits.reserved -
            credits.consumed -
            credits.released -
            credits.expired
    );
    const creditInvariant = creditInvariantRows?.[0];
    credits.invariantViolations = {
        activeWithoutReservation: safeMetricNumber(
            creditInvariant?.activeWithoutReservation
        ),
        terminalWithOutstandingReservation: safeMetricNumber(
            creditInvariant?.terminalWithOutstandingReservation
        ),
        oversettled: safeMetricNumber(creditInvariant?.oversettled),
    };

    return {
        analysisJobs: {
            queued,
            running,
            failed,
            lockedQueued,
            readyQueued,
            retryScheduled,
            settlementPending,
            publishPending,
            totalDispatches: dispatchTotals._sum.dispatchedCount ?? 0,
            staleDeliveries: safeMetricNumber(staleDeliveryCounter?.value),
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

function safeMetricNumber(value: bigint | number | null | undefined) {
    if (value == null) return 0;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0
        ? number
        : Number.MAX_SAFE_INTEGER;
}
