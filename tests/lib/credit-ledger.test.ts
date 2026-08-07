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

    it('keeps allowance events outside reservation projections across settlement combinations', () => {
        for (let reserved = 1; reserved <= 25; reserved += 1) {
            for (let consumed = 0; consumed <= reserved; consumed += 1) {
                const remaining = reserved - consumed;
                const released = Math.floor(remaining / 2);
                const expired = remaining - released;
                const reservationEvents = [
                    { type: 'RESERVED' as const, credits: reserved },
                    ...(consumed > 0
                        ? [
                              {
                                  type: 'CONSUMED' as const,
                                  credits: consumed,
                              },
                          ]
                        : []),
                    ...(released > 0
                        ? [
                              {
                                  type: 'RELEASED' as const,
                                  credits: released,
                              },
                          ]
                        : []),
                    ...(expired > 0
                        ? [
                              {
                                  type: 'EXPIRED' as const,
                                  credits: expired,
                              },
                          ]
                        : []),
                ];
                const withoutAllowance =
                    summarizeCreditLedgerEntries(reservationEvents);
                const withAllowance = summarizeCreditLedgerEntries([
                    { type: 'ALLOWANCE_GRANTED', credits: 5_000 },
                    ...reservationEvents,
                    { type: 'ALLOWANCE_EXPIRED', credits: 5_000 },
                ]);

                expect(withAllowance).toEqual(withoutAllowance);
                expect(withAllowance.outstandingReserved).toBe(0);
                expect(withAllowance.netConsumed).toBe(consumed);
            }
        }
    });
});
