import { Prisma } from '@prisma/client';

import type { PracticeFilters } from '@/lib/training/api';
import {
    initialDueScheduleCursor,
    initialNewScheduleCursor,
    type DuePracticeBucket,
    type DuePracticeScan,
    type DueScheduleCursor,
    type NewPracticeScan,
    type NewScheduleCursor,
} from '@/lib/training/practiceScheduler';

type PracticeFeedQueryClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

type DueRawRow = {
    stateId: string;
    nextDueAt: Date;
    id: string | null;
    currentSolutionRevisionId: string | null;
};

type NewRawRow = {
    rawId: string;
    createdAt: Date;
    id: string | null;
    currentSolutionRevisionId: string | null;
};

export const PRACTICE_SCAN_SLICE_SIZE = 64;
export const PRACTICE_MAX_SCAN_SLICES = 3;

function enumList(values: readonly string[], enumName: string) {
    return Prisma.join(
        values.map(
            (value) => Prisma.sql`${value}::${Prisma.raw(enumName)}`
        )
    );
}

function filterSql(filters: PracticeFilters) {
    const clauses: Prisma.Sql[] = [];
    if (filters.gameId) {
        clauses.push(
            Prisma.sql`moment."gameId" = ${filters.gameId}::uuid`
        );
    }
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

function dueGameScopeSql(filters: PracticeFilters) {
    if (!filters.gameId) return Prisma.empty;
    return Prisma.sql`AND EXISTS (
        SELECT 1
        FROM "TrainingMoment" scoped_moment
        WHERE scoped_moment."id" = state."trainingMomentId"
          AND scoped_moment."userId" = state."userId"
          AND scoped_moment."gameId" = ${filters.gameId}::uuid
    )`;
}

function newGameScopeSql(filters: PracticeFilters) {
    return filters.gameId
        ? Prisma.sql`AND moment."gameId" = ${filters.gameId}::uuid`
        : Prisma.empty;
}

function dueAfterSql(cursor: DueScheduleCursor) {
    if (cursor.bucket === 'DONE' || !cursor.after) return Prisma.empty;
    return Prisma.sql`AND (state."nextDueAt", state."id") >
        (${new Date(cursor.after.nextDueAt)}, ${cursor.after.id}::uuid)`;
}

function dueBucketSql(bucket: DuePracticeBucket) {
    return bucket === 'LAPSED'
        ? Prisma.sql`state."lapses" > 0`
        : Prisma.sql`state."lapses" = 0`;
}

function newAfterSql(cursor: NewScheduleCursor) {
    if (!cursor.after) return Prisma.empty;
    return Prisma.sql`AND (moment."createdAt", moment."id") >
        (${new Date(cursor.after.createdAt)}, ${cursor.after.id}::uuid)`;
}

function nextDueBucket(bucket: DuePracticeBucket): DueScheduleCursor {
    return bucket === 'LAPSED'
        ? { bucket: 'CLEAN', after: null }
        : { bucket: 'DONE', after: null };
}

async function queryDueSlice(args: {
    db: PracticeFeedQueryClient;
    userId: string;
    feedStartedAt: Date;
    filters: PracticeFilters;
    cursor: Exclude<DueScheduleCursor, { bucket: 'DONE' }>;
}): Promise<DueRawRow[]> {
    return args.db.$queryRaw<DueRawRow[]>(Prisma.sql`
        WITH "rawDue" AS MATERIALIZED (
            SELECT
                state."id" AS "stateId",
                state."userId",
                state."trainingMomentId",
                state."solutionHash",
                state."configHash",
                state."nextDueAt",
                state."lastReviewedAt"
            FROM "PracticeReviewState" state
            WHERE state."userId" = ${args.userId}::uuid
              AND state."nextDueAt" <= ${args.feedStartedAt}
              AND ${dueBucketSql(args.cursor.bucket)}
              ${dueGameScopeSql(args.filters)}
              ${dueAfterSql(args.cursor)}
            ORDER BY state."nextDueAt" ASC, state."id" ASC
            LIMIT ${PRACTICE_SCAN_SLICE_SIZE}
        )
        SELECT
            raw."stateId",
            raw."nextDueAt",
            candidate."id",
            candidate."currentSolutionRevisionId"
        FROM "rawDue" raw
        LEFT JOIN LATERAL (
            SELECT
                moment."id",
                moment."currentSolutionRevisionId"
            FROM "TrainingMoment" moment
            INNER JOIN "SolutionRevision" solution
                ON solution."id" = moment."currentSolutionRevisionId"
            WHERE moment."id" = raw."trainingMomentId"
              AND moment."userId" = raw."userId"
              AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
              AND moment."archivedAt" IS NULL
              AND moment."createdAt" <= ${args.feedStartedAt}
              AND solution."trainable" = true
              AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
              AND solution."acceptanceFrontier"->>'status' = 'STABLE'
              AND raw."solutionHash" = solution."solutionHash"
              AND raw."configHash" = solution."configHash"
              AND raw."lastReviewedAt" <= ${args.feedStartedAt}
              ${filterSql(args.filters)}
            LIMIT 1
        ) candidate ON true
        ORDER BY raw."nextDueAt" ASC, raw."stateId" ASC
    `);
}

/**
 * Scans at most PRACTICE_SCAN_SLICE_SIZE * PRACTICE_MAX_SCAN_SLICES raw
 * review-state rows. Current-solution and product filters run only after the
 * materialized raw slice, so stale semantics cannot make one request unbounded.
 */
export async function queryDuePracticeStream(args: {
    db: PracticeFeedQueryClient;
    userId: string;
    feedStartedAt: Date;
    filters: PracticeFilters;
    cursor?: DueScheduleCursor | null;
    take: number;
}): Promise<DuePracticeScan> {
    const startedAt = args.cursor ?? initialDueScheduleCursor();
    let cursor = startedAt;
    const candidates: DuePracticeScan['candidates'] = [];

    for (
        let slice = 0;
        slice < PRACTICE_MAX_SCAN_SLICES &&
        cursor.bucket !== 'DONE' &&
        candidates.length < args.take;
        slice += 1
    ) {
        const bucket = cursor.bucket;
        const rows = await queryDueSlice({
            ...args,
            cursor,
        });
        const last = rows.at(-1);
        if (last) {
            cursor = {
                bucket,
                after: {
                    bucket,
                    nextDueAt: last.nextDueAt.toISOString(),
                    id: last.stateId,
                },
            };
            for (const row of rows) {
                if (!row.id || !row.currentSolutionRevisionId) continue;
                candidates.push({
                    id: row.id,
                    currentSolutionRevisionId:
                        row.currentSolutionRevisionId,
                    key: {
                        bucket,
                        nextDueAt: row.nextDueAt.toISOString(),
                        id: row.stateId,
                    },
                });
            }
        }
        if (rows.length < PRACTICE_SCAN_SLICE_SIZE) {
            cursor = nextDueBucket(bucket);
        }
    }

    return { candidates, startedAt, scannedThrough: cursor };
}

async function queryNewSlice(args: {
    db: PracticeFeedQueryClient;
    userId: string;
    feedStartedAt: Date;
    filters: PracticeFilters;
    cursor: NewScheduleCursor;
}): Promise<NewRawRow[]> {
    return args.db.$queryRaw<NewRawRow[]>(Prisma.sql`
        WITH "rawNew" AS MATERIALIZED (
            SELECT
                moment."id" AS "rawId",
                moment."currentSolutionRevisionId",
                moment."createdAt"
            FROM "TrainingMoment" moment
            WHERE moment."userId" = ${args.userId}::uuid
              AND moment."status" = 'ACTIVE'::"TrainingMomentStatus"
              AND moment."archivedAt" IS NULL
              AND moment."currentSolutionRevisionId" IS NOT NULL
              AND moment."createdAt" <= ${args.feedStartedAt}
              ${newGameScopeSql(args.filters)}
              ${newAfterSql(args.cursor)}
            ORDER BY moment."createdAt" ASC, moment."id" ASC
            LIMIT ${PRACTICE_SCAN_SLICE_SIZE}
        )
        SELECT
            raw."rawId",
            raw."createdAt",
            candidate."id",
            candidate."currentSolutionRevisionId"
        FROM "rawNew" raw
        LEFT JOIN LATERAL (
            SELECT
                moment."id",
                moment."currentSolutionRevisionId"
            FROM "TrainingMoment" moment
            INNER JOIN "SolutionRevision" solution
                ON solution."id" = moment."currentSolutionRevisionId"
            WHERE moment."id" = raw."rawId"
              AND moment."currentSolutionRevisionId" = raw."currentSolutionRevisionId"
              AND solution."trainable" = true
              AND solution."verificationStatus" = 'VERIFIED'::"VerificationStatus"
              AND solution."acceptanceFrontier"->>'status' = 'STABLE'
              AND NOT EXISTS (
                  SELECT 1
                  FROM "PracticeReviewState" state
                  WHERE state."trainingMomentId" = moment."id"
                    AND state."userId" = moment."userId"
                    AND state."solutionHash" = solution."solutionHash"
                    AND state."configHash" = solution."configHash"
              )
              ${filterSql(args.filters)}
            LIMIT 1
        ) candidate ON true
        ORDER BY raw."createdAt" ASC, raw."rawId" ASC
    `);
}

/** Bounded raw TrainingMoment scan equivalent to queryDuePracticeStream. */
export async function queryNewPracticeStream(args: {
    db: PracticeFeedQueryClient;
    userId: string;
    feedStartedAt: Date;
    filters: PracticeFilters;
    cursor?: NewScheduleCursor | null;
    take: number;
}): Promise<NewPracticeScan> {
    const startedAt = args.cursor ?? initialNewScheduleCursor();
    let cursor = startedAt;
    const candidates: NewPracticeScan['candidates'] = [];

    for (
        let slice = 0;
        slice < PRACTICE_MAX_SCAN_SLICES &&
        !cursor.exhausted &&
        candidates.length < args.take;
        slice += 1
    ) {
        const rows = await queryNewSlice({ ...args, cursor });
        const last = rows.at(-1);
        if (last) {
            cursor = {
                after: {
                    createdAt: last.createdAt.toISOString(),
                    id: last.rawId,
                },
                exhausted: false,
            };
            for (const row of rows) {
                if (!row.id || !row.currentSolutionRevisionId) continue;
                candidates.push({
                    id: row.id,
                    currentSolutionRevisionId:
                        row.currentSolutionRevisionId,
                    key: {
                        createdAt: row.createdAt.toISOString(),
                        id: row.rawId,
                    },
                });
            }
        }
        if (rows.length < PRACTICE_SCAN_SLICE_SIZE) {
            cursor = { after: cursor.after, exhausted: true };
        }
    }

    return { candidates, startedAt, scannedThrough: cursor };
}
