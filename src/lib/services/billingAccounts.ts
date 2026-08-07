import type {
    BillingAccount,
    CreditLedgerEntry,
    CreditLedgerEntryType,
    Prisma,
} from '@prisma/client';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordBillingNotification } from '@/lib/notifications/service';
import {
    CreditLedgerError,
    InsufficientConsumedCreditsError,
    InsufficientReservedCreditsError,
    summarizeCreditLedgerEntries,
    type CreditLedgerSummary,
} from '@/lib/services/creditLedger';
import { nextMonthlyRenewAt } from '@/lib/billing/periods';
import { BILLING_PLAN_ENTITLEMENTS } from '@/lib/billing/plans';
import { resolveEffectiveBillingEntitlement } from '@/lib/billing/entitlements';

export const SERVER_ANALYSIS_BILLING_POLICY_V2 =
    'server-analysis-quality-price-v2';

const FREE_ENTITLEMENTS = BILLING_PLAN_ENTITLEMENTS.FREE;
export const DEFAULT_SERVER_CREDITS_BALANCE =
    FREE_ENTITLEMENTS.monthlyServerCreditsLimit;
export const DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT =
    FREE_ENTITLEMENTS.monthlyServerCreditsLimit;
export const DEFAULT_AUTO_ANALYSIS_MONTHLY_GAME_LIMIT =
    FREE_ENTITLEMENTS.autoAnalysisMonthlyGameLimit;
export const DEFAULT_AUTO_ANALYSIS_DAILY_GAME_LIMIT =
    FREE_ENTITLEMENTS.autoAnalysisDailyGameLimit;
export const DEFAULT_STOP_WHEN_CREDITS_BELOW =
    FREE_ENTITLEMENTS.stopWhenCreditsBelow;
const AUTO_ANALYSIS_LEDGER_REASONS = ['auto-sync', 'auto-analysis'];

export type BillingTransactionClient = Pick<
    Prisma.TransactionClient,
    | 'billingAccount'
    | 'creditLedgerEntry'
    | 'analysisRun'
    | 'user'
    | 'adminMembership'
    | 'planGrant'
    | 'notificationPreference'
    | 'notification'
    | 'notificationDelivery'
    | 'pushSubscription'
>;

type CreditLedgerReference = {
    userId: string;
    analysisJobId?: string | null;
    analysisRunId?: string | null;
    gameId?: string | null;
};

type BillingCreditWriteArgs = CreditLedgerReference & {
    credits: number;
    idempotencyKey: string;
    reason?: string | null;
    metadata?: Prisma.InputJsonObject;
};

export type ReserveServerAnalysisCreditsArgs = BillingCreditWriteArgs & {
    enforceAutoAnalysisCaps?: boolean;
    enforceStopThreshold?: boolean;
    autoAnalysisBudget?: {
        dailyGameLimit: number | null;
        monthlyGameLimit: number | null;
        creditReserve: number;
    };
    now?: Date;
};

export type BillingCreditWriteResult = {
    entry: CreditLedgerEntry;
    created: boolean;
    account: BillingAccount | null;
    summary: CreditLedgerSummary | null;
    policy: typeof SERVER_ANALYSIS_BILLING_POLICY_V2;
};

type LedgerEntryForSummary = Pick<CreditLedgerEntry, 'type' | 'credits'>;

export class BillingAccountError extends CreditLedgerError {
    constructor(message: string) {
        super(message);
        this.name = 'BillingAccountError';
    }
}

export class InsufficientServerCreditsError extends BillingAccountError {
    constructor(message = 'Insufficient server analysis credits') {
        super(message);
        this.name = 'InsufficientServerCreditsError';
    }
}

export class MonthlyServerCreditsLimitExceededError extends BillingAccountError {
    constructor(message = 'Monthly server analysis credit limit exceeded') {
        super(message);
        this.name = 'MonthlyServerCreditsLimitExceededError';
    }
}

export class AutoAnalysisCapExceededError extends BillingAccountError {
    constructor(message = 'Automatic analysis game limit exceeded') {
        super(message);
        this.name = 'AutoAnalysisCapExceededError';
    }
}

