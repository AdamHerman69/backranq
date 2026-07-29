import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

async function importDeletion() {
    vi.resetModules();
    mockPrismaModule();
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/gameDeletion');
}

function account(overrides: Record<string, unknown> = {}) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE',
        serverCreditsBalance: 9,
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

function job(overrides: Record<string, unknown> = {}) {
    return {
        id: 'job-1',
        status: 'RUNNING',
        analysisRunId: 'run-1',
        lastError: null,
        creditLedgerEntries: [{ type: 'RESERVED', credits: 1 }],
        ...overrides,
    };
}

function configureSettlement(action: 'consume' | 'release') {
    prismaMock.analyzedGame.findFirst.mockResolvedValue({ id: 'game-1' });
    prismaMock.analysisJob.findMany.mockResolvedValue([job()]);
    prismaMock.analysisJob.update.mockResolvedValue({ id: 'job-1' });
    prismaMock.analysisRun.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
    prismaMock.billingAccount.upsert.mockResolvedValue(account());
    prismaMock.creditLedgerEntry.findMany
        .mockResolvedValueOnce([{ type: 'RESERVED', credits: 1 }])
        .mockResolvedValueOnce([
            { type: 'RESERVED', credits: 1 },
            {
                type: action === 'consume' ? 'CONSUMED' : 'RELEASED',
                credits: 1,
            },
        ]);
    prismaMock.billingAccount.update.mockResolvedValue(
        account(
            action === 'consume'
                ? { monthlyServerCreditsUsed: 1 }
                : { serverCreditsBalance: 10 }
        )
    );
    prismaMock.creditLedgerEntry.create.mockResolvedValue({
        id: 'ledger-settlement',
        userId: 'user-1',
        analysisJobId: 'job-1',
        analysisRunId: 'run-1',
        gameId: 'game-1',
        type: action === 'consume' ? 'CONSUMED' : 'RELEASED',
        credits: 1,
        idempotencyKey: `analysis-run:run-1:${action}`,
        reason: 'game-deleted',
        metadata: {},
        createdAt: new Date(),
    });
    prismaMock.analyzedGame.deleteMany.mockResolvedValue({ count: 1 });
}

describe('safe game deletion', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('cancels an active job, releases its reservation, then deletes', async () => {
        const deletion = await importDeletion();
        configureSettlement('release');

        const result = await deletion.deleteOwnedGameSafely({
            userId: 'user-1',
            gameId: 'game-1',
        });

        expect(result).toEqual({
            cancelledJobs: 1,
            consumedReservations: 0,
            releasedReservations: 1,
        });
        expect(prismaMock.creditLedgerEntry.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'RELEASED',
                idempotencyKey: 'analysis-run:run-1:release',
            }),
        });
        expect(prismaMock.analyzedGame.deleteMany).toHaveBeenCalled();
        expect(
            prismaMock.analysisJob.update.mock.invocationCallOrder[0]
        ).toBeLessThan(
            prismaMock.analyzedGame.deleteMany.mock.invocationCallOrder[0]!
        );
    });

    it('consumes a successful pending reservation before deletion', async () => {
        const deletion = await importDeletion();
        configureSettlement('consume');
        prismaMock.analysisJob.findMany.mockResolvedValue([
            job({
                status: 'SUCCEEDED',
                lastError:
                    'CREDIT_SETTLEMENT_PENDING:consume:completion-committed',
            }),
        ]);

        const result = await deletion.deleteOwnedGameSafely({
            userId: 'user-1',
            gameId: 'game-1',
        });

        expect(result).toEqual({
            cancelledJobs: 0,
            consumedReservations: 1,
            releasedReservations: 0,
        });
        expect(prismaMock.analysisJob.update).not.toHaveBeenCalled();
        expect(prismaMock.creditLedgerEntry.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'CONSUMED',
                idempotencyKey: 'analysis-run:run-1:consume',
            }),
        });
    });

    it('does not reach deletion when credit settlement fails', async () => {
        const deletion = await importDeletion();
        configureSettlement('release');
        prismaMock.billingAccount.update.mockRejectedValue(
            new Error('billing unavailable')
        );

        await expect(
            deletion.deleteOwnedGameSafely({
                userId: 'user-1',
                gameId: 'game-1',
            })
        ).rejects.toThrow(deletion.GameDeletionSettlementError);

        expect(prismaMock.analyzedGame.deleteMany).not.toHaveBeenCalled();
    });
});
