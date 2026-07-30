import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type BillingAccountsModule = typeof import('@/lib/services/billingAccounts');
const requestAutoAnalysisWakeupMock = vi.fn();

async function importBilling(): Promise<BillingAccountsModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        requestAutoAnalysisWakeup: requestAutoAnalysisWakeupMock,
    }));
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/billingAccounts');
}

function account(overrides: Record<string, unknown> = {}) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE',
        serverCreditsBalance: 10,
        monthlyServerCreditsUsed: 0,
        serverCreditsRenewAt: new Date('2026-08-05T00:00:00Z'),
        monthlyServerCreditsLimit: 10,
        autoAnalysisMonthlyCap: 5,
        autoAnalysisDailyCap: 2,
        stopWhenCreditsBelow: 0,
        createdAt: new Date('2026-07-05T00:00:00Z'),
        updatedAt: new Date('2026-07-05T00:00:00Z'),
        ...overrides,
    };
}

function ledgerEntry(overrides: Record<string, unknown> = {}) {
    return {
        id: 'entry-1',
        userId: 'user-1',
        analysisJobId: 'job-1',
        analysisRunId: null,
        gameId: 'game-1',
        type: 'RESERVED',
        credits: 1,
        idempotencyKey: 'reserve:job-1',
        reason: null,
        metadata: {},
        createdAt: new Date('2026-07-05T00:00:00Z'),
        ...overrides,
    };
}