export class AutoAnalysisMonthlyCapExceededError extends AutoAnalysisCapExceededError {
    constructor(message = 'Automatic analysis monthly game limit exceeded') {
        super(message);
        this.name = 'AutoAnalysisMonthlyCapExceededError';
    }
}

export class AutoAnalysisDailyCapExceededError extends AutoAnalysisCapExceededError {
    constructor(message = 'Automatic analysis daily game limit exceeded') {
        super(message);
        this.name = 'AutoAnalysisDailyCapExceededError';
    }
}

export class ServerCreditStopThresholdError extends BillingAccountError {
    constructor(message = 'Server analysis credit stop threshold reached') {
        super(message);
        this.name = 'ServerCreditStopThresholdError';
    }
}

export async function getOrCreateDefaultBillingAccount(userId: string) {
    return prisma.$transaction(
        async (tx) =>
            getOrCreateDefaultBillingAccountInTransaction({
                tx,
                userId,
                now: new Date(),
            }),
        serializableTransactionOptions()
    );
}

export async function reserveServerAnalysisCredits(
    args: ReserveServerAnalysisCreditsArgs
): Promise<BillingCreditWriteResult> {
    return prisma.$transaction(
        (tx) => reserveServerAnalysisCreditsInTransaction({ tx, ...args }),
        serializableTransactionOptions()
    );
}

export async function reserveServerAnalysisCreditsInTransaction(
    args: ReserveServerAnalysisCreditsArgs & { tx: BillingTransactionClient }
): Promise<BillingCreditWriteResult> {
    const { tx, ...writeArgs } = args;
    const existing = await findIdempotentEntry(tx, writeArgs.idempotencyKey);
    if (existing) return existingResult(tx, existing);

    assertPositiveCredits(writeArgs.credits);
    const now = writeArgs.now ?? new Date();
    const account = await getOrCreateDefaultBillingAccountInTransaction({
        tx,
        userId: writeArgs.userId,
        now,
    });
    const userSummary = await getLedgerSummary(tx, { userId: writeArgs.userId });

    const effectiveReserve = writeArgs.autoAnalysisBudget
        ? Math.max(
              account.stopWhenCreditsBelow,
              nonNegativeInt(writeArgs.autoAnalysisBudget.creditReserve)
          )
        : writeArgs.enforceStopThreshold
          ? account.stopWhenCreditsBelow
          : 0;
    assertBalanceAvailable(account, writeArgs.credits, effectiveReserve);
    assertMonthlyLimitAvailable(account, userSummary, writeArgs.credits);
    if (writeArgs.enforceAutoAnalysisCaps) {
        await assertAutoAnalysisCapsAvailable({
            tx,
            account,
            now,
            personalBudget: writeArgs.autoAnalysisBudget,
        });
    }

    const debited = await tx.billingAccount.updateMany({
        where: {
            userId: writeArgs.userId,
            serverCreditsBalance: {
                gte: writeArgs.credits + effectiveReserve,
            },
        },
        data: {
            serverCreditsBalance: { decrement: writeArgs.credits },
        },
    });
    if (debited.count !== 1) throw new InsufficientServerCreditsError();

    const updatedAccount = await tx.billingAccount.findUniqueOrThrow({
        where: { userId: writeArgs.userId },
    });
    if (
        updatedAccount.serverCreditsBalance <=
        updatedAccount.stopWhenCreditsBelow
    ) {
        const month = now.toISOString().slice(0, 7);
        await recordBillingNotification(
            {
                userId: writeArgs.userId,
                eventId: `low-credits:${month}`,
                type: 'LOW_CREDITS',
                title: 'Automatic analysis is paused',
                body: `Your balance reached the ${updatedAccount.stopWhenCreditsBelow}-credit reserve. Add credits or lower the reserve to resume automatic analysis.`,
            },
            tx
        );
    }
    return createLedgerResult(tx, updatedAccount, 'RESERVED', writeArgs);
}

