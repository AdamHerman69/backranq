import { randomUUID } from 'node:crypto';
import { Prisma, type AnalysisOutboxKind } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    publishBackranqQueueMessage,
    type BackranqQueueMessage,
    type BackranqQueuePublishResult,
} from '@/lib/queues/backranq';
import { refreshAnalysisBatchAggregate } from '@/lib/services/analysisBatches';
import {
    cancelUnavailableAnalysisBatch,
    cancelUnexecutableAnalysisJobs,
} from '@/lib/services/analysisQueueCancellation';

export const DEFAULT_ANALYSIS_OUTBOX_FLUSH_LIMIT = 25;
export const DEFAULT_ANALYSIS_OUTBOX_LEASE_MS = 60_000;
const OUTBOX_BACKOFF_BASE_MS = 15_000;
const OUTBOX_BACKOFF_MAX_MS = 15 * 60_000;

type OutboxDb = Prisma.TransactionClient | typeof prisma;

type ClaimedOutboxRow = {
    id: string;
    batchId: string | null;
    analysisJobId: string | null;
    kind: AnalysisOutboxKind;
    idempotencyKey: string;
    payload: Prisma.JsonValue;
    attempts: number;
    leaseToken: string;
};

export type FlushAnalysisOutboxItem = {
    id: string;
    queued: boolean;
    messageId: string | null;
    status: 'PUBLISHED' | 'PENDING' | 'FAILED' | 'LEASED';
    error?: string;
};

export async function stageAnalysisOutboxMessage(args: {
    tx?: OutboxDb;
    kind: AnalysisOutboxKind;
    idempotencyKey: string;
    message: BackranqQueueMessage;
    availableAt?: Date;
    batchId?: string | null;
    analysisJobId?: string | null;
}) {
    const db = args.tx ?? prisma;
    return db.analysisOutbox.upsert({
        where: { idempotencyKey: args.idempotencyKey },
        create: {
            kind: args.kind,
            idempotencyKey: args.idempotencyKey,
            payload: args.message as unknown as Prisma.InputJsonObject,
            availableAt: args.availableAt ?? new Date(),
            batchId: args.batchId ?? null,
            analysisJobId: args.analysisJobId ?? null,
        },
        update: {},
    });
}

export async function recoverExpiredAnalysisOutboxLeases(args: {
    now?: Date;
} = {}) {
    const now = args.now ?? new Date();
    return prisma.analysisOutbox.updateMany({
        where: {
            status: 'LEASED',
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
        },
        data: {
            status: 'PENDING',
            leaseToken: null,
            lockedUntil: null,
        },
    });
}

export async function flushAnalysisOutbox(args: {
    limit?: number;
    now?: Date;
    leaseMs?: number;
    publish?: typeof publishBackranqQueueMessage;
} = {}) {
    const now = args.now ?? new Date();
    const limit = boundedLimit(args.limit);
    const publish = args.publish ?? publishBackranqQueueMessage;
    await recoverExpiredAnalysisOutboxLeases({ now });

    const claimed = await claimDueOutboxRows({
        now,
        limit,
        leaseMs: args.leaseMs ?? DEFAULT_ANALYSIS_OUTBOX_LEASE_MS,
    });
    const items: FlushAnalysisOutboxItem[] = [];

    for (const row of claimed) {
        const message = parseOutboxMessage(row.payload);
        if (!message) {
            const error = 'Invalid analysis outbox payload';
            await markOutboxFailed(row, error);
            items.push({
                id: row.id,
                queued: false,
                messageId: null,
                status: 'FAILED',
                error,
            });
            continue;
        }

        let result: BackranqQueuePublishResult;
        try {
            result = await publish(message, {
                idempotencyKey: row.idempotencyKey,
            });
        } catch (error) {
            // The normal publisher is total, but preserve the outbox contract if
            // an injected/custom publisher violates it.
            result = {
                queued: false,
                messageId: null,
                unavailableReason: 'publish-failed',
                error,
            };
        }

        if (!result.queued) {
            const error =
                result.unavailableReason === 'disabled'
                    ? 'Server analysis queue is disabled'
                    : errorMessage(
                          result.error ??
                              result.unavailableReason ??
                              'queue unavailable'
                      );
            if (result.unavailableReason === 'disabled') {
                try {
                    await cancelDisabledOutboxWork(row, error);
                    await markOutboxFailed(row, error);
                    items.push({
                        id: row.id,
                        queued: false,
                        messageId: null,
                        status: 'FAILED',
                        error,
                    });
                } catch (cancellationError) {
                    const cancellationMessage = errorMessage(cancellationError);
                    await rescheduleOutboxRow(row, now, cancellationMessage);
                    items.push({
                        id: row.id,
                        queued: false,
                        messageId: null,
                        status: 'PENDING',
                        error: cancellationMessage,
                    });
                }
                continue;
            }
            await rescheduleOutboxRow(row, now, error);
            items.push({
                id: row.id,
                queued: false,
                messageId: null,
                status: 'PENDING',
                error,
            });
            continue;
        }

        try {
            const marked = await prisma.analysisOutbox.updateMany({
                where: {
                    id: row.id,
                    status: 'LEASED',
                    leaseToken: row.leaseToken,
                },
                data: {
                    status: 'PUBLISHED',
                    messageId: result.messageId,
                    publishedAt: new Date(),
                    lastError: null,
                    leaseToken: null,
                    lockedUntil: null,
                },
            });
            if (marked.count !== 1) {
                throw new Error('Published outbox lease was lost before commit');
            }
            items.push({
                id: row.id,
                queued: true,
                messageId: result.messageId,
                status: 'PUBLISHED',
            });
        } catch (error) {
            // Do not change the lease here. On expiry the row is republished
            // with the same idempotency key, so a send/commit ambiguity is safe.
            logOutboxError('analysis_outbox_publish_commit_failed', row, error, {
                messageId: result.messageId,
            });
            items.push({
                id: row.id,
                queued: true,
                messageId: result.messageId,
                status: 'LEASED',
                error: errorMessage(error),
            });
        }
    }

    return {
        claimed: claimed.length,
        published: items.filter((item) => item.status === 'PUBLISHED').length,
        pending: items.filter((item) => item.status === 'PENDING').length,
        failed: items.filter((item) => item.status === 'FAILED').length,
        ambiguous: items.filter((item) => item.status === 'LEASED').length,
        items,
    };
}

