import type {
    BillingAccount,
    CreditLedgerEntryType,
    Prisma,
} from '@prisma/client';
import { after } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
    canonicalPreferences,
    mergePreferences,
    type AutoAnalysisPolicy,
} from '@/lib/preferences';
import {
    eligibleAutoAnalysisGameIds,
} from '@/lib/services/analysisEligibility';
import {
    AUTO_ANALYSIS_QUEUED_REASONS,
    enqueueAnalysisJob,
    serverAnalysisConfigFromPreferences,
} from '@/lib/services/analysisJobs';
import {
    AutoAnalysisCapExceededError,
    AutoAnalysisDailyCapExceededError,
    AutoAnalysisMonthlyCapExceededError,
    DEFAULT_AUTO_ANALYSIS_DAILY_CAP,
    DEFAULT_AUTO_ANALYSIS_MONTHLY_CAP,
    DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
    DEFAULT_SERVER_CREDITS_BALANCE,
    DEFAULT_STOP_WHEN_CREDITS_BELOW,
    InsufficientServerCreditsError,
    MonthlyServerCreditsLimitExceededError,
    ServerCreditStopThresholdError,
} from '@/lib/services/billingAccounts';
import { summarizeCreditLedgerEntries } from '@/lib/services/creditLedger';
import {
    cancelUnexecutableAnalysisJobs,
    dispatchQueuedAnalysisJobs,
} from '@/lib/services/analysisScheduler';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';

export type AutoAnalysisBlockingReason =
    | 'disabled'
    | 'credits'
    | 'reserve'
    | 'daily-cap'
    | 'monthly-cap'
    | 'plan-cap'
    | null;

export type AutoAnalysisCapacity = {
    reservableCredits: number;
    currentBalance: number;
    reserveCredits: number;
    dailyRemaining: number;
    monthlyRemaining: number;
    planMonthlyRemaining: number;
    blockingReason: Exclude<AutoAnalysisBlockingReason, 'disabled'>;
};

export type AutoAnalysisBacklogSummary = {
    eligible: number;
    eligibleAtLeast: number;
    waitingForCredits: number;
    waitingForCreditsAtLeast: number;
    blockedReason: AutoAnalysisBlockingReason;
    queued: number;
    running: number;
    terminalFailed: number;
    countsExact: boolean;
    scannedCandidates: number;
    scanLimit: number;
};

export type AutoAnalysisInventory = {
    totalImported: number;
    analyzed: number;
    unanalyzed: number;
};

export type AutoAnalysisStatus = {
    policy: AutoAnalysisPolicy;
    inventory: AutoAnalysisInventory;
    backlog: AutoAnalysisBacklogSummary;
    capacity: AutoAnalysisCapacity;
};

type LedgerRow = {
    type: CreditLedgerEntryType;
    credits: number;
    reason: string | null;
    createdAt: Date;
    autoAnalysis?: boolean;
};

type Candidate = {
    id: string;
    provider: 'LICHESS' | 'CHESSCOM';
    result: string | null;
    timeClass:
        | 'BULLET'
        | 'BLITZ'
        | 'RAPID'
        | 'CLASSICAL'
        | 'UNKNOWN';
    rated: boolean | null;
    pgn: string;
    whiteName: string;
    blackName: string;
    playedAt: Date;
    createdAt: Date;
};

export type AutoAnalysisReconcileCursor = {
    playedAt: string;
    id: string;
};

const CANDIDATE_SELECT = {
    id: true,
    provider: true,
    result: true,
    timeClass: true,
    rated: true,
    pgn: true,
    whiteName: true,
    blackName: true,
    playedAt: true,
    createdAt: true,
} satisfies Prisma.AnalyzedGameSelect;

const STATUS_CANDIDATE_SCAN_LIMIT = 250;
const RECONCILE_CANDIDATE_SCAN_LIMIT = 2_000;
const AUTO_ANALYSIS_SWEEP_PAGE_SIZE = 100;

export type AutoAnalysisWakeupReason =
    | 'preferences'
    | 'billing'
    | 'capacity-release'
    | 'import'
    | 'scheduled';