export async function consumeServerAnalysisCredits(
    args: BillingCreditWriteArgs
): Promise<BillingCreditWriteResult> {
    return prisma.$transaction(
        (tx) => consumeServerAnalysisCreditsInTransaction({ tx, ...args }),
        serializableTransactionOptions()
    );
}

export async function consumeServerAnalysisCreditsInTransaction(
    args: BillingCreditWriteArgs & { tx: BillingTransactionClient }
): Promise<BillingCreditWriteResult> {
    const { tx, ...writeArgs } = args;
    const existing = await findIdempotentEntry(tx, writeArgs.idempotencyKey);
    if (existing) return existingResult(tx, existing);

    assertPositiveCredits(writeArgs.credits);
    const account = await getOrCreateDefaultBillingAccountInTransaction({
        tx,
        userId: writeArgs.userId,
        now: new Date(),
    });
    const scopedSummary = await getLedgerSummary(tx, writeArgs);
    if (scopedSummary.outstandingReserved < writeArgs.credits) {
        throw new InsufficientReservedCreditsError();
    }
    if (
        account.monthlyServerCreditsUsed + writeArgs.credits >
        account.monthlyServerCreditsLimit
    ) {
        throw new MonthlyServerCreditsLimitExceededError();
    }

    const updated = await tx.billingAccount.update({
        where: { userId: writeArgs.userId },
        data: {
            monthlyServerCreditsUsed: { increment: writeArgs.credits },
        },
    });
    return createLedgerResult(tx, updated, 'CONSUMED', writeArgs);
}

export async function releaseServerAnalysisCredits(
    args: BillingCreditWriteArgs
): Promise<BillingCreditWriteResult> {
    return writeReservedCreditReturn(args, 'RELEASED');
}

export async function releaseServerAnalysisCreditsAndMarkRunReleased(
    args: BillingCreditWriteArgs & { analysisRunId: string }
) {
    const result = await prisma.$transaction(async (tx) => {
        const released = await writeReservedCreditReturnInTransaction(
            { tx, ...args },
            'RELEASED'
        );
        const run = await tx.analysisRun.updateMany({
            where: { id: args.analysisRunId },
            data: { consumedCredits: 0 },
        });
        if (run.count !== 1) {
            throw new BillingAccountError(
                'Released analysis run could not be marked settled'
            );
        }
        return released;
    }, serializableTransactionOptions());
    await wakeAutoAnalysisAfterRelease(args.userId, result.created);
    return result;
}

export async function releaseServerAnalysisCreditsInTransaction(
    args: BillingCreditWriteArgs & { tx: BillingTransactionClient }
): Promise<BillingCreditWriteResult> {
    return writeReservedCreditReturnInTransaction(args, 'RELEASED');
}

export async function refundServerAnalysisCredits(
    args: BillingCreditWriteArgs
): Promise<BillingCreditWriteResult> {
    return prisma.$transaction(async (tx) => {
        const existing = await findIdempotentEntry(tx, args.idempotencyKey);
        if (existing) return existingResult(tx, existing);

        assertPositiveCredits(args.credits);
        const account = await getOrCreateDefaultBillingAccountInTransaction({
            tx,
            userId: args.userId,
            now: new Date(),
        });
        const scopedSummary = await getLedgerSummary(tx, args);
        if (scopedSummary.netConsumed < args.credits) {
            throw new InsufficientConsumedCreditsError();
        }

        const monthlyUsageRefund = Math.min(
            account.monthlyServerCreditsUsed,
            args.credits
        );
        const updated = await tx.billingAccount.update({
            where: { userId: args.userId },
            data: {
                serverCreditsBalance: { increment: args.credits },
                monthlyServerCreditsUsed: {
                    decrement: monthlyUsageRefund,
                },
            },
        });
        return createLedgerResult(tx, updated, 'REFUNDED', args);
    }, serializableTransactionOptions());
}

