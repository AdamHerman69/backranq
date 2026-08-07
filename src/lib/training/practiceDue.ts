import type { PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/prisma';
import {
    queryDuePracticeStream,
    queryNewPracticeStream,
} from '@/lib/training/practiceFeedQueries';

export const PRACTICE_DUE_COUNT_CAP = 100;
export const PRACTICE_DUE_PROBE_LIMIT = PRACTICE_DUE_COUNT_CAP + 1;

export type PracticeDueSummary = {
    userId: string;
    dueCount: number;
    dueCountIsExact: boolean;
    earliestDueAt: Date;
};

export type PracticeDueRecheck =
    | { state: 'DUE'; summary: PracticeDueSummary }
    | { state: 'EMPTY' }
    | { state: 'UNKNOWN' };

export type PracticeInventorySummary = {
    userId: string;
    dueCount: number;
    dueCountIsExact: boolean;
    newCount: number;
    newCountIsExact: boolean;
    availableCount: number;
    availableCountIsExact: boolean;
    earliestDueAt: Date | null;
};

type PracticeDueDb = Pick<PrismaClient, '$queryRaw'>;

/**
 * Returns a truthful bounded lower bound. Exactness is true only when both raw
 * index streams reached exhaustion inside their fixed scan-slice budget.
 */
export async function getPracticeInventorySummary(
    userId: string,
    now = new Date(),
    db: PracticeDueDb = prisma
): Promise<PracticeInventorySummary> {
    const [due, fresh] = await Promise.all([
        queryDuePracticeStream({
            db: db as never,
            userId,
            feedStartedAt: now,
            filters: {},
            take: PRACTICE_DUE_PROBE_LIMIT,
        }),
        queryNewPracticeStream({
            db: db as never,
            userId,
            feedStartedAt: now,
            filters: {},
            take: PRACTICE_DUE_PROBE_LIMIT,
        }),
    ]);
    const dueCount = Math.min(
        due.candidates.length,
        PRACTICE_DUE_COUNT_CAP
    );
    const newCount = Math.min(
        fresh.candidates.length,
        PRACTICE_DUE_COUNT_CAP
    );
    const dueCountIsExact =
        due.scannedThrough.bucket === 'DONE' &&
        due.candidates.length <= PRACTICE_DUE_COUNT_CAP;
    const newCountIsExact =
        fresh.scannedThrough.exhausted &&
        fresh.candidates.length <= PRACTICE_DUE_COUNT_CAP;
    const earliestDueAt = due.candidates.reduce<Date | null>(
        (earliest, candidate) => {
            const nextDueAt = new Date(candidate.key.nextDueAt);
            return !earliest || nextDueAt < earliest
                ? nextDueAt
                : earliest;
        },
        null
    );
    return {
        userId,
        dueCount,
        dueCountIsExact,
        newCount,
        newCountIsExact,
        availableCount: dueCount + newCount,
        availableCountIsExact: dueCountIsExact && newCountIsExact,
        earliestDueAt,
    };
}

/**
 * Bounded provider-send recheck. UNKNOWN means the fixed raw-scan budget was
 * exhausted by stale rows; callers must preserve the durable sweep snapshot
 * rather than incorrectly treating the lower bound as an exact zero.
 */
export async function getPracticeDueSummary(
    userId: string,
    now = new Date(),
    db: PracticeDueDb = prisma
): Promise<PracticeDueRecheck> {
    const inventory = await getPracticeInventorySummary(userId, now, db);
    if (inventory.dueCount <= 0 || !inventory.earliestDueAt) {
        return inventory.dueCountIsExact
            ? { state: 'EMPTY' }
            : { state: 'UNKNOWN' };
    }
    return {
        state: 'DUE',
        summary: {
            userId,
            dueCount: inventory.dueCount,
            dueCountIsExact: inventory.dueCountIsExact,
            earliestDueAt: inventory.earliestDueAt,
        },
    };
}
