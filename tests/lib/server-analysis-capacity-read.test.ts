import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const readEffectiveBillingSnapshotMock = vi.fn();

async function importCapacity() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/billingAccounts', () => ({
        readEffectiveBillingSnapshot: readEffectiveBillingSnapshotMock,
    }));
    return import('@/lib/games/serverAnalysisCapacity');
}

describe('manual server-analysis capacity read', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        readEffectiveBillingSnapshotMock.mockResolvedValue({
            userId: 'user-1',
            plan: 'PRO',
            planSource: 'ADMIN',
            serverCreditsBalance: 5_000,
            monthlyServerCreditsUsed: 0,
            serverCreditsPeriodStart: new Date('2026-08-07T00:00:00Z'),
            monthlyServerCreditsLimit: 5_000,
            stopWhenCreditsBelow: 0,
        });
        prismaMock.creditLedgerEntry.groupBy.mockResolvedValue([]);
        prismaMock.user.findUnique.mockResolvedValue({ preferences: {} });
    });

    it('uses the reconciled entitlement and current reservation period', async () => {
        const capacity = await importCapacity();

        await expect(
            capacity.getManualServerAnalysisCapacity('user-1')
        ).resolves.toMatchObject({
            currentBalance: 5_000,
            monthlyLimit: 5_000,
            reservableCredits: 5_000,
        });
        expect(readEffectiveBillingSnapshotMock).toHaveBeenCalledWith('user-1');
        expect(prismaMock.creditLedgerEntry.groupBy).toHaveBeenCalledWith({
            by: ['type'],
            where: {
                userId: 'user-1',
                scope: 'RESERVATION',
                billingPeriodStart: new Date('2026-08-07T00:00:00Z'),
            },
            _sum: { credits: true },
        });
    });

    it('uses a caller-owned immutable snapshot without rereading billing', async () => {
        const capacity = await importCapacity();
        const billingSnapshot = Object.freeze({
            userId: 'user-1',
            plan: 'PLUS' as const,
            planSource: 'STRIPE' as const,
            stripePlan: 'PLUS' as const,
            stripeCustomerId: 'cus_test',
            stripeSubscriptionStatus: 'active',
            stripeCurrentPeriodStart: new Date('2026-08-01T00:00:00Z'),
            stripeCurrentPeriodEnd: new Date('2026-09-01T00:00:00Z'),
            serverCreditsBalance: 900,
            monthlyServerCreditsUsed: 100,
            serverCreditsPeriodStart: new Date('2026-08-01T00:00:00Z'),
            serverCreditsRenewAt: new Date('2026-09-01T00:00:00Z'),
            monthlyServerCreditsLimit: 1_000,
            autoAnalysisMonthlyGameLimit: 500,
            autoAnalysisDailyGameLimit: 50,
            stopWhenCreditsBelow: 0,
            persisted: true,
            needsReconciliation: false,
        });

        await expect(
            capacity.getManualServerAnalysisCapacity('user-1', {
                billingSnapshot,
            })
        ).resolves.toMatchObject({
            currentBalance: 900,
            monthlyLimit: 1_000,
        });
        expect(readEffectiveBillingSnapshotMock).not.toHaveBeenCalled();
    });
});
