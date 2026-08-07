import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { recordPracticeDue } from '@/lib/notifications/service';
import { PRACTICE_DUE_COUNT_CAP } from '@/lib/training/practiceDue';

export const PRACTICE_DUE_SWEEP_SLICE_SIZE = 256;
export const PRACTICE_DUE_NOTIFY_PAGE_SIZE = 50;
export const PRACTICE_DUE_SWEEP_CLEANUP_PAGE_SIZE = 25;
export const PRACTICE_DUE_SWEEP_RETENTION_MS = 30 * 24 * 60 * 60_000;
const PRACTICE_DUE_NOTIFY_CONCURRENCY = 5;

type LockedSweep = {
    id: string;
    referenceAt: Date;
    status: 'SCANNING' | 'NOTIFYING' | 'COMPLETE';
    cursorNextDueAt: Date | null;
    cursorStateId: string | null;
};

type DueSweepRawRow = {
    stateId: string;
    nextDueAt: Date;
    userId: string | null;
};

function rawCursorSql(sweep: LockedSweep) {
    if (!sweep.cursorNextDueAt || !sweep.cursorStateId) return Prisma.empty;
    return Prisma.sql`AND (state."nextDueAt", state."id") >
        (${sweep.cursorNextDueAt}, ${sweep.cursorStateId}::uuid)`;
}

async function writeAggregatePage(
    tx: Prisma.TransactionClient,
    sweepId: string,
    rows: DueSweepRawRow[],
    now: Date
) {
    const byUser = new Map<
        string,
        { count: number; earliestDueAt: Date }
    >();
    for (const row of rows) {
        if (!row.userId) continue;
        const current = byUser.get(row.userId);
        if (!current) {
            byUser.set(row.userId, {
                count: 1,
                earliestDueAt: row.nextDueAt,
            });
            continue;
        }
        current.count += 1;
        if (row.nextDueAt < current.earliestDueAt) {
            current.earliestDueAt = row.nextDueAt;
        }
    }
    if (byUser.size === 0) return;

    const values = Array.from(byUser, ([userId, aggregate]) =>
        Prisma.sql`(
            ${sweepId}::uuid,
            ${userId}::uuid,
            ${Math.min(aggregate.count, PRACTICE_DUE_COUNT_CAP)},
            ${aggregate.count <= PRACTICE_DUE_COUNT_CAP},
            ${aggregate.earliestDueAt},
            ${now},
            ${now}
        )`
    );
    await tx.$executeRaw(Prisma.sql`
        INSERT INTO "PracticeDueSweepUser" (
            "sweepId",
            "userId",
            "dueCount",
            "dueCountIsExact",
            "earliestDueAt",
            "createdAt",
            "updatedAt"
        )
        VALUES ${Prisma.join(values)}
        ON CONFLICT ("sweepId", "userId") DO UPDATE
        SET
            "dueCount" = LEAST(
                ${PRACTICE_DUE_COUNT_CAP},
                "PracticeDueSweepUser"."dueCount" + EXCLUDED."dueCount"
            ),
            "dueCountIsExact" =
                "PracticeDueSweepUser"."dueCountIsExact"
                AND EXCLUDED."dueCountIsExact"
                AND "PracticeDueSweepUser"."dueCount" +
                    EXCLUDED."dueCount" <= ${PRACTICE_DUE_COUNT_CAP},
            "earliestDueAt" = LEAST(
                "PracticeDueSweepUser"."earliestDueAt",
                EXCLUDED."earliestDueAt"
            ),
            "updatedAt" = EXCLUDED."updatedAt"
    `);
}

/**
 * Advances exactly one durable raw-state slice. The sweep row lock makes a
 * retried or concurrent queue message observe the already committed cursor.
 */
