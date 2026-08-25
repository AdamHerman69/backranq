import type { GameSource, PrismaClient, TimeClass } from '@prisma/client';
import { Prisma } from '@prisma/client';

import {
    chessAccountConnectionSelect,
    linkedUsernameSnapshot,
    type ChessAccountConnectionSnapshot,
} from '@/lib/accounts/chessAccountConnections';
import { calculateManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import { prisma } from '@/lib/prisma';
import {
    canonicalPreferences,
    mergePreferences,
    resolveAutoAnalysisPolicy,
    type AutoAnalysisPolicy,
} from '@/lib/preferences';
import { eligibleAutoAnalysisGameIds } from '@/lib/services/analysisEligibility';
import { AUTO_ANALYSIS_QUEUED_REASONS } from '@/lib/services/analysisJobs';
import {
    calculateAutoAnalysisCapacityFromSummaries,
    type AutoAnalysisBlockingReason,
    type AutoAnalysisCapacity,
    type AutoAnalysisStatus,
} from '@/lib/services/autoAnalysisBacklog';
import {
    readEffectiveBillingSnapshot,
    type EffectiveBillingSnapshot,
} from '@/lib/services/billingAccounts';
import type { SyncStatus } from '@/lib/services/gameSync';

const STATUS_CANDIDATE_SCAN_LIMIT = 250;

type SyncStatusReadClient = Pick<
    PrismaClient,
    | '$queryRaw'
    | 'user'
    | 'providerSyncState'
    | 'analyzedGame'
    | 'billingAccount'
    | 'creditLedgerEntry'
    | 'adminMembership'
    | 'planGrant'
>;

type CountValue = number | bigint | string | null;

type StatusMetricsRow = {
    lichessLatest: Date | null;
    chesscomLatest: Date | null;
    totalImported: CountValue;
    analyzed: CountValue;
    queued: CountValue;
    running: CountValue;
    failed: CountValue;
    autoQueued: CountValue;
    autoRunning: CountValue;
    autoFailed: CountValue;
    outstandingReserved: CountValue;
    monthlyAutoGames: CountValue;
    dailyAutoGames: CountValue;
};

type StatusCandidate = {
    id: string;
    provider: GameSource;
    result: string | null;
    timeClass: TimeClass;
    rated: boolean | null;
    plyCount: number;
    whiteName: string;
    blackName: string;
    sourceUsername: string;
    userSide: 'WHITE' | 'BLACK' | 'UNKNOWN';
    playedAt: Date;
    createdAt: Date;
};

export type SyncStatusSnapshot = SyncStatus & {
    inventory: AutoAnalysisStatus['inventory'];
    automation: AutoAnalysisStatus;
};

export type SyncStatusUserSnapshot = {
    preferences: Prisma.JsonValue;
    chessAccountConnections: ChessAccountConnectionSnapshot[];
};

export async function readSyncStatusSnapshot(
    userId: string,
    options: {
        now?: Date;
        db?: SyncStatusReadClient;
        user?: SyncStatusUserSnapshot | null;
        billingSnapshot?: EffectiveBillingSnapshot;
    } = {}
): Promise<SyncStatusSnapshot> {
    const now = options.now ?? new Date();
    const db = options.db ?? prisma;
    const [user, syncStates, billingSnapshot] = await Promise.all([
        options.user !== undefined
            ? Promise.resolve(options.user)
            : db.user.findUnique({
                  where: { id: userId },
                  select: {
                      preferences: true,
                      chessAccountConnections: {
                          select: chessAccountConnectionSelect,
                      },
                  },
              }),
        db.providerSyncState.findMany({
            where: { userId },
            select: {
                provider: true,
                lastSyncedPlayedAt: true,
                lastAttemptAt: true,
                lastSuccessAt: true,
                lastError: true,
            },
        }),
        options.billingSnapshot
            ? Promise.resolve(options.billingSnapshot)
            : readEffectiveBillingSnapshot(userId, { now, db }),
    ]);

    const preferences = canonicalPreferences(user?.preferences ?? {});
    const policy = resolveAutoAnalysisPolicy(preferences);
    const eligibilityPreferences = eligibilityPreferencesForStatus(
        preferences,
        policy,
        now
    );
    const eligibilityPolicy = resolveAutoAnalysisPolicy(
        eligibilityPreferences
    );
    const [metrics, candidateRows] = await Promise.all([
        readStatusMetrics({
            db,
            userId,
            monthStart: billingSnapshot.serverCreditsPeriodStart,
            now,
        }),
        readStatusCandidates({
            db,
            userId,
            policy: eligibilityPolicy,
        }),
    ]);

    const candidatesTruncated =
        candidateRows.length > STATUS_CANDIDATE_SCAN_LIMIT;
    const candidates = candidatesTruncated
        ? candidateRows.slice(0, STATUS_CANDIDATE_SCAN_LIMIT)
        : candidateRows;
    const eligible = eligibleAutoAnalysisGameIds({
        preferences: eligibilityPreferences,
        games: candidates,
        gameId: (game) => game.id,
    });
    const outstandingReservations = count(metrics.outstandingReserved);
    const billing = calculateManualServerAnalysisCapacity({
        currentBalance: billingSnapshot.serverCreditsBalance,
        stopThreshold: billingSnapshot.stopWhenCreditsBelow,
        monthlyLimit: billingSnapshot.monthlyServerCreditsLimit,
        monthlyUsed: billingSnapshot.monthlyServerCreditsUsed,
        outstandingReservations,
        analysisQuality: preferences.analysisQuality,
    });
    const capacity = calculateAutoAnalysisCapacityFromSummaries({
        policy,
        account: billingSnapshot,
        allOutstandingReserved: outstandingReservations,
        monthlyAutoGames: count(metrics.monthlyAutoGames),
        dailyAutoGames: count(metrics.dailyAutoGames),
        now,
    });
    const eligibleAtLeast = eligible.length;
    const waitingForCreditsAtLeast = Math.max(
        0,
        eligibleAtLeast - capacity.reservableGames
    );
    const blockedReason: AutoAnalysisBlockingReason = !policy.enabled
        ? 'disabled'
        : waitingForCreditsAtLeast > 0
          ? capacityConstraintReason(capacity)
          : null;
    const inventory = {
        totalImported: count(metrics.totalImported),
        analyzed: count(metrics.analyzed),
        unanalyzed: Math.max(
            0,
            count(metrics.totalImported) - count(metrics.analyzed)
        ),
    };
    const stateByProvider = Object.fromEntries(
        syncStates.map((state) => [
            state.provider === 'LICHESS' ? 'lichess' : 'chesscom',
            {
                lastSyncedPlayedAt:
                    state.lastSyncedPlayedAt?.toISOString() ?? null,
                lastAttemptAt: state.lastAttemptAt?.toISOString() ?? null,
                lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
                lastError: state.lastError,
            },
        ])
    );
    const automation: AutoAnalysisStatus = {
        policy,
        inventory,
        backlog: {
            eligible: eligibleAtLeast,
            eligibleAtLeast,
            waitingForCredits: waitingForCreditsAtLeast,
            waitingForCreditsAtLeast,
            blockedReason,
            queued: count(metrics.autoQueued),
            running: count(metrics.autoRunning),
            terminalFailed: count(metrics.autoFailed),
            countsExact: !candidatesTruncated,
            scannedCandidates: candidates.length,
            scanLimit: STATUS_CANDIDATE_SCAN_LIMIT,
        },
        capacity,
    };

    return {
        ownerId: userId,
        linked: linkedUsernameSnapshot(
            user?.chessAccountConnections ?? []
        ),
        lastSync: {
            lichess: metrics.lichessLatest?.toISOString() ?? null,
            chesscom: metrics.chesscomLatest?.toISOString() ?? null,
        },
        gameAutomation: {
            paused: preferences.gameAutomation.paused,
            rules: preferences.gameAutomation.rules,
            schedule: '0 3 * * *',
            states: {
                lichess: stateByProvider.lichess ?? null,
                chesscom: stateByProvider.chesscom ?? null,
            },
        },
        analysisJobs: {
            queued: count(metrics.queued),
            running: count(metrics.running),
            failed: count(metrics.failed),
        },
        billing,
        inventory,
        automation,
    };
}

async function readStatusMetrics(args: {
    db: Pick<SyncStatusReadClient, '$queryRaw'>;
    userId: string;
    monthStart: Date;
    now: Date;
}) {
    const dayStart = new Date(args.now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = await args.db.$queryRaw<StatusMetricsRow[]>(Prisma.sql`
            WITH "gameMetrics" AS (
                SELECT
                    MAX("playedAt") FILTER (WHERE "provider" = 'LICHESS') AS "lichessLatest",
                    MAX("playedAt") FILTER (WHERE "provider" = 'CHESSCOM') AS "chesscomLatest",
                    COUNT(*)::int AS "totalImported",
                    COUNT(*) FILTER (WHERE "analyzedAt" IS NOT NULL)::int AS "analyzed"
                FROM "AnalyzedGame"
                WHERE "userId" = ${args.userId}::uuid
            ),
            "jobMetrics" AS (
                SELECT
                    COUNT(*) FILTER (WHERE "status" = 'QUEUED')::int AS "queued",
                    COUNT(*) FILTER (WHERE "status" = 'RUNNING')::int AS "running",
                    COUNT(*) FILTER (WHERE "status" = 'FAILED')::int AS "failed",
                    COUNT(*) FILTER (
                        WHERE "status" = 'QUEUED'
                          AND "queuedReason" IN (${Prisma.join([
                              ...AUTO_ANALYSIS_QUEUED_REASONS,
                          ])})
                    )::int AS "autoQueued",
                    COUNT(*) FILTER (
                        WHERE "status" = 'RUNNING'
                          AND "queuedReason" IN (${Prisma.join([
                              ...AUTO_ANALYSIS_QUEUED_REASONS,
                          ])})
                    )::int AS "autoRunning",
                    COUNT(*) FILTER (
                        WHERE "status" = 'FAILED'
                          AND "queuedReason" IN (${Prisma.join([
                              ...AUTO_ANALYSIS_QUEUED_REASONS,
                          ])})
                    )::int AS "autoFailed"
                FROM "AnalysisJob"
                WHERE "userId" = ${args.userId}::uuid
            ),
            "ledgerMetrics" AS (
                SELECT GREATEST(
                    0,
                    COALESCE(SUM("credits") FILTER (WHERE "type" = 'RESERVED'), 0)
                    - COALESCE(SUM("credits") FILTER (WHERE "type" = 'CONSUMED'), 0)
                    - COALESCE(SUM("credits") FILTER (WHERE "type" = 'RELEASED'), 0)
                    - COALESCE(SUM("credits") FILTER (WHERE "type" = 'EXPIRED'), 0)
                )::int AS "outstandingReserved"
                FROM "CreditLedgerEntry"
                WHERE "userId" = ${args.userId}::uuid
                  AND "scope" = 'RESERVATION'
                  AND "billingPeriodStart" = ${args.monthStart}
            ),
            "committedRuns" AS (
                SELECT run."id", run."createdAt"
                FROM "AnalysisRun" AS run
                INNER JOIN "CreditLedgerEntry" AS ledger
                    ON ledger."analysisRunId" = run."id"
                WHERE run."userId" = ${args.userId}::uuid
                  AND run."queuedReason" IN (${Prisma.join([
                      ...AUTO_ANALYSIS_QUEUED_REASONS,
                  ])})
                  AND run."createdAt" >= ${args.monthStart}
                GROUP BY run."id", run."createdAt"
                HAVING
                    GREATEST(
                        0,
                        COALESCE(SUM(ledger."credits") FILTER (WHERE ledger."type" = 'RESERVED'), 0)
                        - COALESCE(SUM(ledger."credits") FILTER (WHERE ledger."type" = 'CONSUMED'), 0)
                        - COALESCE(SUM(ledger."credits") FILTER (WHERE ledger."type" = 'RELEASED'), 0)
                        - COALESCE(SUM(ledger."credits") FILTER (WHERE ledger."type" = 'EXPIRED'), 0)
                    )
                    + GREATEST(
                        0,
                        COALESCE(SUM(ledger."credits") FILTER (WHERE ledger."type" = 'CONSUMED'), 0)
                        - COALESCE(SUM(ledger."credits") FILTER (WHERE ledger."type" = 'REFUNDED'), 0)
                    ) > 0
            ),
            "runMetrics" AS (
                SELECT
                    COUNT(*)::int AS "monthlyAutoGames",
                    COUNT(*) FILTER (WHERE "createdAt" >= ${dayStart})::int AS "dailyAutoGames"
                FROM "committedRuns"
            )
            SELECT *
            FROM "gameMetrics", "jobMetrics", "ledgerMetrics", "runMetrics"
        `);
    return rows[0] ?? emptyMetrics();
}

async function readStatusCandidates(args: {
    db: Pick<SyncStatusReadClient, 'analyzedGame'>;
    userId: string;
    policy: AutoAnalysisPolicy;
}): Promise<StatusCandidate[]> {
    if (!args.policy.enabled) return [];
    return args.db.analyzedGame.findMany({
        where: {
            userId: args.userId,
            analyzedAt: null,
            ...candidateMetadataWhere(args.policy),
            ...(args.policy.existingGames === 'new' && args.policy.enabledAt
                ? { createdAt: { gte: new Date(args.policy.enabledAt) } }
                : {}),
            analysisJobs: {
                none: {
                    status: {
                        in: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'],
                    },
                },
            },
        },
        select: {
            id: true,
            provider: true,
            result: true,
            timeClass: true,
            rated: true,
            plyCount: true,
            whiteName: true,
            blackName: true,
            sourceUsername: true,
            userSide: true,
            playedAt: true,
            createdAt: true,
        },
        orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
        take: STATUS_CANDIDATE_SCAN_LIMIT + 1,
    });
}

function eligibilityPreferencesForStatus(
    preferences: ReturnType<typeof canonicalPreferences>,
    policy: AutoAnalysisPolicy,
    now: Date
) {
    return policy.enabled &&
        policy.existingGames === 'new' &&
        policy.enabledAt === null
        ? mergePreferences(preferences, {
              gameAutomation: {
                  analysis: { enabledAt: now.toISOString() },
              },
          })
        : preferences;
}

function candidateMetadataWhere(
    policy: AutoAnalysisPolicy
): Prisma.AnalyzedGameWhereInput {
    const branches: Prisma.AnalyzedGameWhereInput[] = [];
    for (const [provider, providerKey] of [
        ['LICHESS', 'lichess'],
        ['CHESSCOM', 'chesscom'],
    ] as const) {
        const timeClasses = ([
            ['bullet', 'BULLET'],
            ['blitz', 'BLITZ'],
            ['rapid', 'RAPID'],
            ['classical', 'CLASSICAL'],
            ['unknown', 'UNKNOWN'],
        ] as const)
            .filter(
                ([key]) =>
                    policy.rules[providerKey][key] === 'AUTO_ANALYZE'
            )
            .map(([, value]) => value);
        if (timeClasses.length === 0) continue;
        const resultBranches: Prisma.AnalyzedGameWhereInput[] = [
            {
                provider,
                timeClass: { in: timeClasses },
                userSide: 'WHITE',
                result: '0-1',
            },
            {
                provider,
                timeClass: { in: timeClasses },
                userSide: 'BLACK',
                result: '1-0',
            },
        ];
        if (
            policy.resultScope === 'draws' ||
            policy.resultScope === 'all'
        ) {
            resultBranches.push({
                provider,
                timeClass: { in: timeClasses },
                result: '1/2-1/2',
            });
        }
        if (policy.resultScope === 'all') {
            resultBranches.push(
                {
                    provider,
                    timeClass: { in: timeClasses },
                    userSide: 'WHITE',
                    result: '1-0',
                },
                {
                    provider,
                    timeClass: { in: timeClasses },
                    userSide: 'BLACK',
                    result: '0-1',
                }
            );
        }
        branches.push(...resultBranches);
    }
    return {
        ...(policy.ratedOnly ? { rated: true } : {}),
        plyCount: { gte: policy.minPlies },
        OR: branches.length > 0 ? branches : [{ id: { in: [] } }],
    };
}

function capacityConstraintReason(
    capacity: AutoAnalysisCapacity
): Exclude<AutoAnalysisBlockingReason, 'disabled' | null> {
    if (capacity.blockingReason) return capacity.blockingReason;
    const balanceGames = Math.floor(
        Math.max(0, capacity.currentBalance - capacity.creditReserve) /
            capacity.creditsPerGame
    );
    const planGames = Math.floor(
        capacity.planMonthlyRemaining / capacity.creditsPerGame
    );
    const minimum = Math.min(
        balanceGames,
        planGames,
        capacity.dailyRemaining,
        capacity.monthlyRemaining
    );
    if (balanceGames === minimum) {
        return capacity.creditReserve > 0 && capacity.currentBalance > 0
            ? 'reserve'
            : 'credits';
    }
    if (planGames === minimum) return 'plan-cap';
    if (capacity.dailyRemaining === minimum) return 'daily-cap';
    return 'monthly-cap';
}

function count(value: CountValue | undefined) {
    const parsed = Number(value ?? 0);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function emptyMetrics(): StatusMetricsRow {
    return {
        lichessLatest: null,
        chesscomLatest: null,
        totalImported: 0,
        analyzed: 0,
        queued: 0,
        running: 0,
        failed: 0,
        autoQueued: 0,
        autoRunning: 0,
        autoFailed: 0,
        outstandingReserved: 0,
        monthlyAutoGames: 0,
        dailyAutoGames: 0,
    };
}

export const syncStatusReadTestUtils = {
    candidateMetadataWhere,
};
