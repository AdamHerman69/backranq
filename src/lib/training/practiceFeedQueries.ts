import { Prisma } from '@prisma/client';

import type { PracticeFilters } from '@/lib/training/api';
import type {
    DueScheduleCandidate,
    DueScheduleKey,
    NewScheduleCandidate,
    NewScheduleKey,
} from '@/lib/training/practiceScheduler';

type PracticeFeedQueryClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

type DueRow = {
    id: string;
    currentSolutionRevisionId: string;
    lapseBucket: number;
    lapses: number;
    nextDueAt: Date;
    lastReviewedAt: Date;
    createdAt: Date;
};

type NewRow = {
    id: string;
    currentSolutionRevisionId: string;
    createdAt: Date;
};

function enumList(values: readonly string[], enumName: string) {
    return Prisma.join(
        values.map(
            (value) => Prisma.sql`${value}::${Prisma.raw(enumName)}`
        )
    );
}

function filterSql(filters: PracticeFilters) {
    const clauses: Prisma.Sql[] = [];
    if (filters.phases?.length) {
        clauses.push(
            Prisma.sql`moment."phase" IN (${enumList(filters.phases, '"GamePhase"')})`
        );
    }
    if (filters.sourceKinds?.length) {
        clauses.push(
            Prisma.sql`moment."sourceKinds" && ARRAY[${enumList(filters.sourceKinds, '"TrainingSourceKind"')}]`
        );
    }
    if (filters.lessonKinds?.length) {
        clauses.push(
            Prisma.sql`moment."lessonKinds" && ARRAY[${enumList(filters.lessonKinds, '"TrainingLessonKind"')}]`
        );
    }
    if (filters.themes?.length) {
        clauses.push(
            Prisma.sql`moment."themes" @> ARRAY[${Prisma.join(filters.themes)}]::text[]`
        );
    }
    if (filters.minConfidence !== undefined) {
        clauses.push(
            Prisma.sql`moment."confidence" >= ${filters.minConfidence}`
        );
    }
    if (filters.focus === 'MEANINGFUL') {
        clauses.push(Prisma.sql`(
            moment."winChanceLoss" >= 0.08 OR
            (moment."winChanceLoss" IS NULL AND moment."cpLoss" >= 100)
        )`);
    } else if (filters.focus === 'MAJOR') {
        clauses.push(Prisma.sql`(
            moment."winChanceLoss" >= 0.12 OR
            (moment."winChanceLoss" IS NULL AND moment."cpLoss" >= 150)
        )`);
    }
    return clauses.length
        ? Prisma.sql`AND ${Prisma.join(clauses, ' AND ')}`
        : Prisma.empty;
}

function dueCursorSql(cursor: DueScheduleKey | null | undefined) {
    if (!cursor) return Prisma.empty;
    return Prisma.sql`AND (
        (CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END) < ${cursor.lapseBucket}
        OR (
            (CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END) = ${cursor.lapseBucket}
            AND state."lapses" < ${cursor.lapses}
        )
        OR (
            (CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END) = ${cursor.lapseBucket}
            AND state."lapses" = ${cursor.lapses}
            AND state."nextDueAt" > ${new Date(cursor.nextDueAt)}
        )
        OR (
            (CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END) = ${cursor.lapseBucket}
            AND state."lapses" = ${cursor.lapses}
            AND state."nextDueAt" = ${new Date(cursor.nextDueAt)}
            AND state."lastReviewedAt" > ${new Date(cursor.lastReviewedAt)}
        )
        OR (
            (CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END) = ${cursor.lapseBucket}
            AND state."lapses" = ${cursor.lapses}
            AND state."nextDueAt" = ${new Date(cursor.nextDueAt)}
            AND state."lastReviewedAt" = ${new Date(cursor.lastReviewedAt)}
            AND moment."createdAt" > ${new Date(cursor.createdAt)}
        )
        OR (
            (CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END) = ${cursor.lapseBucket}
            AND state."lapses" = ${cursor.lapses}
            AND state."nextDueAt" = ${new Date(cursor.nextDueAt)}
            AND state."lastReviewedAt" = ${new Date(cursor.lastReviewedAt)}
            AND moment."createdAt" = ${new Date(cursor.createdAt)}
            AND moment."id" > ${cursor.id}::uuid
        )
    )`;
}

