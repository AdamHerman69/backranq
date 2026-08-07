import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveBillingEntitlement } from '@/lib/billing/entitlements';

function tx(
    adminActive: boolean,
    grants: Array<{ id: string; plan: 'PLUS' | 'PRO' }> = []
) {
    return {
        adminMembership: {
            findUnique: vi
                .fn()
                .mockResolvedValue(adminActive ? { active: true } : null),
        },
        planGrant: { findMany: vi.fn().mockResolvedValue(grants) },
    } as never;
}

describe('effective billing entitlement', () => {
    it('grants active database administrators automatic Pro access', async () => {
        await expect(
            resolveEffectiveBillingEntitlement({
                tx: tx(true),
                userId: 'user-1',
                account: {
                    stripePlan: 'FREE',
                    stripeSubscriptionStatus: null,
                },
                now: new Date('2026-08-06T00:00:00Z'),
            })
        ).resolves.toEqual({
            plan: 'PRO',
            source: 'ADMIN',
            grantId: null,
        });
    });

    it('keeps complimentary Pro above a paid Plus subscription', async () => {
        await expect(
            resolveEffectiveBillingEntitlement({
                tx: tx(false, [
                    { id: 'grant-1', plan: 'PRO' },
                ]),
                userId: 'user-1',
                account: {
                    stripePlan: 'PLUS',
                    stripeSubscriptionStatus: 'active',
                },
                now: new Date('2026-08-06T00:00:00Z'),
            })
        ).resolves.toEqual({
            plan: 'PRO',
            source: 'COMPLIMENTARY',
            grantId: 'grant-1',
        });
    });

    it('falls back to the active Stripe plan when no grant exists', async () => {
        await expect(
            resolveEffectiveBillingEntitlement({
                tx: tx(false),
                userId: 'user-1',
                account: {
                    stripePlan: 'PLUS',
                    stripeSubscriptionStatus: 'trialing',
                },
                now: new Date('2026-08-06T00:00:00Z'),
            })
        ).resolves.toEqual({
            plan: 'PLUS',
            source: 'STRIPE',
            grantId: null,
        });
    });

    it('does not turn a non-terminal past-due contract into access', async () => {
        await expect(
            resolveEffectiveBillingEntitlement({
                tx: tx(false),
                userId: 'user-1',
                account: {
                    stripePlan: 'PLUS',
                    stripeSubscriptionStatus: 'past_due',
                },
                now: new Date('2026-08-06T00:00:00Z'),
            })
        ).resolves.toEqual({
            plan: 'FREE',
            source: 'FREE',
            grantId: null,
        });
    });
});
