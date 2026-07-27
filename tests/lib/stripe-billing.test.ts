import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type StripeBillingModule = typeof import('@/lib/services/stripeBilling');

const subscriptionsRetrieveMock = vi.fn();

async function importStripeBilling(): Promise<StripeBillingModule> {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/stripe', () => ({
        appUrl: () => 'http://localhost:3000',
        getStripeClient: () => ({
            subscriptions: { retrieve: subscriptionsRetrieveMock },
            customers: { create: vi.fn() },
            checkout: { sessions: { create: vi.fn() } },
            billingPortal: { sessions: { create: vi.fn() } },
        }),
    }));
    return import('@/lib/services/stripeBilling');
}

describe('stripe billing price mapping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY', 'price_plus');
        vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY', 'price_pro');
    });

    it('maps internal paid plans to configured Stripe prices', async () => {
        const billing = await importStripeBilling();

        expect(billing.stripePriceIdForPlan('PLUS')).toBe('price_plus');
        expect(billing.stripePriceIdForPlan('PRO')).toBe('price_pro');
    });

    it('maps Stripe prices back to internal paid plans', async () => {
        const billing = await importStripeBilling();

        expect(billing.billingPlanForStripePriceId('price_plus')).toBe('PLUS');
        expect(billing.billingPlanForStripePriceId('price_pro')).toBe('PRO');
    });

    it('rejects unknown Stripe prices', async () => {
        const billing = await importStripeBilling();

        expect(() => billing.billingPlanForStripePriceId('price_unknown')).toThrow(
            'Unknown Stripe price ID'
        );
    });

    it('applies active subscriptions as paid entitlements', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.findFirst.mockResolvedValue(null);
        prismaMock.billingAccount.findUnique.mockResolvedValue({
            userId: 'user-1',
            plan: 'FREE',
            serverCreditsBalance: 100,
            stripePriceId: null,
            stripeSubscriptionStatus: null,
        });
        prismaMock.billingAccount.upsert.mockResolvedValue({});

        await billing.applyStripeSubscription(subscription({ status: 'active' }));

        expect(prismaMock.billingAccount.upsert).toHaveBeenCalledWith({
            where: { userId: 'user-1' },
            update: expect.objectContaining({
                plan: 'PLUS',
                stripeCustomerId: 'cus_1',
                stripeSubscriptionId: 'sub_1',
                stripeSubscriptionStatus: 'active',
                stripePriceId: 'price_plus',
                monthlyServerCreditsLimit: 1000,
                autoAnalysisMonthlyCap: 500,
                autoAnalysisDailyCap: 50,
                serverCreditsBalance: 1000,
                monthlyServerCreditsUsed: 0,
            }),
            create: expect.objectContaining({
                userId: 'user-1',
                plan: 'PLUS',
            }),
        });
    });

    it('maps non-paid subscription statuses back to free entitlements', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.findFirst.mockResolvedValue({ userId: 'user-1' });
        prismaMock.billingAccount.findUnique.mockResolvedValue({
            userId: 'user-1',
            plan: 'PLUS',
            serverCreditsBalance: 1000,
            stripePriceId: 'price_plus',
            stripeSubscriptionStatus: 'active',
        });
        prismaMock.billingAccount.upsert.mockResolvedValue({});

        await billing.applyStripeSubscription(subscription({ status: 'past_due' }));

        expect(prismaMock.billingAccount.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    plan: 'FREE',
                    monthlyServerCreditsLimit: 100,
                    autoAnalysisMonthlyCap: 50,
                    autoAnalysisDailyCap: 10,
                    stripeSubscriptionStatus: 'past_due',
                }),
            })
        );
    });

    it('retrieves checkout subscriptions and applies them with checkout identifiers', async () => {
        const billing = await importStripeBilling();
        const sub = subscription({ status: 'active' });
        subscriptionsRetrieveMock.mockResolvedValue(sub);
        prismaMock.billingAccount.findFirst.mockResolvedValue(null);
        prismaMock.billingAccount.findUnique.mockResolvedValue(null);
        prismaMock.billingAccount.upsert.mockResolvedValue({});

        await billing.applyStripeCheckoutSession({
            mode: 'subscription',
            client_reference_id: 'user-1',
            customer: 'cus_1',
            subscription: 'sub_1',
            metadata: {},
        } as never);

        expect(subscriptionsRetrieveMock).toHaveBeenCalledWith('sub_1', {
            expand: ['items.data.price'],
        });
        expect(prismaMock.billingAccount.upsert).toHaveBeenCalled();
    });

    it('downgrades deleted subscriptions to free entitlements', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 1 });

        await billing.markStripeSubscriptionDeleted(
            subscription({ status: 'canceled' })
        );

        expect(prismaMock.billingAccount.updateMany).toHaveBeenCalledWith({
            where: {
                OR: [
                    { stripeSubscriptionId: 'sub_1' },
                    { stripeCustomerId: 'cus_1' },
                ],
            },
            data: expect.objectContaining({
                plan: 'FREE',
                stripeSubscriptionStatus: 'canceled',
                monthlyServerCreditsLimit: 100,
            }),
        });
    });
});

function subscription(args: { status: string }) {
    return {
        id: 'sub_1',
        customer: 'cus_1',
        status: args.status,
        metadata: { userId: 'user-1' },
        items: {
            data: [
                {
                    price: { id: 'price_plus' },
                    current_period_end: 1_800_000_000,
                },
            ],
        },
    } as never;
}