async function writeReservedCreditReturn(
    args: BillingCreditWriteArgs,
    type: 'RELEASED' | 'EXPIRED'
) {
    const result = await prisma.$transaction(
        (tx) =>
            writeReservedCreditReturnInTransaction({ tx, ...args }, type),
        serializableTransactionOptions()
    );
    if (type === 'RELEASED') {
        await wakeAutoAnalysisAfterRelease(args.userId, result.created);
    }
    return result;
}

async function wakeAutoAnalysisAfterRelease(
    userId: string,
    releaseCreated: boolean
) {
    if (!releaseCreated) return;
    try {
        const { requestAutoAnalysisWakeup } = await import(
            '@/lib/services/autoAnalysisBacklog'
        );
        await requestAutoAnalysisWakeup(userId, 'capacity-release');
    } catch (error) {
        // Credit settlement is already committed. A wakeup failure must never
        // make the caller retry or double-release the reservation.
        console.error(
            '[auto analysis] capacity-release wakeup failed',
            error
        );
    }
}

async function writeReservedCreditReturnInTransaction(
    args: BillingCreditWriteArgs & { tx: BillingTransactionClient },
    type: 'RELEASED' | 'EXPIRED'
) {
    const { tx, ...writeArgs } = args;
    const existing = await findIdempotentEntry(tx, writeArgs.idempotencyKey);
    if (existing) return existingResult(tx, existing);

    assertPositiveCredits(writeArgs.credits);
    const account = await getOrCreateDefaultBillingAccountInTransaction({
        tx,
        userId: writeArgs.userId,
        now: new Date(),
    });
    const scopedSummary = await getLedgerSummary(tx, writeArgs);
    if (scopedSummary.outstandingReserved < writeArgs.credits) {
        throw new InsufficientReservedCreditsError();
    }

    const updated = await tx.billingAccount.update({
        where: { userId: writeArgs.userId },
        data: {
            serverCreditsBalance:
                type === 'RELEASED'
                    ? { increment: writeArgs.credits }
                    : undefined,
        },
    });
    void account;
    return createLedgerResult(tx, updated, type, writeArgs);
}

export type StripeAllowancePeriod = {
    start: Date;
    end: Date;
};

export async function reconcileBillingAccountInTransaction(args: {
    tx: BillingTransactionClient;
    userId: string;
    now: Date;
    stripeAllowancePeriod?: StripeAllowancePeriod;
}) {
    const account = await args.tx.billingAccount.upsert({
        where: { userId: args.userId },
        update: {},
        create: {
            userId: args.userId,
            plan: 'FREE',
            planSource: 'FREE',
            stripePlan: 'FREE',
            serverCreditsBalance: DEFAULT_SERVER_CREDITS_BALANCE,
            monthlyServerCreditsUsed: 0,
            serverCreditsPeriodStart: args.now,
            serverCreditsRenewAt: nextMonthlyRenewAt(args.now),
            monthlyServerCreditsLimit: DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
            autoAnalysisMonthlyGameLimit:
                DEFAULT_AUTO_ANALYSIS_MONTHLY_GAME_LIMIT,
            autoAnalysisDailyGameLimit:
                DEFAULT_AUTO_ANALYSIS_DAILY_GAME_LIMIT,
            stopWhenCreditsBelow: DEFAULT_STOP_WHEN_CREDITS_BELOW,
        },
    });

    const effective = await resolveEffectiveBillingEntitlement({
        tx: args.tx,
        userId: args.userId,
        account,
        now: args.now,
    });
    const entitlements = BILLING_PLAN_ENTITLEMENTS[effective.plan];
    const planChanged = account.plan !== effective.plan;
    const sourceChanged =
        (account.planSource ?? 'FREE') !== effective.source;
    const stripePeriodReset =
        effective.source === 'STRIPE' && !!args.stripeAllowancePeriod;
    const localPeriodReset =
        effective.source !== 'STRIPE' &&
        account.serverCreditsRenewAt <= args.now;
    const resetPeriod = stripePeriodReset || localPeriodReset;

    let serverCreditsBalance = account.serverCreditsBalance;
    let monthlyServerCreditsUsed = account.monthlyServerCreditsUsed;
    let serverCreditsPeriodStart = account.serverCreditsPeriodStart;
    let serverCreditsRenewAt = account.serverCreditsRenewAt;

    if (resetPeriod) {
        serverCreditsBalance = entitlements.monthlyServerCreditsLimit;
        monthlyServerCreditsUsed = 0;
        serverCreditsPeriodStart =
            args.stripeAllowancePeriod?.start ?? args.now;
        serverCreditsRenewAt =
            args.stripeAllowancePeriod?.end ?? nextMonthlyRenewAt(args.now);
    } else if (planChanged) {
        const remainingUnderTarget = Math.max(
            0,
            entitlements.monthlyServerCreditsLimit -
                account.monthlyServerCreditsUsed
        );
        const allowanceIncrease = Math.max(
            0,
            entitlements.monthlyServerCreditsLimit -
                account.monthlyServerCreditsLimit
        );
        serverCreditsBalance = Math.min(
            remainingUnderTarget,
            account.serverCreditsBalance + allowanceIncrease
        );
    }

    const data = {
        plan: effective.plan,
        planSource: effective.source,
        monthlyServerCreditsLimit: entitlements.monthlyServerCreditsLimit,
        autoAnalysisMonthlyGameLimit:
            entitlements.autoAnalysisMonthlyGameLimit,
        autoAnalysisDailyGameLimit:
            entitlements.autoAnalysisDailyGameLimit,
        stopWhenCreditsBelow: entitlements.stopWhenCreditsBelow,
        serverCreditsBalance,
        monthlyServerCreditsUsed,
        serverCreditsPeriodStart,
        serverCreditsRenewAt,
    };
    if (
        !planChanged &&
        !sourceChanged &&
        !resetPeriod
    ) {
        return account;
    }

    return args.tx.billingAccount.update({
        where: { userId: args.userId },
        data,
    });
}

