import { prisma } from '@/lib/prisma';
import { assembleProgressSnapshot } from '@/lib/progress/assembleSnapshot';
import type {
    ProgressFilters,
    ProgressScope,
    ProgressSnapshot,
} from '@/lib/progress/contracts';
import { progressWindow } from '@/lib/progress/metrics';
import {
    readProgressAttemptsSummary,
    readProgressGamesSummary,
    readProgressPositionsSummary,
} from '@/lib/progress/sqlRead';
import { getEffectiveBillingAccount } from '@/lib/services/billingAccounts';

type ProgressReadClient = Pick<typeof prisma, '$queryRaw'>;

export type GetProgressSnapshotArgs = {
    userId: string;
    scope: ProgressScope;
    asOf: Date;
    filters: ProgressFilters;
};

export class ProgressUserNotFoundError extends Error {
    constructor() {
        super('Progress user not found');
        this.name = 'ProgressUserNotFoundError';
    }
}

/**
 * Retained as the API's fail-closed error contract. The SQL reader no longer
 * rejects large source datasets; it only returns aggregated rows.
 */
export class ProgressDatasetTooLargeError extends Error {
    constructor(readonly dataset: string) {
        super(`Progress ${dataset} exceeded the safe read limit`);
        this.name = 'ProgressDatasetTooLargeError';
    }
}

export const PROGRESS_READ_BUDGET = {
    databaseOperations: 3,
    materializedGames: 0,
    materializedPositions: 0,
    materializedAttempts: 0,
    actionsPerList: 20,
} as const;

async function readProgressSnapshot(
    db: ProgressReadClient,
    args: GetProgressSnapshotArgs,
    serverCreditsBalance: number | null
): Promise<ProgressSnapshot> {
    if (!args.userId || !Number.isFinite(args.asOf.getTime())) {
        throw new TypeError('Invalid progress read arguments');
    }

    const window = progressWindow(args.scope, args.asOf);
    const dates = {
        from: window.from ? new Date(window.from) : null,
        previousFrom: window.previousFrom
            ? new Date(window.previousFrom)
            : null,
        previousTo: window.previousTo
            ? new Date(window.previousTo)
            : null,
    };
    const [games, positions, attempts] = await Promise.all([
        readProgressGamesSummary({
            db,
            userId: args.userId,
            asOf: args.asOf,
            ...dates,
            filters: args.filters,
        }),
        readProgressPositionsSummary({
            db,
            userId: args.userId,
            asOf: args.asOf,
            from: dates.from,
            filters: args.filters,
        }),
        readProgressAttemptsSummary({
            db,
            userId: args.userId,
            asOf: args.asOf,
            ...dates,
            filters: args.filters,
        }),
    ]);

    if (!games.userExists) throw new ProgressUserNotFoundError();

    return assembleProgressSnapshot({
        request: {
            scope: args.scope,
            asOf: args.asOf,
            filters: args.filters,
        },
        linkedAccounts: games.linkedAccounts,
        serverCreditsBalance,
        games,
        positions,
        attempts,
    });
}

/**
 * Direct server/RSC entry point. The API route delegates to this same reader;
 * internal pages should call it directly rather than making an HTTP round trip.
 */
export async function getProgressSnapshot(
    args: GetProgressSnapshotArgs
): Promise<ProgressSnapshot> {
    const billingAccount = await getEffectiveBillingAccount(args.userId);
    return readProgressSnapshot(
        prisma,
        args,
        billingAccount.serverCreditsBalance
    );
}

export const progressReadTestUtils = {
    readProgressSnapshot,
};