export function calculateAutoAnalysisCapacity(args: {
    policy: AutoAnalysisPolicy;
    account: BillingAccount | null;
    ledger: LedgerRow[];
    now: Date;
}): AutoAnalysisCapacity {
    const renewalDue =
        args.account != null && args.account.serverCreditsRenewAt <= args.now;
    const monthStart = renewalDue
        ? args.now
        : previousMonthlyRenewAt(
              args.account?.serverCreditsRenewAt ??
                  nextMonthlyRenewAt(args.now)
          );
    const autoEntries = args.ledger.filter((entry) =>
        entry.autoAnalysis === true ||
        AUTO_ANALYSIS_QUEUED_REASONS.includes(
            entry.reason as (typeof AUTO_ANALYSIS_QUEUED_REASONS)[number]
        )
    );
    return calculateAutoAnalysisCapacityFromSummaries({
        policy: args.policy,
        account: args.account,
        allOutstandingReserved: summarizeCreditLedgerEntries(args.ledger)
            .outstandingReserved,
        monthlyAutoCommitted: summarizeCreditLedgerEntries(
            autoEntries.filter((entry) => entry.createdAt >= monthStart)
        ).committed,
        dailyAutoCommitted: summarizeCreditLedgerEntries(
            autoEntries.filter(
                (entry) => entry.createdAt >= startOfUtcDay(args.now)
            )
        ).committed,
        now: args.now,
    });
}

function calculateAutoAnalysisCapacityFromSummaries(args: {
    policy: AutoAnalysisPolicy;
    account: BillingAccount | null;
    allOutstandingReserved: number;
    monthlyAutoCommitted: number;
    dailyAutoCommitted: number;
    now: Date;
}): AutoAnalysisCapacity {
    const renewalDue =
        args.account != null && args.account.serverCreditsRenewAt <= args.now;
    const planMonthlyLimit =
        args.account?.monthlyServerCreditsLimit ??
        DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT;
    const currentBalance =
        args.account == null
            ? DEFAULT_SERVER_CREDITS_BALANCE
            : renewalDue
              ? Math.max(args.account.serverCreditsBalance, planMonthlyLimit)
              : args.account.serverCreditsBalance;
    const reserveCredits = Math.max(
        args.account?.stopWhenCreditsBelow ??
            DEFAULT_STOP_WHEN_CREDITS_BELOW,
        args.policy.reserveCredits
    );
    const planMonthlyRemaining = Math.max(
        0,
        planMonthlyLimit -
            (renewalDue
                ? 0
                : (args.account?.monthlyServerCreditsUsed ?? 0)) -
            args.allOutstandingReserved
    );
    const planDailyCap =
        args.account?.autoAnalysisDailyCap ?? DEFAULT_AUTO_ANALYSIS_DAILY_CAP;
    const planMonthlyCap =
        args.account?.autoAnalysisMonthlyCap ??
        DEFAULT_AUTO_ANALYSIS_MONTHLY_CAP;
    const effectiveDailyCap = Math.min(
        planDailyCap,
        args.policy.dailyCap ?? planDailyCap
    );
    const effectiveMonthlyCap = Math.min(
        planMonthlyCap,
        args.policy.monthlyCap ?? planMonthlyCap
    );
    const dailyRemaining = Math.max(
        0,
        effectiveDailyCap - args.dailyAutoCommitted
    );
    const monthlyRemaining = Math.max(
        0,
        effectiveMonthlyCap - args.monthlyAutoCommitted
    );
    const balanceRemaining = Math.max(0, currentBalance - reserveCredits);
    const reservableCredits = Math.min(
        balanceRemaining,
        planMonthlyRemaining,
        dailyRemaining,
        monthlyRemaining
    );

    let blockingReason: AutoAnalysisCapacity['blockingReason'] = null;
    if (reservableCredits === 0) {
        if (currentBalance <= 0) blockingReason = 'credits';
        else if (balanceRemaining <= 0) blockingReason = 'reserve';
        else if (planMonthlyRemaining <= 0) blockingReason = 'plan-cap';
        else if (dailyRemaining <= 0) blockingReason = 'daily-cap';
        else if (monthlyRemaining <= 0) blockingReason = 'monthly-cap';
    }

    return {
        reservableCredits,
        currentBalance,
        reserveCredits,
        dailyRemaining,
        monthlyRemaining,
        planMonthlyRemaining,
        blockingReason,
    };
}