async function getOrCreateDefaultBillingAccountInTransaction(args: {
    tx: BillingTransactionClient;
    userId: string;
    now: Date;
}) {
    return reconcileBillingAccountInTransaction(args);
}

async function createLedgerResult(
    tx: BillingTransactionClient,
    account: BillingAccount,
    type: CreditLedgerEntryType,
    args: BillingCreditWriteArgs
): Promise<BillingCreditWriteResult> {
    const entry = await tx.creditLedgerEntry.create({
        data: {
            userId: args.userId,
            analysisJobId: args.analysisJobId ?? null,
            analysisRunId: args.analysisRunId ?? null,
            gameId: args.gameId ?? null,
            type,
            credits: args.credits,
            idempotencyKey: args.idempotencyKey,
            reason: args.reason ?? null,
            ...(args.metadata ? { metadata: args.metadata } : {}),
        },
    });
    const summary = await getLedgerSummary(tx, args);
    return {
        entry,
        created: true,
        account,
        summary,
        policy: SERVER_ANALYSIS_BILLING_POLICY_V2,
    };
}

async function existingResult(
    tx: BillingTransactionClient,
    entry: CreditLedgerEntry
): Promise<BillingCreditWriteResult> {
    const account = await tx.billingAccount.findUnique({
        where: { userId: entry.userId },
    });
    return {
        entry,
        created: false,
        account,
        summary: null,
        policy: SERVER_ANALYSIS_BILLING_POLICY_V2,
    };
}

async function findIdempotentEntry(
    tx: BillingTransactionClient,
    idempotencyKey: string
) {
    return tx.creditLedgerEntry.findUnique({
        where: { idempotencyKey },
    });
}

async function getLedgerSummary(
    tx: BillingTransactionClient,
    ref: CreditLedgerReference,
    options: { createdAtGte?: Date; autoAnalysisOnly?: boolean } = {}
) {
    const entries = (await tx.creditLedgerEntry.findMany({
        where: {
            ...ledgerWhere(ref),
            ...(options.createdAtGte
                ? { createdAt: { gte: options.createdAtGte } }
                : {}),
            ...(options.autoAnalysisOnly
                ? {
                      OR: [
                          {
                              reason: {
                                  in: AUTO_ANALYSIS_LEDGER_REASONS,
                              },
                          },
                          {
                              analysisRun: {
                                  is: {
                                      queuedReason: {
                                          in: AUTO_ANALYSIS_LEDGER_REASONS,
                                      },
                                  },
                              },
                          },
                      ],
                  }
                : {}),
        },
        select: {
            type: true,
            credits: true,
        },
    })) as LedgerEntryForSummary[];
    return summarizeCreditLedgerEntries(entries);
}

