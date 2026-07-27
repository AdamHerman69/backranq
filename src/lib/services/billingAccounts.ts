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

    assertBalanceAvailable(account, writeArgs.credits);
    assertMonthlyLimitAvailable(account, userSummary, writeArgs.credits);
    if (writeArgs.enforceStopThreshold) {
        assertStopThresholdAvailable(account, writeArgs.credits);
    }
    if (writeArgs.enforceAutoAnalysisCaps) {
        await assertAutoAnalysisCapsAvailable({
            tx,
            account,
            credits: writeArgs.credits,
            now,
        });
    }

    const debited = await tx.billingAccount.updateMany({
        where: {
            userId: writeArgs.userId,
            serverCreditsBalance: { gte: writeArgs.credits },
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
        if (scopedSummary.outstandingReserved < args.credits) {
            throw new InsufficientReservedCreditsError();
        }
        if (
            account.monthlyServerCreditsUsed + args.credits >
            account.monthlyServerCreditsLimit
        ) {
            throw new MonthlyServerCreditsLimitExceededError();
        }

        const updated = await tx.billingAccount.update({
            where: { userId: args.userId },
            data: {
                monthlyServerCreditsUsed: { increment: args.credits },
            },
        });
        return createLedgerResult(tx, updated, 'CONSUMED', args);
    }, serializableTransactionOptions());
}

export async function releaseServerAnalysisCredits(
    args: BillingCreditWriteArgs
): Promise<BillingCreditWriteResult> {
    return writeReservedCreditReturn(args, 'RELEASED');
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
        if (scopedSummary.outstandingReserved < args.credits) {
            throw new InsufficientReservedCreditsError();
        }

        const updated = await tx.billingAccount.update({
            where: { userId: args.userId },
            data: {
                serverCreditsBalance:
                    type === 'RELEASED'
                        ? { increment: args.credits }
                        : undefined,
            },
        });
        void account;
        return createLedgerResult(tx, updated, type, args);
    }, serializableTransactionOptions());
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
    options: { createdAtGte?: Date } = {}
) {
    const entries = (await tx.creditLedgerEntry.findMany({
        where: {
            ...ledgerWhere(ref),
            ...(options.createdAtGte
                ? { createdAt: { gte: options.createdAtGte } }
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

function assertBalanceAvailable(account: BillingAccount, credits: number) {
    if (account.serverCreditsBalance < credits) {
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

function assertStopThresholdAvailable(
    account: BillingAccount,
    credits: number
) {
    if (
        account.stopWhenCreditsBelow > 0 &&
        account.serverCreditsBalance - credits < account.stopWhenCreditsBelow
    ) {
        throw new ServerCreditStopThresholdError();
    }
}

async function assertAutoAnalysisCapsAvailable(args: {
    tx: BillingTransactionClient;
    account: BillingAccount;
    credits: number;
    now: Date;
}) {
    const monthlyCommitted = await getLedgerSummary(
        args.tx,
        { userId: args.account.userId },
        { createdAtGte: previousMonthlyRenewAt(args.account.serverCreditsRenewAt) }
    );
    if (
        monthlyCommitted.committed + args.credits >
        args.account.autoAnalysisMonthlyCap
    ) {
        throw new AutoAnalysisCapExceededError();
    }

    const dailyCommitted = await getLedgerSummary(
        args.tx,
        { userId: args.account.userId },
        { createdAtGte: startOfUtcDay(args.now) }
    );
    if (
        dailyCommitted.committed + args.credits >
        args.account.autoAnalysisDailyCap
    ) {
        throw new AutoAnalysisCapExceededError();
    }
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