export async function getAutoAnalysisStatus(
    userId: string,
    now = new Date()
): Promise<AutoAnalysisStatus> {
    const context = await loadContext(userId, now, {
        initializeMissingEnabledAt: false,
        candidateScanLimit: STATUS_CANDIDATE_SCAN_LIMIT,
    });
    return statusFromContext(context);
}

/**
 * Durable, idempotent reconciliation hook. It queues only jobs which can
 * reserve a credit now; credit or cap exhaustion is returned as a normal
 * blocked state. Call this after import and as a fallback from the daily cron.
 * Billing renewal/top-up handlers may also invoke it for immediate resume.
 */
export async function reconcileAutoAnalysisBacklog(
    userId: string,
    options: {
        now?: Date;
        maxJobs?: number;
        cursor?: AutoAnalysisReconcileCursor;
    } = {}
) {
    const now = options.now ?? new Date();
    const context = await loadContext(userId, now, {
        initializeMissingEnabledAt: true,
        candidateScanLimit: RECONCILE_CANDIDATE_SCAN_LIMIT,
        candidateCursor: options.cursor,
    });
    let status = statusFromContext(context);
    if (!context.policy.enabled || status.backlog.eligible === 0) {
        return {
            queued: 0,
            errors: [],
            nextCursor: context.scan.nextCursor,
            ...status,
        };
    }

    const maxJobs = Math.max(
        0,
        Math.min(
            Math.trunc(options.maxJobs ?? context.eligible.length),
            status.capacity.reservableCredits,
            context.eligible.length
        )
    );
    if (maxJobs === 0) {
        return {
            queued: 0,
            errors: [],
            nextCursor: context.scan.nextCursor,
            ...status,
        };
    }

    const config = serverAnalysisConfigFromPreferences(
        context.preferences
    ).config;
    let queued = 0;
    const errors: Array<{ gameId: string; error: string }> = [];
    for (const item of context.eligible.slice(0, maxJobs)) {
        try {
            const result = await enqueueAnalysisJob({
                userId,
                gameId: item.gameId,
                queuedReason: 'auto-analysis',
                priority: item.eligibility.priority,
                config,
            });
            if (result.queued) queued += 1;
        } catch (error) {
            const blocked = billingBlockingReason(error);
            if (blocked) {
                status = {
                    ...status,
                    backlog: {
                        ...status.backlog,
                        waitingForCredits: Math.max(
                            0,
                            status.backlog.eligible - queued
                        ),
                        waitingForCreditsAtLeast: Math.max(
                            0,
                            status.backlog.eligibleAtLeast - queued
                        ),
                        blockedReason: blocked,
                    },
                    capacity: {
                        ...status.capacity,
                        reservableCredits: 0,
                        blockingReason: blocked,
                    },
                };
                break;
            }
            errors.push({
                gameId: item.gameId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return {
        queued,
        errors,
        nextCursor: context.scan.nextCursor,
        ...status,
        backlog: {
            ...status.backlog,
            eligible: Math.max(0, status.backlog.eligible - queued),
            eligibleAtLeast: Math.max(
                0,
                status.backlog.eligibleAtLeast - queued
            ),
            queued: status.backlog.queued + queued,
        },
        capacity: {
            ...status.capacity,
            reservableCredits: Math.max(
                0,
                status.capacity.reservableCredits - queued
            ),
            blockingReason:
                status.capacity.reservableCredits - queued <= 0 &&
                status.backlog.blockedReason !== 'disabled'
                    ? (status.backlog.blockedReason ??
                      status.capacity.blockingReason)
                    : status.capacity.blockingReason,
        },
    };
}

export async function reconcileAndDispatchAutoAnalysisBacklog(
    userId: string,
    options: {
        now?: Date;
        maxJobs?: number;
        cursor?: AutoAnalysisReconcileCursor;
    } = {}
) {
    const reconciliation = await reconcileAutoAnalysisBacklog(
        userId,
        {
            ...options,
            // The scheduler intentionally dispatches one job per user. Reserve
            // only that executable unit; completion releases capacity and
            // schedules the next reconciliation.
            maxJobs: options.maxJobs ?? 1,
        }
    );
    const dispatch =
        reconciliation.policy.enabled &&
        (reconciliation.queued > 0 || reconciliation.backlog.queued > 0)
            ? await dispatchQueuedAnalysisJobs({
                  userIds: [userId],
                  globalLimit: Math.max(
                      1,
                      Math.min(options.maxJobs ?? 100, reconciliation.queued)
                  ),
                  throwOnPublishError: false,
              })
            : null;
    const unpublishedJobIds =
        dispatch?.published
            .filter((result) => !result.queued)
            .map((result) => result.jobId) ?? [];
    const cleanup =
        unpublishedJobIds.length > 0
            ? await cancelUnexecutableAnalysisJobs({
                  userId,
                  jobIds: unpublishedJobIds,
                  reason:
                      'Automatic analysis could not be handed to a durable worker',
              })
            : null;
    let continuation = null;
    if (
        reconciliation.nextCursor &&
        reconciliation.queued === 0 &&
        reconciliation.backlog.queued === 0 &&
        reconciliation.backlog.running === 0 &&
        reconciliation.capacity.reservableCredits > 0
    ) {
        const requestedAt = new Date().toISOString();
        try {
            continuation = await publishBackranqQueueMessage(
                {
                    type: 'reconcile-auto-analysis',
                    userId,
                    requestedAt,
                    reason: 'capacity-release',
                    cursor: reconciliation.nextCursor,
                },
                {
                    idempotencyKey:
                        `auto-analysis-reconcile:${userId}:cursor:` +
                        `${reconciliation.nextCursor.playedAt}:` +
                        `${reconciliation.nextCursor.id}:${requestedAt}`,
                }
            );
        } catch (error) {
            continuation = {
                queued: false,
                messageId: null,
                unavailableReason: 'publish-failed' as const,
                error,
            };
        }
    }
    return { reconciliation, dispatch, cleanup, continuation };
}

export function scheduleAutoAnalysisWakeup(
    userId: string,
    reason: 'preferences' | 'billing'
) {
    try {
        after(async () => {
            await requestAutoAnalysisWakeup(userId, reason);
        });
        return true;
    } catch (error) {
        if (process.env.NODE_ENV !== 'test') {
            console.error(
                `[auto analysis] unable to register ${reason} wakeup`,
                error
            );
        }
        return false;
    }
}

export async function requestAutoAnalysisWakeup(
    userId: string,
    reason: AutoAnalysisWakeupReason
) {
    const requestedAt = new Date().toISOString();
    try {
        const published = await publishBackranqQueueMessage(
            {
                type: 'reconcile-auto-analysis',
                userId,
                requestedAt,
                reason,
            },
            {
                idempotencyKey:
                    `auto-analysis-reconcile:${userId}:${reason}:${requestedAt}`,
            }
        );
        if (published.queued) {
            return { queued: true, inline: false, published };
        }
        return { queued: false, inline: false, published };
    } catch (error) {
        // Unanalyzed games are the durable backlog. Never reserve credits
        // without a durable worker wakeup; the scheduled sweep will retry.
        return {
            queued: false,
            inline: false,
            published: null,
            publishError: error,
        };
    }
}

/**
 * Successful automatic work consumes its reservation, so the generic
 * credit-release hook cannot advance the backlog. Queue callbacks invoke this
 * after each delivery; only a terminal automatic run emits one idempotent
 * reconciliation wakeup.
 */
export async function requestAutoAnalysisContinuationAfterTerminalJob(
    jobId: string
) {
    const job = await prisma.analysisJob.findUnique({
        where: { id: jobId },
        select: {
            userId: true,
            status: true,
            analysisRun: {
                select: {
                    id: true,
                    queuedReason: true,
                },
            },
        },
    });
    if (
        !job?.analysisRun ||
        (job.status !== 'SUCCEEDED' && job.status !== 'FAILED') ||
        !AUTO_ANALYSIS_QUEUED_REASONS.includes(
            job.analysisRun
                .queuedReason as (typeof AUTO_ANALYSIS_QUEUED_REASONS)[number]
        )
    ) {
        return null;
    }

    const requestedAt = new Date().toISOString();
    return publishBackranqQueueMessage(
        {
            type: 'reconcile-auto-analysis',
            userId: job.userId,
            requestedAt,
            reason: 'capacity-release',
        },
        {
            idempotencyKey:
                `auto-analysis-terminal:${job.analysisRun.id}:reconcile`,
        }
    );
}

/**
 * Bounded daily sweep for enabled policies. It only publishes durable
 * per-user wakeups and a cursor continuation; it never reserves credits in
 * the sweep request itself.
 */
export async function dispatchAutoAnalysisPolicySweep(options: {
    requestedAt?: string;
    cursor?: string;
    limit?: number;
} = {}) {
    const requestedAt = options.requestedAt ?? new Date().toISOString();
    const limit = Math.max(
        1,
        Math.min(Math.trunc(options.limit ?? AUTO_ANALYSIS_SWEEP_PAGE_SIZE), 500)
    );
    const rows = await prisma.user.findMany({
        where: options.cursor ? { id: { gt: options.cursor } } : undefined,
        orderBy: { id: 'asc' },
        take: limit + 1,
        select: { id: true, preferences: true },
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const published: Array<{
        userId: string;
        queued: boolean;
        messageId: string | null;
    }> = [];

    for (const user of page) {
        if (!canonicalPreferences(user.preferences ?? {}).autoAnalysis.enabled) {
            continue;
        }
        try {
            const result = await publishBackranqQueueMessage(
                {
                    type: 'reconcile-auto-analysis',
                    userId: user.id,
                    requestedAt,
                    reason: 'scheduled',
                },
                {
                    idempotencyKey:
                        `auto-analysis-reconcile:${user.id}:scheduled:` +
                        requestedAt,
                }
            );
            published.push({
                userId: user.id,
                queued: result.queued,
                messageId: result.messageId,
            });
        } catch {
            published.push({
                userId: user.id,
                queued: false,
                messageId: null,
            });
        }
    }

    const nextCursor = hasMore ? page.at(-1)?.id ?? null : null;
    let continuation = null;
    if (nextCursor) {
        try {
            continuation = await publishBackranqQueueMessage(
                {
                    type: 'reconcile-auto-analysis-sweep',
                    requestedAt,
                    cursor: nextCursor,
                },
                {
                    idempotencyKey:
                        `auto-analysis-sweep:${requestedAt}:` + nextCursor,
                }
            );
        } catch {
            continuation = {
                queued: false,
                messageId: null,
                unavailableReason: 'publish-failed' as const,
            };
        }
    }

    return {
        scanned: page.length,
        enabled: published.length,
        published,
        nextCursor,
        continuation,
    };
}

async function loadContext(
    userId: string,
    now: Date,
    options: {
        initializeMissingEnabledAt: boolean;
        candidateScanLimit: number;
        candidateCursor?: AutoAnalysisReconcileCursor;
    }
) {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            preferences: true,
            lichessUsername: true,
            chesscomUsername: true,
        },
    });
    let preferences = canonicalPreferences(user?.preferences ?? {});
    let policy = preferences.autoAnalysis;
    const missingNewBacklogBoundary =
        policy.enabled &&
        policy.backlogMode === 'new' &&
        policy.enabledAt === null;
    if (missingNewBacklogBoundary) {
        const enabledAt = now.toISOString();
        const patched = mergePreferences(preferences, {
            autoAnalysis: { enabledAt },
        });
        if (options.initializeMissingEnabledAt) {
            await prisma.user.update({
                where: { id: userId },
                data: {
                    preferences:
                        patched as unknown as Prisma.InputJsonValue,
                },
            });
            preferences = patched;
            policy = patched.autoAnalysis;
        }
    }
    const eligibilityPreferences = missingNewBacklogBoundary
        ? mergePreferences(preferences, {
              autoAnalysis: {
                  enabledAt: policy.enabledAt ?? now.toISOString(),
              },
          })
        : preferences;
    const eligibilityPolicy = eligibilityPreferences.autoAnalysis;
    const candidateWhere: Prisma.AnalyzedGameWhereInput = {
        userId,
        analyzedAt: null,
        ...metadataEligibilityWhere({
            policy: eligibilityPolicy,
            lichessUsername: user?.lichessUsername,
            chesscomUsername: user?.chesscomUsername,
        }),
        ...(eligibilityPolicy.backlogMode === 'new' &&
        eligibilityPolicy.enabledAt
            ? { createdAt: { gte: new Date(eligibilityPolicy.enabledAt) } }
            : {}),
        analysisJobs: {
            none: {
                status: {
                    in: ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'],
                },
            },
        },
        ...(options.candidateCursor
            ? {
                  AND: [
                      {
                          OR: [
                              {
                                  playedAt: {
                                      lt: new Date(
                                          options.candidateCursor.playedAt
                                      ),
                                  },
                              },
                              {
                                  playedAt: new Date(
                                      options.candidateCursor.playedAt
                                  ),
                                  id: {
                                      lt: options.candidateCursor.id,
                                  },
                              },
                          ],
                      },
                  ],
              }
            : {}),
    };
    const candidatePromise = eligibilityPolicy.enabled
        ? (prisma.analyzedGame.findMany({
              where: candidateWhere,
              select: CANDIDATE_SELECT,
              orderBy: [{ playedAt: 'desc' }, { id: 'desc' }],
              take: options.candidateScanLimit + 1,
          }) as Promise<Candidate[]>)
        : Promise.resolve([] as Candidate[]);
    const [
        totalImported,
        analyzed,
        scannedCandidates,
        queued,
        running,
        terminalFailed,
        capacity,
    ] = await Promise.all([
        prisma.analyzedGame.count({ where: { userId } }),
        prisma.analyzedGame.count({
            where: { userId, analyzedAt: { not: null } },
        }),
        candidatePromise,
        prisma.analysisJob.count({
            where: {
                userId,
                status: 'QUEUED',
                queuedReason: { in: [...AUTO_ANALYSIS_QUEUED_REASONS] },
            },
        }),
        prisma.analysisJob.count({
            where: {
                userId,
                status: 'RUNNING',
                queuedReason: { in: [...AUTO_ANALYSIS_QUEUED_REASONS] },
            },
        }),
        prisma.analysisJob.count({
            where: {
                userId,
                status: 'FAILED',
                queuedReason: { in: [...AUTO_ANALYSIS_QUEUED_REASONS] },
            },
        }),
        loadAutoAnalysisCapacity(userId, policy, now),
    ]);
    const candidatesTruncated =
        scannedCandidates.length > options.candidateScanLimit;
    const candidates = candidatesTruncated
        ? scannedCandidates.slice(0, options.candidateScanLimit)
        : scannedCandidates;
    const lastCandidate = candidates.at(-1);
    const eligible = eligibleAutoAnalysisGameIds({
        preferences: eligibilityPreferences,
        games: candidates,
        gameId: (game) => game.id,
        usernameByProvider: {
            lichess: user?.lichessUsername,
            chesscom: user?.chesscomUsername,
        },
    }).sort(
        (a, b) =>
            b.eligibility.priority - a.eligibility.priority ||
            b.game.playedAt.getTime() - a.game.playedAt.getTime()
    );
    return {
        preferences,
        policy,
        eligible,
        capacity,
        inventory: {
            totalImported,
            analyzed,
            unanalyzed: Math.max(0, totalImported - analyzed),
        },
        counts: { queued, running, terminalFailed },
        scan: {
            countsExact:
                !candidatesTruncated && options.candidateCursor == null,
            scannedCandidates: candidates.length,
            scanLimit: options.candidateScanLimit,
            nextCursor:
                candidatesTruncated && lastCandidate
                    ? {
                          playedAt: lastCandidate.playedAt.toISOString(),
                          id: lastCandidate.id,
                      }
                    : null,
        },
    };
}

async function loadAutoAnalysisCapacity(
    userId: string,
    policy: AutoAnalysisPolicy,
    now: Date
) {
    const account = await prisma.billingAccount.findUnique({
        where: { userId },
    });
    const renewalDue =
        account !== null && account.serverCreditsRenewAt <= now;
    const monthStart = renewalDue
        ? now
        : previousMonthlyRenewAt(
              account?.serverCreditsRenewAt ?? nextMonthlyRenewAt(now)
          );
    const autoReasonWhere = {
        OR: [
            { reason: { in: [...AUTO_ANALYSIS_QUEUED_REASONS] } },
            {
                analysisRun: {
                    is: {
                        queuedReason: {
                            in: [...AUTO_ANALYSIS_QUEUED_REASONS],
                        },
                    },
                },
            },
        ],
    };
    const [allTotals, monthlyAutoTotals, dailyAutoTotals] = await Promise.all([
        prisma.creditLedgerEntry.groupBy({
            by: ['type'],
            where: { userId },
            _sum: { credits: true },
        }),
        prisma.creditLedgerEntry.groupBy({
            by: ['type'],
            where: {
                userId,
                ...autoReasonWhere,
                createdAt: { gte: monthStart },
            },
            _sum: { credits: true },
        }),
        prisma.creditLedgerEntry.groupBy({
            by: ['type'],
            where: {
                userId,
                ...autoReasonWhere,
                createdAt: { gte: startOfUtcDay(now) },
            },
            _sum: { credits: true },
        }),
    ]);
    const summary = (
        rows: Array<{
            type: CreditLedgerEntryType;
            _sum: { credits: number | null };
        }>
    ) =>
        summarizeCreditLedgerEntries(
            rows.map((row) => ({
                type: row.type,
                credits: row._sum.credits ?? 0,
            }))
        );
    return calculateAutoAnalysisCapacityFromSummaries({
        policy,
        account,
        allOutstandingReserved: summary(allTotals).outstandingReserved,
        monthlyAutoCommitted: summary(monthlyAutoTotals).committed,
        dailyAutoCommitted: summary(dailyAutoTotals).committed,
        now,
    });
}

function metadataEligibilityWhere(args: {
    policy: AutoAnalysisPolicy;
    lichessUsername?: string | null;
    chesscomUsername?: string | null;
}): Prisma.AnalyzedGameWhereInput {
    const timeClasses = (
        [
            ['bullet', 'BULLET'],
            ['blitz', 'BLITZ'],
            ['rapid', 'RAPID'],
            ['classical', 'CLASSICAL'],
            ['unknown', 'UNKNOWN'],
        ] as const
    )
        .filter(([key]) => args.policy.timeControls[key])
        .map(([, value]) => value);
    const providerBranches: Prisma.AnalyzedGameWhereInput[] = [];
    if (args.policy.providers.lichess && args.lichessUsername) {
        providerBranches.push(
            ...providerResultBranches({
                provider: 'LICHESS',
                username: args.lichessUsername,
                scope: args.policy.resultScope,
            })
        );
    }
    if (args.policy.providers.chesscom && args.chesscomUsername) {
        providerBranches.push(
            ...providerResultBranches({
                provider: 'CHESSCOM',
                username: args.chesscomUsername,
                scope: args.policy.resultScope,
            })
        );
    }
    if (providerBranches.length === 0 || timeClasses.length === 0) {
        return { id: { in: [] } };
    }
    return {
        OR: providerBranches,
        timeClass: { in: timeClasses },
        ...(args.policy.ratedOnly ? { rated: true } : {}),
    };
}

function providerResultBranches(args: {
    provider: 'LICHESS' | 'CHESSCOM';
    username: string;
    scope: AutoAnalysisPolicy['resultScope'];
}): Prisma.AnalyzedGameWhereInput[] {
    const name = {
        equals: args.username,
        mode: 'insensitive' as const,
    };
    const branches: Prisma.AnalyzedGameWhereInput[] = [
        {
            provider: args.provider,
            whiteName: name,
            result: '0-1',
        },
        {
            provider: args.provider,
            blackName: name,
            result: '1-0',
        },
    ];
    if (args.scope === 'draws' || args.scope === 'all') {
        branches.push({
            provider: args.provider,
            result: '1/2-1/2',
            OR: [{ whiteName: name }, { blackName: name }],
        });
    }
    if (args.scope === 'all') {
        branches.push(
            {
                provider: args.provider,
                whiteName: name,
                result: '1-0',
            },
            {
                provider: args.provider,
                blackName: name,
                result: '0-1',
            }
        );
    }
    return branches;
}

function statusFromContext(
    context: Awaited<ReturnType<typeof loadContext>>
): AutoAnalysisStatus {
    const eligibleAtLeast = context.eligible.length;
    const waitingForCreditsAtLeast = Math.max(
        0,
        eligibleAtLeast - context.capacity.reservableCredits
    );
    const blockedReason = !context.policy.enabled
        ? 'disabled'
        : waitingForCreditsAtLeast > 0
          ? capacityConstraintReason(context.capacity)
          : null;
    return {
        policy: context.policy,
        inventory: context.inventory,
        backlog: {
            eligible: eligibleAtLeast,
            eligibleAtLeast,
            waitingForCredits: waitingForCreditsAtLeast,
            waitingForCreditsAtLeast,
            blockedReason,
            queued: context.counts.queued,
            running: context.counts.running,
            terminalFailed: context.counts.terminalFailed,
            countsExact: context.scan.countsExact,
            scannedCandidates: context.scan.scannedCandidates,
            scanLimit: context.scan.scanLimit,
        },
        capacity: context.capacity,
    };
}

function capacityConstraintReason(
    capacity: AutoAnalysisCapacity
): Exclude<AutoAnalysisBlockingReason, 'disabled' | null> {
    if (capacity.blockingReason) return capacity.blockingReason;
    const balanceRemaining = Math.max(
        0,
        capacity.currentBalance - capacity.reserveCredits
    );
    const minimum = Math.min(
        balanceRemaining,
        capacity.planMonthlyRemaining,
        capacity.dailyRemaining,
        capacity.monthlyRemaining
    );
    if (balanceRemaining === minimum) {
        return capacity.reserveCredits > 0 && capacity.currentBalance > 0
            ? 'reserve'
            : 'credits';
    }
    if (capacity.planMonthlyRemaining === minimum) return 'plan-cap';
    if (capacity.dailyRemaining === minimum) return 'daily-cap';
    return 'monthly-cap';
}

function billingBlockingReason(
    error: unknown
): Exclude<AutoAnalysisBlockingReason, 'disabled' | null> | null {
    if (error instanceof InsufficientServerCreditsError) return 'credits';
    if (error instanceof ServerCreditStopThresholdError) return 'reserve';
    if (error instanceof MonthlyServerCreditsLimitExceededError) {
        return 'plan-cap';
    }
    if (error instanceof AutoAnalysisDailyCapExceededError) return 'daily-cap';
    if (error instanceof AutoAnalysisMonthlyCapExceededError) {
        return 'monthly-cap';
    }
    if (error instanceof AutoAnalysisCapExceededError) {
        return 'daily-cap';
    }
    return null;
}

function nextMonthlyRenewAt(now: Date) {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
}

function previousMonthlyRenewAt(renewAt: Date) {
    const previous = new Date(renewAt);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    return previous;
}

function startOfUtcDay(date: Date) {
    return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
}
