import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/prisma';

export type PracticeDueSummary = {
    userId: string;
    dueCount: number;
    earliestDueAt: Date;
};

export type PracticeInventorySummary = {
    userId: string;
    totalEligibleCount: number;
    dueCount: number;
    earliestDueAt: Date | null;
};

type PracticeDueDb = Pick<PrismaClient, '$queryRaw'>;

function boundedPageSize(limit: number | undefined) {
    if (limit === undefined) return 200;
    if (!Number.isSafeInteger(limit)) return 200;
    return Math.max(1, Math.min(limit, 500));
}

/**
 * Lists only review states whose immutable solution semantics still match the
 * current verified, trainable revision. The first CTE walks the existing
 * `(userId, nextDueAt)` index in user order and stops at one bounded user page;
 * the outer query counts only those users' due queues.
 */
export async function listPracticeDueSummaries(args: {
    now: Date;
    afterUserId?: string | null;
    userId?: string;
    limit?: number;
    db?: PracticeDueDb;
}): Promise<PracticeDueSummary[]> {
    const db = args.db ?? prisma;
    const userFilter = args.userId
        ? Prisma.sql`AND state."userId" = ${args.userId}::uuid`
        : args.afterUserId
          ? Prisma.sql`AND state."userId" > ${args.afterUserId}::uuid`
          : Prisma.empty;

    return db.$queryRaw<PracticeDueSummary[]>(Prisma.sql`
        WITH "dueUsers" AS (
            SELECT state."userId"
            FROM "PracticeReviewState" state
            INNER JOIN "TrainingMoment" moment
                ON moment."id" = state."trainingMomentId"
                AND moment."userId" = state."userId"
            INNER JOIN "SolutionRevision" solution
                ON solution."id" = moment."currentSolutionRevisionId"
            WHERE state."nextDueAt" <= ${args.now}
              AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
              AND moment."archivedAt" IS NULL
              AND solution."trainable" = true
              AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
              AND state."solutionHash" = solution."solutionHash"
              AND state."configHash" = solution."configHash"
              ${userFilter}
            GROUP BY state."userId"
            ORDER BY state."userId" ASC
            LIMIT ${boundedPageSize(args.limit)}
        )
        SELECT
            state."userId",
            COUNT(*)::int AS "dueCount",
            MIN(state."nextDueAt") AS "earliestDueAt"
        FROM "dueUsers" users
        INNER JOIN "PracticeReviewState" state
            ON state."userId" = users."userId"
        INNER JOIN "TrainingMoment" moment
            ON moment."id" = state."trainingMomentId"
            AND moment."userId" = state."userId"
        INNER JOIN "SolutionRevision" solution
            ON solution."id" = moment."currentSolutionRevisionId"
        WHERE state."nextDueAt" <= ${args.now}
          AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
          AND moment."archivedAt" IS NULL
          AND solution."trainable" = true
          AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
          AND state."solutionHash" = solution."solutionHash"
          AND state."configHash" = solution."configHash"
        GROUP BY state."userId"
        ORDER BY state."userId" ASC
    `);
}

export async function getPracticeDueSummary(
    userId: string,
    now = new Date(),
    db: PracticeDueDb = prisma
) {
    return (
        await listPracticeDueSummaries({
            now,
            userId,
            limit: 1,
            db,
        })
    )[0] ?? null;
}

export async function getPracticeInventorySummary(
    userId: string,
    now = new Date(),
    db: PracticeDueDb = prisma
): Promise<PracticeInventorySummary | null> {
    const rows = await db.$queryRaw<PracticeInventorySummary[]>(Prisma.sql`
        SELECT
            moment."userId",
            COUNT(*)::int AS "totalEligibleCount",
            COUNT(*) FILTER (
                WHERE state."nextDueAt" <= ${now}
            )::int AS "dueCount",
            MIN(state."nextDueAt") FILTER (
                WHERE state."nextDueAt" <= ${now}
            ) AS "earliestDueAt"
        FROM "TrainingMoment" moment
        INNER JOIN "SolutionRevision" solution
            ON solution."id" = moment."currentSolutionRevisionId"
        LEFT JOIN "PracticeReviewState" state
            ON state."trainingMomentId" = moment."id"
            AND state."userId" = moment."userId"
            AND state."solutionHash" = solution."solutionHash"
            AND state."configHash" = solution."configHash"
        WHERE moment."userId" = ${userId}::uuid
          AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
          AND moment."archivedAt" IS NULL
          AND solution."trainable" = true
          AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
        GROUP BY moment."userId"
    `);
    return rows[0] ?? null;
}
