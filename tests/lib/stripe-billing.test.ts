import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type StripeBillingModule = typeof import('@/lib/services/stripeBilling');

const subscriptionsRetrieveMock = vi.fn();
const scheduleAutoAnalysisWakeupMock = vi.fn();

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
    vi.doMock('@/lib/services/autoAnalysisBacklog', () => ({
        scheduleAutoAnalysisWakeup: scheduleAutoAnalysisWakeupMock,
    }));
    return import('@/lib/services/stripeBilling');
}

describe('stripe billing price mapping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY', 'price_plus');
        vi.stubEnv('STRIPE_PRICE_PRO_MONTHLY', 'price_pro');
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                    prismaMock
                )
        );
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
                autoAnalysisMonthlyGameLimit: 500,
                autoAnalysisDailyGameLimit: 50,
                serverCreditsBalance: 1000,
            }),
            create: expect.objectContaining({
                userId: 'user-1',
                plan: 'PLUS',
            }),
        });
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'billing'
        );
    });

    it('tops up and wakes the backlog when Stripe advances the billing period', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.findFirst.mockResolvedValue({
            userId: 'user-1',
        });
        prismaMock.billingAccount.findUnique.mockResolvedValue({
            userId: 'user-1',
            plan: 'PLUS',
            serverCreditsBalance: 0,
            serverCreditsRenewAt: new Date('2020-01-01T00:00:00Z'),
            monthlyServerCreditsLimit: 1000,
            autoAnalysisMonthlyGameLimit: 500,
            autoAnalysisDailyGameLimit: 50,
            stripePriceId: 'price_plus',
            stripeSubscriptionStatus: 'active',
            stripeCurrentPeriodEnd: new Date('2026-12-15T08:00:00Z'),
        });
        prismaMock.billingAccount.upsert.mockResolvedValue({});

        await billing.applyStripeSubscription(
            subscription({ status: 'active' })
        );

        expect(prismaMock.billingAccount.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                update: expect.objectContaining({
                    serverCreditsBalance: 1000,
                    monthlyServerCreditsUsed: 0,
                    serverCreditsPeriodStart: new Date(
                        '2026-12-15T08:00:00.000Z'
                    ),
                    serverCreditsRenewAt: expect.any(Date),
                }),
            })
        );
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'billing'
        );
    });

    it('changes plans by granting only the entitlement delta without resetting usage', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.findFirst.mockResolvedValue({
            userId: 'user-1',
        });
        prismaMock.billingAccount.findUnique.mockResolvedValue({
            userId: 'user-1',
            plan: 'PLUS',
            serverCreditsBalance: 400,
            monthlyServerCreditsUsed: 600,
            serverCreditsRenewAt: new Date('2027-01-15T08:00:00Z'),
            monthlyServerCreditsLimit: 1000,
            autoAnalysisMonthlyGameLimit: 500,
            autoAnalysisDailyGameLimit: 50,
            stripePriceId: 'price_plus',
            stripeSubscriptionStatus: 'active',
            stripeCurrentPeriodEnd: new Date('2027-01-15T08:00:00Z'),
        });
        prismaMock.billingAccount.upsert.mockResolvedValue({});

        await billing.applyStripeSubscription(
            subscription({ status: 'active', priceId: 'price_pro' })
        );

        const upsertArgs = prismaMock.billingAccount.upsert.mock
            .calls[0]?.[0] as
            | { update: Record<string, unknown> }
            | undefined;
        const update = upsertArgs?.update ?? {};
        expect(update).toMatchObject({
            plan: 'PRO',
            monthlyServerCreditsLimit: 5_000,
            serverCreditsBalance: 4_400,
        });
        expect(update).not.toHaveProperty('monthlyServerCreditsUsed');
        expect(update).not.toHaveProperty('serverCreditsRenewAt');
    });

    it('does not move the stored period backward or reset usage for a stale webhook', async () => {
        const billing = await importStripeBilling();
        const storedPeriodEnd = new Date('2027-02-15T08:00:00Z');
        prismaMock.billingAccount.findFirst.mockResolvedValue({
            userId: 'user-1',
        });
        prismaMock.billingAccount.findUnique.mockResolvedValue({
            userId: 'user-1',
            plan: 'PLUS',
            serverCreditsBalance: 400,
            monthlyServerCreditsUsed: 600,
            serverCreditsRenewAt: storedPeriodEnd,
            monthlyServerCreditsLimit: 1000,
            autoAnalysisMonthlyGameLimit: 500,
            autoAnalysisDailyGameLimit: 50,
            stripePriceId: 'price_plus',
            stripeSubscriptionStatus: 'active',
            stripeCurrentPeriodEnd: storedPeriodEnd,
        });
        prismaMock.billingAccount.upsert.mockResolvedValue({});

        await billing.applyStripeSubscription(
            subscription({
                status: 'active',
                periodEnd: Date.parse('2027-01-15T08:00:00Z') / 1_000,
            })
        );

        const upsertArgs = prismaMock.billingAccount.upsert.mock
            .calls[0]?.[0] as
            | { update: Record<string, unknown> }
            | undefined;
        const update = upsertArgs?.update ?? {};
        expect(update.stripeCurrentPeriodEnd).toEqual(storedPeriodEnd);
        expect(update).not.toHaveProperty('monthlyServerCreditsUsed');
        expect(update).not.toHaveProperty('serverCreditsBalance');
        expect(update).not.toHaveProperty('serverCreditsRenewAt');
    });

    it('ignores an older subscription event without overwriting the current plan', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.findFirst.mockResolvedValue({
            userId: 'user-1',
        });
        prismaMock.billingAccount.findUnique.mockResolvedValue({
            userId: 'user-1',
            plan: 'PRO',
            serverCreditsBalance: 4_000,
            monthlyServerCreditsUsed: 1_000,
            serverCreditsRenewAt: new Date('2027-02-15T08:00:00Z'),
            monthlyServerCreditsLimit: 5_000,
            autoAnalysisMonthlyGameLimit: 5_000,
            autoAnalysisDailyGameLimit: 250,
            stripePriceId: 'price_pro',
            stripeSubscriptionStatus: 'active',
            stripeSubscriptionId: 'sub_1',
            stripeCurrentPeriodEnd: new Date('2027-02-15T08:00:00Z'),
            stripeLastEventCreatedAt: new Date(
                '2027-01-20T08:00:00Z'
            ),
            stripeLastEventId: 'evt_new',
        });

        await billing.applyStripeSubscription(
            subscription({ status: 'active', priceId: 'price_plus' }),
            {
                eventId: 'evt_old',
                eventCreatedAt: new Date('2027-01-19T08:00:00Z'),
            }
        );

        expect(prismaMock.billingAccount.upsert).not.toHaveBeenCalled();
        expect(scheduleAutoAnalysisWakeupMock).not.toHaveBeenCalled();
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
                    autoAnalysisMonthlyGameLimit: 50,
                    autoAnalysisDailyGameLimit: 10,
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
                stripeSubscriptionId: 'sub_1',
            },
            data: expect.objectContaining({
                plan: 'FREE',
                stripeSubscriptionStatus: 'canceled',
                monthlyServerCreditsLimit: 100,
            }),
        });
    });

    it('cannot downgrade a replacement subscription through an old deletion event', async () => {
        const billing = await importStripeBilling();
        prismaMock.billingAccount.updateMany.mockResolvedValue({ count: 0 });
        const eventCreatedAt = new Date('2027-01-20T08:00:00Z');

        await billing.markStripeSubscriptionDeleted(
            subscription({ status: 'canceled' }),
            {
                eventId: 'evt_delete_old',
                eventCreatedAt,
            }
        );

        expect(prismaMock.billingAccount.updateMany).toHaveBeenCalledWith({
            where: {
                stripeSubscriptionId: 'sub_1',
                OR: [
                    { stripeLastEventCreatedAt: null },
                    {
                        stripeLastEventCreatedAt: {
                            lte: eventCreatedAt,
                        },
                    },
                ],
            },
            data: expect.objectContaining({
                plan: 'FREE',
                stripeLastEventId: 'evt_delete_old',
                stripeLastEventCreatedAt: eventCreatedAt,
            }),
        });
    });
});

function subscription(args: {
    status: string;
    priceId?: string;
    periodStart?: number;
    periodEnd?: number;
}) {
    return {
        id: 'sub_1',
        customer: 'cus_1',
        status: args.status,
        metadata: { userId: 'user-1' },
        items: {
            data: [
                {
                    price: { id: args.priceId ?? 'price_plus' },
                    current_period_start:
                        args.periodStart ?? 1_797_321_600,
                    current_period_end: args.periodEnd ?? 1_800_000_000,
                },
            ],
        },
    } as never;
}
