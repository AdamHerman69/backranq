import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const getEffectiveBillingAccountMock = vi.fn();

async function importCapacity() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/billingAccounts', () => ({
        getEffectiveBillingAccount: getEffectiveBillingAccountMock,
    }));
    return import('@/lib/games/serverAnalysisCapacity');
}

describe('manual server-analysis capacity read', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getEffectiveBillingAccountMock.mockResolvedValue({
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
        expect(getEffectiveBillingAccountMock).toHaveBeenCalledWith('user-1');
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
});
