import type {
    BillingAccount,
    CreditLedgerEntry,
    CreditLedgerEntryType,
    Prisma,
} from '@prisma/client';
import { Prisma as PrismaRuntime } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    CreditLedgerError,
    InsufficientConsumedCreditsError,
    InsufficientReservedCreditsError,
    summarizeCreditLedgerEntries,
    type CreditLedgerSummary,
} from '@/lib/services/creditLedger';

export const SERVER_ANALYSIS_BILLING_POLICY_V1 =
    'server-analysis-billing-account-v1';

export const DEFAULT_SERVER_CREDITS_BALANCE = 100;
export const DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT = 100;
export const DEFAULT_AUTO_ANALYSIS_MONTHLY_CAP = 50;
export const DEFAULT_AUTO_ANALYSIS_DAILY_CAP = 10;
export const DEFAULT_STOP_WHEN_CREDITS_BELOW = 0;
const AUTO_ANALYSIS_LEDGER_REASONS = ['auto-sync', 'auto-analysis'];

export type BillingTransactionClient = Pick<
    Prisma.TransactionClient,
    'billingAccount' | 'creditLedgerEntry'
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
        dailyCap: number | null;
        monthlyCap: number | null;
        reserveCredits: number;
    };
    now?: Date;
};

export type BillingCreditWriteResult = {
    entry: CreditLedgerEntry;
    created: boolean;
    account: BillingAccount | null;
    summary: CreditLedgerSummary | null;
    policy: typeof SERVER_ANALYSIS_BILLING_POLICY_V1;
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
    constructor(message = 'Auto analysis server credit cap exceeded') {
        super(message);
        this.name = 'AutoAnalysisCapExceededError';
    }
}

export class AutoAnalysisMonthlyCapExceededError extends AutoAnalysisCapExceededError {
    constructor(message = 'Auto analysis monthly server credit cap exceeded') {
        super(message);
        this.name = 'AutoAnalysisMonthlyCapExceededError';
    }
}

export class AutoAnalysisDailyCapExceededError extends AutoAnalysisCapExceededError {
    constructor(message = 'Auto analysis daily server credit cap exceeded') {
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
              nonNegativeInt(writeArgs.autoAnalysisBudget.reserveCredits)
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
            credits: writeArgs.credits,
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
    if (type === 'RELEASED' && result.created) {
        try {
            const { requestAutoAnalysisWakeup } = await import(
                '@/lib/services/autoAnalysisBacklog'
            );
            await requestAutoAnalysisWakeup(
                args.userId,
                'capacity-release'
            );
        } catch (error) {
            // Credit settlement is already committed. A wakeup failure must
            // never make the caller retry or double-release the reservation.
            console.error(
                '[auto analysis] capacity-release wakeup failed',
                error
            );
        }
    }
    return result;
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

async function getOrCreateDefaultBillingAccountInTransaction(args: {
    tx: BillingTransactionClient;
    userId: string;
    now: Date;
}) {
    const account = await args.tx.billingAccount.upsert({
        where: { userId: args.userId },
        update: {},
        create: {
            userId: args.userId,
            plan: 'FREE',
            serverCreditsBalance: DEFAULT_SERVER_CREDITS_BALANCE,
            monthlyServerCreditsUsed: 0,
            serverCreditsRenewAt: nextMonthlyRenewAt(args.now),
            monthlyServerCreditsLimit: DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
            autoAnalysisMonthlyCap: DEFAULT_AUTO_ANALYSIS_MONTHLY_CAP,
            autoAnalysisDailyCap: DEFAULT_AUTO_ANALYSIS_DAILY_CAP,
            stopWhenCreditsBelow: DEFAULT_STOP_WHEN_CREDITS_BELOW,
        },
    });

    if (account.serverCreditsRenewAt > args.now) return account;

    return args.tx.billingAccount.update({
        where: { userId: args.userId },
        data: {
            serverCreditsBalance: Math.max(
                account.serverCreditsBalance,
                account.monthlyServerCreditsLimit
            ),
            monthlyServerCreditsUsed: 0,
            serverCreditsRenewAt: nextMonthlyRenewAt(args.now),
        },
    });
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
        policy: SERVER_ANALYSIS_BILLING_POLICY_V1,
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
        policy: SERVER_ANALYSIS_BILLING_POLICY_V1,
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
    credits: number;
    now: Date;
    personalBudget?: ReserveServerAnalysisCreditsArgs['autoAnalysisBudget'];
}) {
    const monthlyCommitted = await getLedgerSummary(
        args.tx,
        { userId: args.account.userId },
        {
            createdAtGte: previousMonthlyRenewAt(
                args.account.serverCreditsRenewAt
            ),
            autoAnalysisOnly: true,
        }
    );
    const monthlyCap = Math.min(
        args.account.autoAnalysisMonthlyCap,
        args.personalBudget?.monthlyCap ??
            args.account.autoAnalysisMonthlyCap
    );
    if (monthlyCommitted.committed + args.credits > monthlyCap) {
        throw new AutoAnalysisMonthlyCapExceededError();
    }

    const dailyCommitted = await getLedgerSummary(
        args.tx,
        { userId: args.account.userId },
        {
            createdAtGte: startOfUtcDay(args.now),
            autoAnalysisOnly: true,
        }
    );
    const dailyCap = Math.min(
        args.account.autoAnalysisDailyCap,
        args.personalBudget?.dailyCap ?? args.account.autoAnalysisDailyCap
    );
    if (dailyCommitted.committed + args.credits > dailyCap) {
        throw new AutoAnalysisDailyCapExceededError();
    }
}

function nonNegativeInt(value: number) {
    return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
}

function assertPositiveCredits(credits: number) {
    if (!Number.isInteger(credits) || credits <= 0) {
        throw new BillingAccountError('Credits must be a positive integer');
    }
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

function serializableTransactionOptions() {
    return {
        isolationLevel: PrismaRuntime.TransactionIsolationLevel.Serializable,
    };
}