async function claimDueOutboxRows(args: {
    now: Date;
    limit: number;
    leaseMs: number;
}) {
    if (args.limit <= 0) return [];
    const leaseToken = randomUUID();
    const lockedUntil = new Date(
        args.now.getTime() + Math.max(1_000, args.leaseMs)
    );
    return prisma.$transaction((tx) =>
        tx.$queryRaw<ClaimedOutboxRow[]>(Prisma.sql`
            WITH candidates AS (
                SELECT "id"
                FROM "AnalysisOutbox"
                WHERE "status" = 'PENDING'::"AnalysisOutboxStatus"
                  AND "availableAt" <= ${args.now}
                ORDER BY "availableAt" ASC, "createdAt" ASC, "id" ASC
                LIMIT ${args.limit}
                FOR UPDATE SKIP LOCKED
            )
            UPDATE "AnalysisOutbox" AS outbox
            SET "status" = 'LEASED'::"AnalysisOutboxStatus",
                "leaseToken" = ${leaseToken}::uuid,
                "lockedUntil" = ${lockedUntil},
                "attempts" = outbox."attempts" + 1,
                "updatedAt" = NOW()
            FROM candidates
            WHERE outbox."id" = candidates."id"
            RETURNING outbox."id", outbox."batchId", outbox."analysisJobId",
                      outbox."kind", outbox."idempotencyKey", outbox."payload",
                      outbox."attempts", outbox."leaseToken"
        `)
    );
}

async function cancelDisabledOutboxWork(
    row: ClaimedOutboxRow,
    reason: string
) {
    if (row.kind === 'ANALYSIS_BATCH_PLAN' && row.batchId) {
        await cancelUnavailableAnalysisBatch({
            batchId: row.batchId,
            reason,
        });
        await refreshAnalysisBatchAggregate(row.batchId);
        return;
    }
    if (row.kind === 'ANALYSIS_JOB' && row.analysisJobId) {
        const job = await prisma.analysisJob.findUnique({
            where: { id: row.analysisJobId },
            select: { userId: true },
        });
        if (job) {
            await cancelUnexecutableAnalysisJobs({
                userId: job.userId,
                jobIds: [row.analysisJobId],
                reason,
            });
        }
    }
}

async function rescheduleOutboxRow(
    row: ClaimedOutboxRow,
    now: Date,
    error: string
) {
    const backoffMs = Math.min(
        OUTBOX_BACKOFF_MAX_MS,
        OUTBOX_BACKOFF_BASE_MS *
            2 ** Math.min(20, Math.max(0, row.attempts - 1))
    );
    await prisma.analysisOutbox.updateMany({
        where: {
            id: row.id,
            status: 'LEASED',
            leaseToken: row.leaseToken,
        },
        data: {
            status: 'PENDING',
            availableAt: new Date(now.getTime() + backoffMs),
            leaseToken: null,
            lockedUntil: null,
            lastError: error.slice(0, 2_000),
        },
    });
}

async function markOutboxFailed(row: ClaimedOutboxRow, error: string) {
    await prisma.analysisOutbox.updateMany({
        where: {
            id: row.id,
            status: 'LEASED',
            leaseToken: row.leaseToken,
        },
        data: {
            status: 'FAILED',
            leaseToken: null,
            lockedUntil: null,
            lastError: error.slice(0, 2_000),
        },
    });
}

function parseOutboxMessage(value: Prisma.JsonValue): BackranqQueueMessage | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const type = value.type;
    if (typeof type !== 'string') return null;
    if (type === 'analysis-job') {
        return typeof value.jobId === 'string' &&
            typeof value.dispatchToken === 'string'
            ? {
                  type,
                  jobId: value.jobId,
                  dispatchToken: value.dispatchToken,
              }
            : null;
    }
    if (type === 'analysis-batch') {
        return typeof value.batchId === 'string'
            ? { type, batchId: value.batchId }
            : null;
    }
    if (type === 'dispatch-analysis') {
        return typeof value.requestedAt === 'string'
            ? { type, requestedAt: value.requestedAt }
            : null;
    }
    return null;
}

function boundedLimit(value: number | undefined) {
    if (value == null || !Number.isFinite(value)) {
        return DEFAULT_ANALYSIS_OUTBOX_FLUSH_LIMIT;
    }
    return Math.max(0, Math.min(100, Math.trunc(value)));
}

function errorMessage(error: unknown) {
    return error instanceof Error
        ? error.message.slice(0, 2_000)
        : String(error).slice(0, 2_000);
}

function logOutboxError(
    event: string,
    row: ClaimedOutboxRow,
    error: unknown,
    context: Record<string, unknown> = {}
) {
    const normalized = normalizeError(error);
    console.error(
        JSON.stringify({
            level: 'error',
            event,
            outboxId: row.id,
            outboxKind: row.kind,
            attempts: row.attempts,
            ...context,
            error: normalized,
        })
    );
}

export function normalizeError(error: unknown) {
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
