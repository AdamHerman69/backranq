import { prisma } from '@/lib/prisma';
import {
    DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
    DEFAULT_SERVER_CREDITS_BALANCE,
    DEFAULT_STOP_WHEN_CREDITS_BELOW,
} from '@/lib/services/billingAccounts';
import { summarizeCreditLedgerEntries } from '@/lib/services/creditLedger';

export type ManualServerAnalysisCapacity = {
    currentBalance: number;
    stopThreshold: number;
    spendableBalance: number;
    monthlyLimit: number;
    monthlyUsed: number;
    outstandingReservations: number;
    monthlyRemaining: number;
    reservableCredits: number;
    limitingFactor:
        | 'balance'
        | 'stop-threshold'
        | 'monthly-limit'
        | 'balance-and-monthly-limit';
    limitingReason: string;
};

export function calculateManualServerAnalysisCapacity(args: {
    currentBalance: number;
    stopThreshold: number;
    monthlyLimit: number;
    monthlyUsed: number;
    outstandingReservations: number;
}): ManualServerAnalysisCapacity {
    const currentBalance = nonNegativeInt(args.currentBalance);
    const stopThreshold = nonNegativeInt(args.stopThreshold);
    const monthlyLimit = nonNegativeInt(args.monthlyLimit);
    const monthlyUsed = nonNegativeInt(args.monthlyUsed);
    const outstandingReservations = nonNegativeInt(
        args.outstandingReservations
    );
    const spendableBalance = Math.max(0, currentBalance - stopThreshold);
    const monthlyRemaining = Math.max(
        0,
        monthlyLimit - monthlyUsed - outstandingReservations
    );
    const reservableCredits = Math.min(spendableBalance, monthlyRemaining);

    const limitingFactor = getLimitingFactor({
        currentBalance,
        stopThreshold,
        spendableBalance,
        monthlyRemaining,
    });

    return {
        currentBalance,
        stopThreshold,
        spendableBalance,
        monthlyLimit,
        monthlyUsed,
        outstandingReservations,
        monthlyRemaining,
        reservableCredits,
        limitingFactor,
        limitingReason: capacityReason(limitingFactor, stopThreshold),
    };
}

export async function getManualServerAnalysisCapacity(
    userId: string
): Promise<ManualServerAnalysisCapacity> {
    const [account, creditTotals] = await Promise.all([
        prisma.billingAccount.findUnique({ where: { userId } }),
        prisma.creditLedgerEntry.groupBy({
            by: ['type'],
            where: { userId },
            _sum: { credits: true },
        }),
    ]);
    const ledger = summarizeCreditLedgerEntries(
        creditTotals.map((row) => ({
            type: row.type,
            credits: row._sum.credits ?? 0,
        }))
    );
    const renewalDue =
        account !== null && account.serverCreditsRenewAt <= new Date();
    const monthlyLimit =
        account?.monthlyServerCreditsLimit ??
        DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT;
    const currentBalance =
        account === null
            ? DEFAULT_SERVER_CREDITS_BALANCE
            : renewalDue
              ? Math.max(account.serverCreditsBalance, monthlyLimit)
              : account.serverCreditsBalance;

    return calculateManualServerAnalysisCapacity({
        currentBalance,
        stopThreshold:
            account?.stopWhenCreditsBelow ?? DEFAULT_STOP_WHEN_CREDITS_BELOW,
        monthlyLimit,
        monthlyUsed: renewalDue ? 0 : (account?.monthlyServerCreditsUsed ?? 0),
        outstandingReservations: ledger.outstandingReserved,
    });
}

function nonNegativeInt(value: number) {
    return Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));
}

function getLimitingFactor(args: {
    currentBalance: number;
    stopThreshold: number;
    spendableBalance: number;
    monthlyRemaining: number;
}): ManualServerAnalysisCapacity['limitingFactor'] {
    if (
        args.spendableBalance === 0 &&
        args.stopThreshold > 0 &&
        args.currentBalance > 0
    ) {
        return 'stop-threshold';
    }
    if (args.spendableBalance < args.monthlyRemaining) return 'balance';
    if (args.monthlyRemaining < args.spendableBalance) return 'monthly-limit';
    return 'balance-and-monthly-limit';
}

function capacityReason(
    factor: ManualServerAnalysisCapacity['limitingFactor'],
    stopThreshold: number
) {
    if (factor === 'balance') {
        return 'The current credit balance is the limiting factor.';
    }
    if (factor === 'stop-threshold') {
        return `The ${stopThreshold}-credit safety threshold protects the remaining balance.`;
    }
    if (factor === 'monthly-limit') {
        return 'The monthly limit, including outstanding reservations, is the limiting factor.';
    }
    return 'The current balance and remaining monthly capacity are equally limiting.';
}