function ledgerWhere(ref: CreditLedgerReference) {
    return {
        userId: ref.userId,
        ...(ref.analysisJobId ? { analysisJobId: ref.analysisJobId } : {}),
        ...(ref.analysisRunId ? { analysisRunId: ref.analysisRunId } : {}),
        ...(ref.gameId ? { gameId: ref.gameId } : {}),
    };
}

function assertBalanceAvailable(
    account: BillingAccount,
    credits: number,
    reserveCredits = 0
) {
    if (account.serverCreditsBalance < credits + reserveCredits) {
        if (reserveCredits > 0 && account.serverCreditsBalance >= credits) {
            throw new ServerCreditStopThresholdError(
                `The ${reserveCredits}-credit auto-analysis reserve has been reached`
            );
        }
        throw new InsufficientServerCreditsError();
    }
}

function assertMonthlyLimitAvailable(
    account: BillingAccount,
    userSummary: CreditLedgerSummary,
    credits: number
) {
    const committedThisMonth =
        account.monthlyServerCreditsUsed + userSummary.outstandingReserved;
    if (committedThisMonth + credits > account.monthlyServerCreditsLimit) {
        throw new MonthlyServerCreditsLimitExceededError();
    }
}

async function assertAutoAnalysisCapsAvailable(args: {
    tx: BillingTransactionClient;
    account: BillingAccount;
    now: Date;
    personalBudget?: ReserveServerAnalysisCreditsArgs['autoAnalysisBudget'];
}) {
    const monthlyCommitted = await countCommittedAutoAnalysisRuns(
        args.tx,
        args.account.userId,
        args.account.serverCreditsPeriodStart
    );
    const monthlyGameLimit = Math.min(
        args.account.autoAnalysisMonthlyGameLimit,
        args.personalBudget?.monthlyGameLimit ??
            args.account.autoAnalysisMonthlyGameLimit
    );
    if (monthlyCommitted + 1 > monthlyGameLimit) {
        throw new AutoAnalysisMonthlyCapExceededError();
    }

    const dailyCommitted = await countCommittedAutoAnalysisRuns(
        args.tx,
        args.account.userId,
        startOfUtcDay(args.now)
    );
    const dailyGameLimit = Math.min(
        args.account.autoAnalysisDailyGameLimit,
        args.personalBudget?.dailyGameLimit ??
            args.account.autoAnalysisDailyGameLimit
    );
    if (dailyCommitted + 1 > dailyGameLimit) {
        throw new AutoAnalysisDailyCapExceededError();
    }
}

async function countCommittedAutoAnalysisRuns(
    tx: BillingTransactionClient,
    userId: string,
    createdAtGte: Date
) {
    const runs = await tx.analysisRun.findMany({
        where: {
            userId,
            createdAt: { gte: createdAtGte },
            queuedReason: { in: AUTO_ANALYSIS_LEDGER_REASONS },
        },
        select: {
            creditLedgerEntries: {
                select: { type: true, credits: true },
            },
        },
    });
    return runs.filter(
        (run) =>
            summarizeCreditLedgerEntries(run.creditLedgerEntries).committed >
            0
    ).length;
}

function nonNegativeInt(value: number) {
    return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
}

function assertPositiveCredits(credits: number) {
    if (!Number.isInteger(credits) || credits <= 0) {
        throw new BillingAccountError('Credits must be a positive integer');
    }
}

function startOfUtcDay(date: Date) {
    return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    );
}

function serializableTransactionOptions() {
    return {
        isolationLevel: PrismaRuntime.TransactionIsolationLevel.Serializable,
    };
}
