import type {
    CreditLedgerEntry,
    CreditLedgerEntryType,
    Prisma,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';

export const SERVER_ANALYSIS_CREDIT_LEDGER_POLICY_V1 =
    'server-analysis-soft-limit-v1-no-balance-row';

type CreditLedgerTransactionClient = Pick<
    Prisma.TransactionClient,
    'creditLedgerEntry'
>;

type CreditLedgerReference = {
    userId: string;
    analysisJobId?: string | null;
    analysisRunId?: string | null;
    gameId?: string | null;
};

type CreditLedgerWriteArgs = CreditLedgerReference & {
    credits: number;
    idempotencyKey: string;
    reason?: string | null;
    metadata?: Prisma.InputJsonObject;
};

type ReserveServerAnalysisCreditsArgs = CreditLedgerWriteArgs & {
    softLimitCredits?: number | null;
};

export type CreditLedgerSummary = {
    reserved: number;
    consumed: number;
    refunded: number;
    released: number;
    expired: number;
    outstandingReserved: number;
    netConsumed: number;
    committed: number;
};

export type CreditLedgerWriteResult = {
    entry: CreditLedgerEntry;
    created: boolean;
    summary: CreditLedgerSummary | null;
    policy: typeof SERVER_ANALYSIS_CREDIT_LEDGER_POLICY_V1;
};

type LedgerEntryForSummary = Pick<CreditLedgerEntry, 'type' | 'credits'>;

export class CreditLedgerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CreditLedgerError';
    }
}

export class CreditLimitExceededError extends CreditLedgerError {
    constructor(message = 'Insufficient server analysis credits') {
        super(message);
        this.name = 'CreditLimitExceededError';
    }
}

export class InsufficientReservedCreditsError extends CreditLedgerError {
    constructor(message = 'Insufficient reserved server analysis credits') {
        super(message);
        this.name = 'InsufficientReservedCreditsError';
    }
}

export class InsufficientConsumedCreditsError extends CreditLedgerError {
    constructor(message = 'Insufficient consumed server analysis credits') {
        super(message);
        this.name = 'InsufficientConsumedCreditsError';
    }
}

export async function reserveServerAnalysisCredits(
    args: ReserveServerAnalysisCreditsArgs
) {
    return prisma.$transaction(async (tx) => {
        const existing = await findIdempotentEntry(tx, args.idempotencyKey);
        if (existing) return existingResult(existing);

        assertPositiveCredits(args.credits);

        if (args.softLimitCredits != null) {
            const userSummary = await getLedgerSummary(tx, {
                userId: args.userId,
            });
            if (userSummary.committed + args.credits > args.softLimitCredits) {
                throw new CreditLimitExceededError();
            }
        }

        return createLedgerEntry(tx, 'RESERVED', args);
    });
}

export async function consumeServerAnalysisCredits(
    args: CreditLedgerWriteArgs
) {
    return writeScopedDebit(
        args,
        'CONSUMED',
        (summary) => summary.outstandingReserved,
        () => new InsufficientReservedCreditsError()
    );
}

export async function releaseServerAnalysisCredits(
    args: CreditLedgerWriteArgs
) {
    return writeScopedDebit(
        args,
        'RELEASED',
        (summary) => summary.outstandingReserved,
        () => new InsufficientReservedCreditsError()
    );
}

export async function expireServerAnalysisCredits(args: CreditLedgerWriteArgs) {
    return writeScopedDebit(
        args,
        'EXPIRED',
        (summary) => summary.outstandingReserved,
        () => new InsufficientReservedCreditsError()
    );
}

export async function refundServerAnalysisCredits(args: CreditLedgerWriteArgs) {
    return writeScopedDebit(
        args,
        'REFUNDED',
        (summary) => summary.netConsumed,
        () => new InsufficientConsumedCreditsError()
    );
}

export function summarizeCreditLedgerEntries(
    entries: LedgerEntryForSummary[]
): CreditLedgerSummary {
    const summary = {
        reserved: 0,
        consumed: 0,
        refunded: 0,
        released: 0,
        expired: 0,
    };

    for (const entry of entries) {
        if (entry.type === 'RESERVED') summary.reserved += entry.credits;
        if (entry.type === 'CONSUMED') summary.consumed += entry.credits;
        if (entry.type === 'REFUNDED') summary.refunded += entry.credits;
        if (entry.type === 'RELEASED') summary.released += entry.credits;
        if (entry.type === 'EXPIRED') summary.expired += entry.credits;
    }

    const outstandingReserved = Math.max(
        0,
        summary.reserved -
            summary.consumed -
            summary.released -
            summary.expired
    );
    const netConsumed = Math.max(0, summary.consumed - summary.refunded);
    return {
        ...summary,
        outstandingReserved,
        netConsumed,
        committed: outstandingReserved + netConsumed,
    };
}

async function writeScopedDebit(
    args: CreditLedgerWriteArgs,
    type: CreditLedgerEntryType,
    availableCredits: (summary: CreditLedgerSummary) => number,
    errorFactory: () => CreditLedgerError
) {
    return prisma.$transaction(async (tx) => {
        const existing = await findIdempotentEntry(tx, args.idempotencyKey);
        if (existing) return existingResult(existing);

        assertPositiveCredits(args.credits);

        const summary = await getLedgerSummary(tx, args);
        if (availableCredits(summary) < args.credits) {
            throw errorFactory();
        }

        return createLedgerEntry(tx, type, args);
    });
}

async function createLedgerEntry(
    tx: CreditLedgerTransactionClient,
    type: CreditLedgerEntryType,
    args: CreditLedgerWriteArgs
): Promise<CreditLedgerWriteResult> {
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
        summary,
        policy: SERVER_ANALYSIS_CREDIT_LEDGER_POLICY_V1,
    };
}

async function findIdempotentEntry(
    tx: CreditLedgerTransactionClient,
    idempotencyKey: string
) {
    return tx.creditLedgerEntry.findUnique({
        where: { idempotencyKey },
    });
}

function existingResult(entry: CreditLedgerEntry): CreditLedgerWriteResult {
    return {
        entry,
        created: false,
        summary: null,
        policy: SERVER_ANALYSIS_CREDIT_LEDGER_POLICY_V1,
    };
}

async function getLedgerSummary(
    tx: CreditLedgerTransactionClient,
    ref: CreditLedgerReference
) {
    const entries = await tx.creditLedgerEntry.findMany({
        where: ledgerWhere(ref),
        select: {
            type: true,
            credits: true,
        },
    });
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

function assertPositiveCredits(credits: number) {
    if (!Number.isInteger(credits) || credits <= 0) {
        throw new CreditLedgerError('Credits must be a positive integer');
    }
}
