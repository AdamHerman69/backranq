import type { CreditLedgerEntry } from '@prisma/client';

type LedgerEntryForSummary = Pick<CreditLedgerEntry, 'type' | 'credits'>;

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

export class CreditLedgerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CreditLedgerError';
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

/** Pure projection only. All ledger writes go through billingAccounts.ts. */
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