export async function advancePracticeDueSweep(sweepId: string) {
    return prisma.$transaction(async (tx) => {
        const sweep = (
            await tx.$queryRaw<LockedSweep[]>(Prisma.sql`
                SELECT
                    "id",
                    "referenceAt",
                    "status",
                    "cursorNextDueAt",
                    "cursorStateId"
                FROM "PracticeDueSweep"
                WHERE "id" = ${sweepId}::uuid
                FOR UPDATE
            `)
        )[0];
        if (!sweep) throw new Error('Practice due sweep not found');
        if (sweep.status !== 'SCANNING') {
            return { sweepId, status: sweep.status, cursorStateId: null };
        }

        const rows = await tx.$queryRaw<DueSweepRawRow[]>(Prisma.sql`
            WITH "rawDue" AS MATERIALIZED (
                SELECT
                    state."id" AS "stateId",
                    state."userId",
                    state."trainingMomentId",
                    state."solutionHash",
                    state."configHash",
                    state."nextDueAt"
                FROM "PracticeReviewState" state
                WHERE state."nextDueAt" <= ${sweep.referenceAt}
                  ${rawCursorSql(sweep)}
                ORDER BY state."nextDueAt" ASC, state."id" ASC
                LIMIT ${PRACTICE_DUE_SWEEP_SLICE_SIZE}
            )
            SELECT
                raw."stateId",
                raw."nextDueAt",
                candidate."userId"
            FROM "rawDue" raw
            LEFT JOIN LATERAL (
                SELECT moment."userId"
                FROM "TrainingMoment" moment
                INNER JOIN "SolutionRevision" solution
                    ON solution."id" = moment."currentSolutionRevisionId"
                WHERE moment."id" = raw."trainingMomentId"
                  AND moment."userId" = raw."userId"
                  AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
                  AND moment."archivedAt" IS NULL
                  AND solution."trainable" = true
                  AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
                  AND solution."acceptanceFrontier"->>'status' = 'STABLE'
                  AND raw."solutionHash" = solution."solutionHash"
                  AND raw."configHash" = solution."configHash"
                LIMIT 1
            ) candidate ON true
            ORDER BY raw."nextDueAt" ASC, raw."stateId" ASC
        `);
        const now = new Date();
        await writeAggregatePage(tx, sweep.id, rows, now);
        const last = rows.at(-1);
        const scanningComplete = rows.length < PRACTICE_DUE_SWEEP_SLICE_SIZE;
        await tx.practiceDueSweep.update({
            where: { id: sweep.id },
            data: scanningComplete
                ? {
                      status: 'NOTIFYING',
                      cursorNextDueAt: last?.nextDueAt ??
                          sweep.cursorNextDueAt,
                      cursorStateId: last?.stateId ?? sweep.cursorStateId,
                  }
                : {
                      cursorNextDueAt: last?.nextDueAt,
                      cursorStateId: last?.stateId,
                  },
        });
        return {
            sweepId: sweep.id,
            status: scanningComplete
                ? ('NOTIFYING' as const)
                : ('SCANNING' as const),
            cursorStateId: last?.stateId ?? null,
        };
    });
}

async function publishSweepContinuation(result: Awaited<
    ReturnType<typeof advancePracticeDueSweep>
>) {
    if (result.status === 'COMPLETE') return null;
    if (result.status === 'NOTIFYING') {
        return publishBackranqQueueMessage(
            {
                type: 'practice-due-notify',
                sweepId: result.sweepId,
            },
            {
                idempotencyKey: `practice-due-notify:${result.sweepId}:start`,
            }
        );
    }
    return publishBackranqQueueMessage(
        { type: 'practice-due-sweep', sweepId: result.sweepId },
        {
            idempotencyKey: `practice-due-sweep:${result.sweepId}:${result.cursorStateId ?? 'start'}`,
        }
    );
}

function requireDurableQueue(result: { queued: boolean }) {
    if (!result.queued && process.env.NODE_ENV === 'production') {
        throw new Error('Practice due durable queue is unavailable');
    }
    return result;
}

export async function processPracticeDueSweepPage(sweepId: string) {
    const result = await advancePracticeDueSweep(sweepId);
    const continuation = await publishSweepContinuation(result);
    if (continuation) requireDurableQueue(continuation);
    return { ...result, continuationQueued: continuation?.queued ?? false };
}

