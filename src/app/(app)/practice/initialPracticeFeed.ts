import type { Prisma } from '@prisma/client';

import {
    defaultPreferences,
    mergePreferences,
    trainingSourceKindsForSessionMix,
    type PartialPreferences,
} from '@/lib/preferences';
import type {
    PracticeFeedInitialData,
    PracticeFeedMode,
    PracticeFilters,
} from '@/lib/training/api';
import {
    getTrainingMomentPrompt,
    listPracticeFeed,
} from '@/lib/training/readService';

type InitialPracticeReadClient = Pick<
    Prisma.TransactionClient,
    'trainingMoment' | 'user' | '$queryRaw'
>;

/**
 * A stale candidate can disappear between the scheduling and manifest reads.
 * Keep the RSC TTFB bounded; the client continues from the returned signed
 * cursor after paint when both bounded attempts were stale.
 */
export const INITIAL_PRACTICE_MAX_PAGE_HOPS = 2;

export function requestedInitialPracticeFilters({
    mode,
    gameId,
}: {
    mode?: PracticeFeedMode;
    gameId?: string;
}): PracticeFilters {
    return {
        ...(mode ? { mode } : {}),
        ...(gameId ? { gameId } : {}),
    };
}

async function effectiveInitialPracticeFilters({
    db,
    userId,
    requestedFilters,
}: {
    db: InitialPracticeReadClient;
    userId: string;
    requestedFilters: PracticeFilters;
}): Promise<PracticeFilters> {
    if (
        requestedFilters.gameId ||
        requestedFilters.sourceKinds?.length
    ) {
        return requestedFilters;
    }

    const user = await db.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
    });
    const preferences = mergePreferences(
        defaultPreferences(),
        (user?.preferences ?? {}) as PartialPreferences
    );
    const sourceKinds = trainingSourceKindsForSessionMix(
        preferences.trainingSessionMix
    );
    return sourceKinds.length > 0
        ? { ...requestedFilters, sourceKinds }
        : requestedFilters;
}

export async function loadInitialPracticeFeed({
    db,
    userId,
    momentId,
    mode,
    gameId,
}: {
    db: InitialPracticeReadClient;
    userId: string;
    momentId?: string;
    mode?: PracticeFeedMode;
    gameId?: string;
}): Promise<PracticeFeedInitialData> {
    if (momentId) {
        const detail = await getTrainingMomentPrompt({
            db,
            userId,
            momentId,
        });
        return detail
            ? {
                  ownerId: userId,
                  prompt: detail.moment,
                  nextCursor: null,
                  appliedFilters: {},
                  feedStarted: false,
                  feedHadPositions: true,
                  loadError: null,
              }
            : {
                  ownerId: userId,
                  prompt: null,
                  nextCursor: null,
                  appliedFilters: {},
                  feedStarted: false,
                  feedHadPositions: false,
                  loadError: 'Not found',
              };
    }

    const requestedFilters = requestedInitialPracticeFilters({
        mode,
        gameId,
    });
    const filters = await effectiveInitialPracticeFilters({
        db,
        userId,
        requestedFilters,
    });
    let cursor: string | undefined;
    for (
        let pageHop = 0;
        pageHop < INITIAL_PRACTICE_MAX_PAGE_HOPS;
        pageHop += 1
    ) {
        const feed = await listPracticeFeed({
            db,
            userId,
            request: { limit: 1, cursor, filters },
        });
        const prompt = feed.items[0] ?? null;
        if (prompt || feed.nextCursor === null) {
            return {
                ownerId: userId,
                prompt,
                nextCursor: feed.nextCursor,
                appliedFilters: feed.appliedFilters,
                feedStarted: true,
                feedHadPositions: Boolean(prompt),
                loadError: null,
            };
        }
        cursor = feed.nextCursor;
        if (!cursor) break;

        if (pageHop === INITIAL_PRACTICE_MAX_PAGE_HOPS - 1) {
            return {
                ownerId: userId,
                prompt: null,
                nextCursor: cursor,
                appliedFilters: feed.appliedFilters,
                feedStarted: true,
                feedHadPositions: false,
                loadError: null,
            };
        }
    }

    throw new Error('Practice feed returned an invalid continuation');
}