function newCursorSql(cursor: NewScheduleKey | null | undefined) {
    if (!cursor) return Prisma.empty;
    return Prisma.sql`AND (
        moment."createdAt" > ${new Date(cursor.createdAt)}
        OR (
            moment."createdAt" = ${new Date(cursor.createdAt)}
            AND moment."id" > ${cursor.id}::uuid
        )
    )`;
}

export async function queryDuePracticeStream(args: {
    db: PracticeFeedQueryClient;
    userId: string;
    feedStartedAt: Date;
    filters: PracticeFilters;
    cursor?: DueScheduleKey | null;
    take: number;
}): Promise<DueScheduleCandidate[]> {
    const rows = await args.db.$queryRaw<DueRow[]>(Prisma.sql`
        SELECT
            moment."id",
            moment."currentSolutionRevisionId",
            CASE WHEN state."lapses" > 0 THEN 1 ELSE 0 END AS "lapseBucket",
            state."lapses",
            state."nextDueAt",
            state."lastReviewedAt",
            moment."createdAt"
        FROM "TrainingMoment" moment
        INNER JOIN "SolutionRevision" solution
            ON solution."id" = moment."currentSolutionRevisionId"
        INNER JOIN "PracticeReviewState" state
            ON state."trainingMomentId" = moment."id"
            AND state."userId" = moment."userId"
            AND state."solutionHash" = solution."solutionHash"
            AND state."configHash" = solution."configHash"
        WHERE moment."userId" = ${args.userId}::uuid
          AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
          AND moment."archivedAt" IS NULL
          AND moment."createdAt" <= ${args.feedStartedAt}
          AND solution."trainable" = true
          AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
          AND state."nextDueAt" <= ${args.feedStartedAt}
          AND state."lastReviewedAt" <= ${args.feedStartedAt}
          ${filterSql(args.filters)}
          ${dueCursorSql(args.cursor)}
        ORDER BY
            "lapseBucket" DESC,
            state."lapses" DESC,
            state."nextDueAt" ASC,
            state."lastReviewedAt" ASC,
            moment."createdAt" ASC,
            moment."id" ASC
        LIMIT ${args.take}
    `);
    return rows.map((row) => ({
        id: row.id,
        currentSolutionRevisionId: row.currentSolutionRevisionId,
        key: {
            lapseBucket: row.lapseBucket === 1 ? 1 : 0,
            lapses: row.lapses,
            nextDueAt: row.nextDueAt.toISOString(),
            lastReviewedAt: row.lastReviewedAt.toISOString(),
            createdAt: row.createdAt.toISOString(),
            id: row.id,
        },
    }));
}

export async function queryNewPracticeStream(args: {
    db: PracticeFeedQueryClient;
    userId: string;
    feedStartedAt: Date;
    filters: PracticeFilters;
    cursor?: NewScheduleKey | null;
    take: number;
}): Promise<NewScheduleCandidate[]> {
    const rows = await args.db.$queryRaw<NewRow[]>(Prisma.sql`
        SELECT
            moment."id",
            moment."currentSolutionRevisionId",
            moment."createdAt"
        FROM "TrainingMoment" moment
        INNER JOIN "SolutionRevision" solution
            ON solution."id" = moment."currentSolutionRevisionId"
        WHERE moment."userId" = ${args.userId}::uuid
          AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
          AND moment."archivedAt" IS NULL
          AND moment."createdAt" <= ${args.feedStartedAt}
          AND solution."trainable" = true
          AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
          AND NOT EXISTS (
              SELECT 1
              FROM "PracticeReviewState" state
              WHERE state."trainingMomentId" = moment."id"
                AND state."userId" = moment."userId"
                AND state."solutionHash" = solution."solutionHash"
                AND state."configHash" = solution."configHash"
          )
          ${filterSql(args.filters)}
          ${newCursorSql(args.cursor)}
        ORDER BY moment."createdAt" ASC, moment."id" ASC
        LIMIT ${args.take}
    `);
    return rows.map((row) => ({
        id: row.id,
        currentSolutionRevisionId: row.currentSolutionRevisionId,
        key: {
            createdAt: row.createdAt.toISOString(),
            id: row.id,
        },
    }));
}