export async function schedulePracticeDueSweep(referenceAt: Date) {
    const active = await prisma.practiceDueSweep.findFirst({
        where: { status: { in: ['SCANNING', 'NOTIFYING'] } },
        orderBy: [{ referenceAt: 'asc' }, { id: 'asc' }],
        select: { id: true, status: true },
    });
    const sweep =
        active ??
        (await prisma.practiceDueSweep.upsert({
            where: { referenceAt },
            create: { referenceAt },
            update: {},
            select: { id: true, status: true },
        }));
    if (sweep.status === 'COMPLETE') {
        return { sweepId: sweep.id, status: sweep.status, queued: false };
    }
    const message =
        sweep.status === 'SCANNING'
            ? ({ type: 'practice-due-sweep', sweepId: sweep.id } as const)
            : ({ type: 'practice-due-notify', sweepId: sweep.id } as const);
    const queued = requireDurableQueue(
        await publishBackranqQueueMessage(message, {
            idempotencyKey: `${message.type}:${sweep.id}:resume:${referenceAt
                .toISOString()
                .slice(0, 10)}`,
        })
    );
    return { sweepId: sweep.id, status: sweep.status, queued: queued.queued };
}

/** Deletes at most one small page of old completed snapshots; active sweeps
 * never match, and the child aggregates are removed by the cascade. */
export async function cleanupCompletedPracticeDueSweeps(now = new Date()) {
    const cutoff = new Date(
        now.getTime() - PRACTICE_DUE_SWEEP_RETENTION_MS
    );
    const deleted = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH expired AS MATERIALIZED (
            SELECT sweep."id"
            FROM "PracticeDueSweep" sweep
            WHERE sweep."status" = 'COMPLETE'::"PracticeDueSweepStatus"
              AND sweep."completedAt" < ${cutoff}
            ORDER BY sweep."completedAt" ASC, sweep."id" ASC
            LIMIT ${PRACTICE_DUE_SWEEP_CLEANUP_PAGE_SIZE}
            FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "PracticeDueSweep" sweep
        USING expired
        WHERE sweep."id" = expired."id"
          AND sweep."status" = 'COMPLETE'::"PracticeDueSweepStatus"
        RETURNING sweep."id"
    `);
    return {
        deleted: deleted.length,
        hasMore:
            deleted.length === PRACTICE_DUE_SWEEP_CLEANUP_PAGE_SIZE,
        lastDeletedId: deleted.at(-1)?.id ?? null,
    };
}

async function inBoundedParallel<T>(
    values: readonly T[],
    operation: (value: T) => Promise<unknown>
) {
    for (
        let index = 0;
        index < values.length;
        index += PRACTICE_DUE_NOTIFY_CONCURRENCY
    ) {
        await Promise.all(
            values
                .slice(index, index + PRACTICE_DUE_NOTIFY_CONCURRENCY)
                .map(operation)
        );
    }
}

export async function processPracticeDueNotificationPage(
    sweepId: string,
    afterUserId?: string
) {
    const sweep = await prisma.practiceDueSweep.findUniqueOrThrow({
        where: { id: sweepId },
        select: { status: true, referenceAt: true },
    });
    if (sweep.status === 'COMPLETE') {
        return { sweepId, processed: 0, nextCursor: null };
    }
    if (sweep.status !== 'NOTIFYING') {
        throw new Error('Practice due sweep is not ready for notifications');
    }
    const summaries = await prisma.practiceDueSweepUser.findMany({
        where: {
            sweepId,
            ...(afterUserId ? { userId: { gt: afterUserId } } : {}),
        },
        orderBy: { userId: 'asc' },
        take: PRACTICE_DUE_NOTIFY_PAGE_SIZE,
        select: {
            userId: true,
            dueCount: true,
            dueCountIsExact: true,
            earliestDueAt: true,
        },
    });
    await inBoundedParallel(summaries, (summary) =>
        recordPracticeDue({
            ...summary,
            generatedAt: sweep.referenceAt,
        })
    );
    const nextCursor =
        summaries.length === PRACTICE_DUE_NOTIFY_PAGE_SIZE
            ? (summaries.at(-1)?.userId ?? null)
            : null;
    if (nextCursor) {
        requireDurableQueue(
            await publishBackranqQueueMessage(
                {
                    type: 'practice-due-notify',
                    sweepId,
                    afterUserId: nextCursor,
                },
                {
                    idempotencyKey: `practice-due-notify:${sweepId}:${nextCursor}`,
                }
            )
        );
    } else {
        await prisma.practiceDueSweep.updateMany({
            where: { id: sweepId, status: 'NOTIFYING' },
            data: { status: 'COMPLETE', completedAt: new Date() },
        });
    }
    return { sweepId, processed: summaries.length, nextCursor };
}