describe('billing account server credit policy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        requestAutoAnalysisWakeupMock.mockResolvedValue({
            queued: true,
            inline: false,
        });
    });

    it('reserves credits by debiting the billing account and appending a ledger entry', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(account());
        prismaMock.creditLedgerEntry.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 2 }]);
        prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.billingAccount.findUniqueOrThrow.mockResolvedValue(
            account({ serverCreditsBalance: 8 })
        );
        prismaMock.creditLedgerEntry.create.mockResolvedValue(
            ledgerEntry({ credits: 2 })
        );

        const result = await billing.reserveServerAnalysisCredits({
            userId: 'user-1',
            analysisJobId: 'job-1',
            gameId: 'game-1',
            credits: 2,
            idempotencyKey: 'reserve:job-1',
        });

        expect(result.created).toBe(true);
        expect(result.account?.serverCreditsBalance).toBe(8);
        expect(result.summary?.outstandingReserved).toBe(2);
        expect(prismaMock.billingAccount.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                serverCreditsBalance: { gte: 2 },
            },
            data: {
                serverCreditsBalance: { decrement: 2 },
            },
        });
        expect(prismaMock.creditLedgerEntry.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'RESERVED',
                credits: 2,
                idempotencyKey: 'reserve:job-1',
            }),
        });
    });

    it('rejects reservation when the billing account balance is insufficient', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(
            account({ serverCreditsBalance: 0 })
        );
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);

        await expect(
            billing.reserveServerAnalysisCredits({
                userId: 'user-1',
                credits: 1,
                idempotencyKey: 'reserve:job-1',
            })
        ).rejects.toThrow(billing.InsufficientServerCreditsError);
        expect(prismaMock.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.creditLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('rejects reservation beyond the monthly account cap', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(
            account({
                monthlyServerCreditsUsed: 10,
                monthlyServerCreditsLimit: 10,
            })
        );
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);

        await expect(
            billing.reserveServerAnalysisCredits({
                userId: 'user-1',
                credits: 1,
                idempotencyKey: 'reserve:job-2',
            })
        ).rejects.toThrow(billing.MonthlyServerCreditsLimitExceededError);
        expect(prismaMock.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(prismaMock.creditLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('enforces the lower personal auto-analysis budget and plan cap', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(account());
        prismaMock.creditLedgerEntry.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { type: 'RESERVED', credits: 1 },
            ]);

        await expect(
            billing.reserveServerAnalysisCredits({
                userId: 'user-1',
                credits: 1,
                idempotencyKey: 'reserve:auto:2',
                reason: 'auto-analysis',
                enforceAutoAnalysisCaps: true,
                autoAnalysisBudget: {
                    dailyCap: 10,
                    monthlyCap: 1,
                    reserveCredits: 0,
                },
                now: new Date('2026-07-05T12:00:00Z'),
            })
        ).rejects.toThrow(billing.AutoAnalysisCapExceededError);
        expect(prismaMock.billingAccount.updateMany).not.toHaveBeenCalled();
        expect(
            prismaMock.creditLedgerEntry.findMany.mock.calls[1]?.[0]
        ).toEqual(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({
                            analysisRun: {
                                is: {
                                    queuedReason: {
                                        in: ['auto-sync', 'auto-analysis'],
                                    },
                                },
                            },
                        }),
                    ]),
                }),
            })
        );
    });

    it('atomically preserves the personal reserve floor for auto jobs', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(
            account({ serverCreditsBalance: 3 })
        );
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);

        await expect(
            billing.reserveServerAnalysisCredits({
                userId: 'user-1',
                credits: 1,
                idempotencyKey: 'reserve:auto:floor',
                reason: 'auto-analysis',
                enforceAutoAnalysisCaps: true,
                autoAnalysisBudget: {
                    dailyCap: 10,
                    monthlyCap: 10,
                    reserveCredits: 3,
                },
            })
        ).rejects.toThrow(billing.ServerCreditStopThresholdError);
        expect(prismaMock.billingAccount.updateMany).not.toHaveBeenCalled();
    });

    it('includes the reserve floor in the atomic debit predicate', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(account());
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([]);
        prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.billingAccount.findUniqueOrThrow.mockResolvedValue(
            account({ serverCreditsBalance: 9 })
        );
        prismaMock.creditLedgerEntry.create.mockResolvedValue(
            ledgerEntry({ reason: 'auto-analysis' })
        );

        await billing.reserveServerAnalysisCredits({
            userId: 'user-1',
            credits: 1,
            idempotencyKey: 'reserve:auto:predicate',
            reason: 'auto-analysis',
            enforceAutoAnalysisCaps: true,
            autoAnalysisBudget: {
                dailyCap: 10,
                monthlyCap: 10,
                reserveCredits: 4,
            },
        });

        expect(prismaMock.billingAccount.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 'user-1',
                serverCreditsBalance: { gte: 5 },
            },
            data: {
                serverCreditsBalance: { decrement: 1 },
            },
        });
    });

    it('releases a reservation by restoring credits to the billing account', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(
            account({ serverCreditsBalance: 9 })
        );
        prismaMock.creditLedgerEntry.findMany
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 1 }])
            .mockResolvedValueOnce([
                { type: 'RESERVED', credits: 1 },
                { type: 'RELEASED', credits: 1 },
            ]);
        prismaMock.billingAccount.update.mockResolvedValue(
            account({ serverCreditsBalance: 10 })
        );
        prismaMock.creditLedgerEntry.create.mockResolvedValue(
            ledgerEntry({
                type: 'RELEASED',
                idempotencyKey: 'release:job-1',
            })
        );

        const result = await billing.releaseServerAnalysisCredits({
            userId: 'user-1',
            analysisJobId: 'job-1',
            gameId: 'game-1',
            credits: 1,
            idempotencyKey: 'release:job-1',
        });

        expect(result.account?.serverCreditsBalance).toBe(10);
        expect(result.summary?.outstandingReserved).toBe(0);
        expect(prismaMock.billingAccount.update).toHaveBeenCalledWith({
            where: { userId: 'user-1' },
            data: {
                serverCreditsBalance: { increment: 1 },
            },
        });
        expect(requestAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'capacity-release'
        );
    });

    it('refunds consumed credits back to balance and monthly usage', async () => {
        const billing = await importBilling();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue(
            account({ serverCreditsBalance: 9, monthlyServerCreditsUsed: 1 })
        );
        prismaMock.creditLedgerEntry.findMany
            .mockResolvedValueOnce([{ type: 'CONSUMED', credits: 1 }])
            .mockResolvedValueOnce([
                { type: 'CONSUMED', credits: 1 },
                { type: 'REFUNDED', credits: 1 },
            ]);
        prismaMock.billingAccount.update.mockResolvedValue(
            account({ serverCreditsBalance: 10, monthlyServerCreditsUsed: 0 })
        );
        prismaMock.creditLedgerEntry.create.mockResolvedValue(
            ledgerEntry({
                type: 'REFUNDED',
                idempotencyKey: 'refund:job-1',
            })
        );

        const result = await billing.refundServerAnalysisCredits({
            userId: 'user-1',
            analysisJobId: 'job-1',
            gameId: 'game-1',
            credits: 1,
            idempotencyKey: 'refund:job-1',
        });

        expect(result.account?.monthlyServerCreditsUsed).toBe(0);
        expect(result.summary?.netConsumed).toBe(0);
        expect(prismaMock.billingAccount.update).toHaveBeenCalledWith({
            where: { userId: 'user-1' },
            data: {
                serverCreditsBalance: { increment: 1 },
                monthlyServerCreditsUsed: { decrement: 1 },
            },
        });
    });
});
