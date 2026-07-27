import { describe, expect, it } from 'vitest';

import { calculateManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';

describe('calculateManualServerAnalysisCapacity', () => {
    it('uses the smaller of spendable balance and monthly capacity', () => {
        expect(
            calculateManualServerAnalysisCapacity({
                currentBalance: 18,
                stopThreshold: 3,
                monthlyLimit: 100,
                monthlyUsed: 70,
                outstandingReservations: 8,
            })
        ).toMatchObject({
            currentBalance: 18,
            spendableBalance: 15,
            monthlyRemaining: 22,
            reservableCredits: 15,
            limitingFactor: 'balance',
        });
    });

    it('subtracts outstanding reservations from monthly capacity', () => {
        expect(
            calculateManualServerAnalysisCapacity({
                currentBalance: 50,
                stopThreshold: 0,
                monthlyLimit: 20,
                monthlyUsed: 12,
                outstandingReservations: 5,
            })
        ).toMatchObject({
            spendableBalance: 50,
            monthlyRemaining: 3,
            reservableCredits: 3,
            limitingFactor: 'monthly-limit',
        });
    });

    it('honors the stop threshold even when the account has a balance', () => {
        expect(
            calculateManualServerAnalysisCapacity({
                currentBalance: 10,
                stopThreshold: 10,
                monthlyLimit: 100,
                monthlyUsed: 0,
                outstandingReservations: 0,
            })
        ).toMatchObject({
            currentBalance: 10,
            spendableBalance: 0,
            reservableCredits: 0,
            limitingFactor: 'stop-threshold',
        });
    });

    it('clamps exhausted and malformed capacity inputs at zero', () => {
        expect(
            calculateManualServerAnalysisCapacity({
                currentBalance: -2,
                stopThreshold: 0,
                monthlyLimit: 10,
                monthlyUsed: 12,
                outstandingReservations: Number.NaN,
            })
        ).toMatchObject({
            currentBalance: 0,
            outstandingReservations: 0,
            spendableBalance: 0,
            monthlyRemaining: 0,
            reservableCredits: 0,
        });
    });
});
