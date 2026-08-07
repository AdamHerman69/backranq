import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

type StripeBillingModule = typeof import('@/lib/services/stripeBilling');

const subscriptionsRetrieveMock = vi.fn();
const scheduleAutoAnalysisWakeupMock = vi.fn();
let billingAccountState: ReturnType<typeof storedBillingAccount> | null = null;

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
        billingAccountState = null;
        prismaMock.$transaction.mockImplementation(
            async (callback: unknown) =>
                (callback as (tx: typeof prismaMock) => Promise<unknown>)(
                    prismaMock
                )
        );
        prismaMock.user.findUnique.mockResolvedValue({ email: null });
        prismaMock.planGrant.findMany.mockResolvedValue([]);
        prismaMock.billingAccount.findUnique.mockImplementation(async () =>
            billingAccountState
        );
        prismaMock.billingAccount.findFirst.mockImplementation(async () =>
            billingAccountState
        );
        prismaMock.billingAccount.upsert.mockImplementation(
            async (rawArgs: unknown) => {
                const args = rawArgs as {
                    create: Record<string, unknown>;
                    update: Record<string, unknown>;
                };
                billingAccountState = billingAccountState
                    ? ({
                          ...billingAccountState,
                          ...args.update,
                      } as ReturnType<typeof storedBillingAccount>)
                    : storedBillingAccount(args.create);
                return billingAccountState;
            }
        );
        prismaMock.billingAccount.update.mockImplementation(
            async (rawArgs: unknown) => {
                const args = rawArgs as { data: Record<string, unknown> };
                billingAccountState = storedBillingAccount({
                    ...billingAccountState,
                    ...args.data,
                });
                return billingAccountState;
            }
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
        billingAccountState = storedBillingAccount();

        await billing.applyStripeSubscription(subscription({ status: 'active' }));

        expect(billingAccountState).toMatchObject({
            plan: 'PLUS',
            planSource: 'STRIPE',
            stripePlan: 'PLUS',
            stripeCustomerId: 'cus_1',
            stripeSubscriptionId: 'sub_1',
            stripeSubscriptionStatus: 'active',
            stripePriceId: 'price_plus',
            monthlyServerCreditsLimit: 1000,
            autoAnalysisMonthlyGameLimit: 500,
            autoAnalysisDailyGameLimit: 50,
            serverCreditsBalance: 1000,
        });
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'billing'
        );
    });

    it('tops up and wakes the backlog when Stripe advances the billing period', async () => {
        const billing = await importStripeBilling();
        billingAccountState = storedBillingAccount({
            plan: 'PLUS',
            planSource: 'STRIPE',
            stripePlan: 'PLUS',
            serverCreditsBalance: 0,
            serverCreditsRenewAt: new Date('2020-01-01T00:00:00Z'),
            monthlyServerCreditsLimit: 1000,
            autoAnalysisMonthlyGameLimit: 500,
            autoAnalysisDailyGameLimit: 50,
            stripePriceId: 'price_plus',
            stripeSubscriptionStatus: 'active',
            stripeCurrentPeriodEnd: new Date('2026-12-15T08:00:00Z'),
        });

        await billing.applyStripeSubscription(
            subscription({ status: 'active' })
        );

        expect(billingAccountState).toMatchObject({
            serverCreditsBalance: 1000,
            monthlyServerCreditsUsed: 0,
            serverCreditsPeriodStart: new Date('2026-12-15T08:00:00.000Z'),
            serverCreditsRenewAt: new Date('2027-01-15T08:00:00.000Z'),
        });
        expect(scheduleAutoAnalysisWakeupMock).toHaveBeenCalledWith(
            'user-1',
            'billing'
        );
    });

    it('changes plans by granting only the entitlement delta without resetting usage', async () => {
        const billing = await importStripeBilling();
        billingAccountState = storedBillingAccount({
            plan: 'PLUS',
            planSource: 'STRIPE',
            stripePlan: 'PLUS',
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

        await billing.applyStripeSubscription(
            subscription({ status: 'active', priceId: 'price_pro' })
        );

        expect(billingAccountState).toMatchObject({
            plan: 'PRO',
            monthlyServerCreditsLimit: 5_000,
            serverCreditsBalance: 4_400,
            monthlyServerCreditsUsed: 600,
            serverCreditsRenewAt: new Date('2027-01-15T08:00:00Z'),
        });
    });

    it('does not move the stored period backward or reset usage for a stale webhook', async () => {
        const billing = await importStripeBilling();
        const storedPeriodEnd = new Date('2027-02-15T08:00:00Z');
        billingAccountState = storedBillingAccount({
            plan: 'PLUS',
            planSource: 'STRIPE',
            stripePlan: 'PLUS',
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

        await billing.applyStripeSubscription(
            subscription({
                status: 'active',
                periodEnd: Date.parse('2027-01-15T08:00:00Z') / 1_000,
            })
        );

        expect(billingAccountState).toMatchObject({
            stripeCurrentPeriodEnd: storedPeriodEnd,
            monthlyServerCreditsUsed: 600,
            serverCreditsBalance: 400,
            serverCreditsRenewAt: storedPeriodEnd,
        });
    });

    it('ignores an older subscription event without overwriting the current plan', async () => {
        const billing = await importStripeBilling();
        billingAccountState = storedBillingAccount({
            plan: 'PRO',
            planSource: 'STRIPE',
            stripePlan: 'PRO',
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
        billingAccountState = storedBillingAccount({
            plan: 'PLUS',
            planSource: 'STRIPE',
            stripePlan: 'PLUS',
            serverCreditsBalance: 1000,
            stripePriceId: 'price_plus',
            stripeSubscriptionStatus: 'active',
        });

        await billing.applyStripeSubscription(subscription({ status: 'past_due' }));

        expect(billingAccountState).toMatchObject({
            plan: 'FREE',
            planSource: 'FREE',
            stripePlan: 'FREE',
            monthlyServerCreditsLimit: 100,
            autoAnalysisMonthlyGameLimit: 50,
            autoAnalysisDailyGameLimit: 10,
            stripeSubscriptionStatus: 'past_due',
        });
    });

    it('retrieves checkout subscriptions and applies them with checkout identifiers', async () => {
        const billing = await importStripeBilling();
        const sub = subscription({ status: 'active' });
        subscriptionsRetrieveMock.mockResolvedValue(sub);
        billingAccountState = null;

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
        billingAccountState = storedBillingAccount({
            plan: 'PLUS',
            planSource: 'STRIPE',
            stripePlan: 'PLUS',
            stripeSubscriptionId: 'sub_1',
            stripeSubscriptionStatus: 'active',
            monthlyServerCreditsLimit: 1_000,
        });

        await billing.markStripeSubscriptionDeleted(
            subscription({ status: 'canceled' })
        );

        expect(billingAccountState).toMatchObject({
            plan: 'FREE',
            planSource: 'FREE',
            stripePlan: 'FREE',
            stripeSubscriptionStatus: 'canceled',
            monthlyServerCreditsLimit: 100,
        });
    });

    it('cannot downgrade a replacement subscription through an old deletion event', async () => {
        const billing = await importStripeBilling();
        const eventCreatedAt = new Date('2027-01-20T08:00:00Z');
        billingAccountState = storedBillingAccount({
            plan: 'PRO',
            planSource: 'STRIPE',
            stripePlan: 'PRO',
            stripeSubscriptionId: 'sub_replacement',
            stripeSubscriptionStatus: 'active',
            stripeLastEventCreatedAt: new Date('2027-01-21T08:00:00Z'),
            stripeLastEventId: 'evt_replacement',
        });

        await billing.markStripeSubscriptionDeleted(
            subscription({ status: 'canceled' }),
            {
                eventId: 'evt_delete_old',
                eventCreatedAt,
            }
        );

        expect(prismaMock.billingAccount.update).not.toHaveBeenCalled();
        expect(billingAccountState).toMatchObject({
            plan: 'PRO',
            stripePlan: 'PRO',
            stripeSubscriptionId: 'sub_replacement',
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

function storedBillingAccount(overrides: Record<string, unknown> = {}) {
    return {
        id: 'billing-1',
        userId: 'user-1',
        plan: 'FREE' as const,
        planSource: 'FREE' as const,
        stripePlan: 'FREE' as const,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripeSubscriptionStatus: null,
        stripePriceId: null,
        stripeCurrentPeriodEnd: null,
        stripeLastEventCreatedAt: null,
        stripeLastEventId: null,
        serverCreditsBalance: 100,
        monthlyServerCreditsUsed: 0,
        serverCreditsPeriodStart: new Date('2026-08-01T00:00:00Z'),
        serverCreditsRenewAt: new Date('2027-08-01T00:00:00Z'),
        monthlyServerCreditsLimit: 100,
        autoAnalysisMonthlyGameLimit: 50,
        autoAnalysisDailyGameLimit: 10,
        stopWhenCreditsBelow: 0,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
        ...overrides,
    };
}
