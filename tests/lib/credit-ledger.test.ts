import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    mockPrismaModule,
    prismaMock,
} from '../helpers/route-mocks';

type CreditLedgerModule = typeof import('@/lib/services/creditLedger');

async function importLedger(): Promise<CreditLedgerModule> {
    vi.resetModules();
    mockPrismaModule();
    prismaMock.$transaction.mockImplementation(
        async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                prismaMock
            )
    );
    return import('@/lib/services/creditLedger');
}

describe('server analysis credit ledger service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reserves credits with an idempotency key under the v1 soft-limit policy', async () => {
        const ledger = await importLedger();
        const entry = {
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
            createdAt: new Date(),
        };
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.creditLedgerEntry.findMany
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ type: 'RESERVED', credits: 1 }]);
        prismaMock.creditLedgerEntry.create.mockResolvedValue(entry);

        const result = await ledger.reserveServerAnalysisCredits({
            userId: 'user-1',
            analysisJobId: 'job-1',
            gameId: 'game-1',
            credits: 1,
            softLimitCredits: 5,
            idempotencyKey: 'reserve:job-1',
        });

        expect(result.created).toBe(true);
        expect(result.summary?.outstandingReserved).toBe(1);
        expect(result.policy).toBe(
            ledger.SERVER_ANALYSIS_CREDIT_LEDGER_POLICY_V1
        );
        expect(prismaMock.creditLedgerEntry.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                type: 'RESERVED',
                credits: 1,
                idempotencyKey: 'reserve:job-1',
            }),
        });
    });

    it('returns an existing idempotent ledger entry without writing another entry', async () => {
        const ledger = await importLedger();
        const existing = {
            id: 'entry-1',
            userId: 'user-1',
            analysisJobId: 'job-1',
            analysisRunId: null,
            gameId: null,
            type: 'RESERVED',
            credits: 1,
            idempotencyKey: 'reserve:job-1',
            reason: null,
            metadata: {},
            createdAt: new Date(),
        };
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(existing);

        const result = await ledger.reserveServerAnalysisCredits({
            userId: 'user-1',
            analysisJobId: 'job-1',
            credits: 1,
            idempotencyKey: 'reserve:job-1',
        });

        expect(result).toMatchObject({ entry: existing, created: false });
        expect(prismaMock.creditLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('does not consume more than the outstanding reserved credits', async () => {
        const ledger = await importLedger();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([
            { type: 'RESERVED', credits: 1 },
        ]);

        await expect(
            ledger.consumeServerAnalysisCredits({
                userId: 'user-1',
                analysisJobId: 'job-1',
                credits: 2,
                idempotencyKey: 'consume:job-1',
            })
        ).rejects.toThrow(ledger.InsufficientReservedCreditsError);
        expect(prismaMock.creditLedgerEntry.create).not.toHaveBeenCalled();
    });

    it('does not reserve past an explicit soft limit', async () => {
        const ledger = await importLedger();
        prismaMock.creditLedgerEntry.findUnique.mockResolvedValue(null);
        prismaMock.creditLedgerEntry.findMany.mockResolvedValue([
            { type: 'RESERVED', credits: 2 },
        ]);

        await expect(
            ledger.reserveServerAnalysisCredits({
                userId: 'user-1',
                credits: 1,
                softLimitCredits: 2,
                idempotencyKey: 'reserve:job-2',
            })
        ).rejects.toThrow(ledger.CreditLimitExceededError);
        expect(prismaMock.creditLedgerEntry.create).not.toHaveBeenCalled();
    });
});
