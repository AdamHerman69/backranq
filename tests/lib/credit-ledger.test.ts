import { describe, expect, it } from 'vitest';
import { summarizeCreditLedgerEntries } from '@/lib/services/creditLedger';

describe('credit ledger projection', () => {
    it('separates outstanding reservations from net consumption', () => {
        expect(
            summarizeCreditLedgerEntries([
                { type: 'RESERVED', credits: 17 },
                { type: 'CONSUMED', credits: 7 },
                { type: 'RELEASED', credits: 10 },
                { type: 'REFUNDED', credits: 2 },
            ])
        ).toEqual({
            reserved: 17,
            consumed: 7,
            refunded: 2,
            released: 10,
            expired: 0,
            outstandingReserved: 0,
            netConsumed: 5,
            committed: 5,
        });
    });

    it('never exposes negative committed amounts for duplicate terminal rows', () => {
        expect(
            summarizeCreditLedgerEntries([
                { type: 'RESERVED', credits: 7 },
                { type: 'RELEASED', credits: 7 },
                { type: 'EXPIRED', credits: 7 },
            ])
        ).toMatchObject({
            outstandingReserved: 0,
            netConsumed: 0,
            committed: 0,
        });
    });
});
