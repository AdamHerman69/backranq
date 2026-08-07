import { prisma } from '@/lib/prisma';
import { getEffectiveBillingAccount } from '@/lib/services/billingAccounts';
import { summarizeCreditLedgerEntries } from '@/lib/services/creditLedger';
import {
    DEFAULT_ANALYSIS_QUALITY,
    analysisCreditsPerGame,
    type AnalysisQuality,
} from '@/lib/analysis/quality';
import { canonicalPreferences } from '@/lib/preferences';

export type ManualServerAnalysisCapacity = {
    currentBalance: number;
    stopThreshold: number;
    spendableBalance: number;
    monthlyLimit: number;
    monthlyUsed: number;
    outstandingReservations: number;
    monthlyRemaining: number;
    reservableCredits: number;
    analysisQuality: AnalysisQuality;
    creditsPerGame: number;
    reservableGames: number;
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
    analysisQuality?: AnalysisQuality;
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
    const analysisQuality = args.analysisQuality ?? DEFAULT_ANALYSIS_QUALITY;
    const creditsPerGame = analysisCreditsPerGame(analysisQuality);

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
        analysisQuality,
        creditsPerGame,
        reservableGames: Math.floor(reservableCredits / creditsPerGame),
        limitingFactor,
        limitingReason: capacityReason(limitingFactor, stopThreshold),
    };
}

export async function getManualServerAnalysisCapacity(
    userId: string
): Promise<ManualServerAnalysisCapacity> {
    const account = await getEffectiveBillingAccount(userId);
    const [creditTotals, user] = await Promise.all([
        prisma.creditLedgerEntry.groupBy({
            by: ['type'],
            where: {
                userId,
                scope: 'RESERVATION',
                billingPeriodStart: account.serverCreditsPeriodStart,
            },
            _sum: { credits: true },
        }),
        prisma.user.findUnique({
            where: { id: userId },
            select: { preferences: true },
        }),
    ]);
    const ledger = summarizeCreditLedgerEntries(
        creditTotals.map((row) => ({
            type: row.type,
            credits: row._sum.credits ?? 0,
        }))
    );
    return calculateManualServerAnalysisCapacity({
        currentBalance: account.serverCreditsBalance,
        stopThreshold: account.stopWhenCreditsBelow,
        monthlyLimit: account.monthlyServerCreditsLimit,
        monthlyUsed: account.monthlyServerCreditsUsed,
        outstandingReservations: ledger.outstandingReserved,
        analysisQuality: canonicalPreferences(user?.preferences).analysisQuality,
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
