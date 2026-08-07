import { describe, expect, it } from 'vitest';

import { presentBillingAccount } from '@/lib/billing/presentation';

describe('billing presentation', () => {
    it('shows effective administrator access and an active paid contract independently', () => {
        const presentation = presentBillingAccount({
            plan: 'PRO',
            planSource: 'ADMIN',
            stripePlan: 'PLUS',
            stripeSubscriptionStatus: 'active',
            stripeCurrentPeriodEnd: '2027-01-15T08:00:00.000Z',
        });

        expect(presentation).toMatchObject({
            access: {
                plan: 'PRO',
                planLabel: 'Pro',
                source: 'ADMIN',
                sourceLabel: 'Administrator access',
            },
            paidSubscription: {
                plan: 'PLUS',
                planLabel: 'Plus',
                status: 'active',
                statusLabel: 'Active',
                periodEndLabel: 'Jan 15, 2027',
                continuesAlongsideAccess: true,
            },
            checkoutBlocked: true,
            checkoutBlockedReason: 'EXISTING_CONTRACT',
        });
    });

    it.each([
        ['past_due', 'Payment past due', true],
        ['incomplete', 'Setup incomplete', true],
        ['unpaid', 'Unpaid', true],
        ['paused', 'Paused', false],
    ] as const)(
        'keeps the non-terminal %s contract visible',
        (status, statusLabel, actionRequired) => {
            const presentation = presentBillingAccount({
                plan: 'FREE',
                planSource: 'FREE',
                stripePlan: 'PLUS',
                stripeSubscriptionStatus: status,
                stripeCurrentPeriodEnd: null,
            });

            expect(presentation.paidSubscription).toMatchObject({
                plan: 'PLUS',
                status,
                statusLabel,
                actionRequired,
            });
            expect(presentation.checkoutBlockedReason).toBe(
                'EXISTING_CONTRACT'
            );
        }
    );

    it.each(['canceled', 'incomplete_expired'])(
        'treats %s as terminal for checkout',
        (status) => {
            const presentation = presentBillingAccount({
                plan: 'FREE',
                planSource: 'FREE',
                stripePlan: 'FREE',
                stripeSubscriptionStatus: status,
                stripeCurrentPeriodEnd: null,
            });

            expect(presentation.paidSubscription).toBeNull();
            expect(presentation.checkoutBlocked).toBe(false);
            expect(presentation.checkoutBlockedReason).toBeNull();
        }
    );

    it('blocks checkout for complimentary access without inventing a paid contract', () => {
        const presentation = presentBillingAccount({
            plan: 'PRO',
            planSource: 'COMPLIMENTARY',
            stripePlan: 'FREE',
            stripeSubscriptionStatus: null,
            stripeCurrentPeriodEnd: null,
        });

        expect(presentation.paidSubscription).toBeNull();
        expect(presentation.checkoutBlockedReason).toBe('ELEVATED_ACCESS');
    });
});
