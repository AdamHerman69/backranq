import type { BillingPlan, Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { appUrl, getStripeClient } from '@/lib/stripe';
import {
    DEFAULT_AUTO_ANALYSIS_DAILY_GAME_LIMIT,
    DEFAULT_AUTO_ANALYSIS_MONTHLY_GAME_LIMIT,
    DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
    DEFAULT_SERVER_CREDITS_BALANCE,
    DEFAULT_STOP_WHEN_CREDITS_BELOW,
    getOrCreateDefaultBillingAccount,
} from '@/lib/services/billingAccounts';
import { scheduleAutoAnalysisWakeup } from '@/lib/services/autoAnalysisBacklog';
import { nextMonthlyRenewAt } from '@/lib/billing/periods';

export type PaidBillingPlan = Exclude<BillingPlan, 'FREE'>;
export type StripeEventFence = {
    eventId?: string | null;
    eventCreatedAt?: Date | null;
};

type BillingPlanEntitlements = {
    plan: BillingPlan;
    monthlyServerCreditsLimit: number;
    autoAnalysisMonthlyGameLimit: number;
    autoAnalysisDailyGameLimit: number;
    stopWhenCreditsBelow: number;
};

const FREE_ENTITLEMENTS: BillingPlanEntitlements = {
    plan: 'FREE',
    monthlyServerCreditsLimit: DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
    autoAnalysisMonthlyGameLimit: DEFAULT_AUTO_ANALYSIS_MONTHLY_GAME_LIMIT,
    autoAnalysisDailyGameLimit: DEFAULT_AUTO_ANALYSIS_DAILY_GAME_LIMIT,
    stopWhenCreditsBelow: DEFAULT_STOP_WHEN_CREDITS_BELOW,
};

const PAID_PLAN_ENTITLEMENTS: Record<PaidBillingPlan, BillingPlanEntitlements> = {
    PLUS: {
        plan: 'PLUS',
        monthlyServerCreditsLimit: 1_000,
        autoAnalysisMonthlyGameLimit: 500,
        autoAnalysisDailyGameLimit: 50,
        stopWhenCreditsBelow: 0,
    },
    PRO: {
        plan: 'PRO',
        monthlyServerCreditsLimit: 5_000,
        autoAnalysisMonthlyGameLimit: 5_000,
        autoAnalysisDailyGameLimit: 250,
        stopWhenCreditsBelow: 0,
    },
};

export function stripePriceIdForPlan(plan: PaidBillingPlan) {
    const priceId =
        plan === 'PLUS'
            ? process.env.STRIPE_PRICE_PLUS_MONTHLY
            : process.env.STRIPE_PRICE_PRO_MONTHLY;
    if (!priceId) {
        throw new Error(`Stripe price ID is not configured for ${plan}`);
    }
    return priceId;
}

export function billingPlanForStripePriceId(priceId: string): PaidBillingPlan {
    if (priceId === process.env.STRIPE_PRICE_PLUS_MONTHLY) return 'PLUS';
    if (priceId === process.env.STRIPE_PRICE_PRO_MONTHLY) return 'PRO';
    throw new Error(`Unknown Stripe price ID: ${priceId}`);
}

export async function createStripeCheckoutSession(args: {
    userId: string;
    email?: string | null;
    plan: PaidBillingPlan;
}) {
    const stripe = getStripeClient();
    const account = await getOrCreateDefaultBillingAccount(args.userId);
    const customerId =
        account.stripeCustomerId ??
        (await createStripeCustomer({
            userId: args.userId,
            email: args.email,
        }));

    if (!account.stripeCustomerId) {
        await prisma.billingAccount.update({
            where: { userId: args.userId },
            data: { stripeCustomerId: customerId },
        });
    }

    return stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [{ price: stripePriceIdForPlan(args.plan), quantity: 1 }],
        success_url: `${appUrl()}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl()}/settings?billing=cancelled`,
        client_reference_id: args.userId,
        subscription_data: {
            metadata: {
                userId: args.userId,
                plan: args.plan,
            },
        },
        metadata: {
            userId: args.userId,
            plan: args.plan,
        },
    });
}

export async function createStripePortalSession(userId: string) {
    const stripe = getStripeClient();
    const account = await prisma.billingAccount.findUnique({
        where: { userId },
        select: { stripeCustomerId: true },
    });
    if (!account?.stripeCustomerId) {
        throw new Error('Stripe customer is not configured for this user');
    }

    return stripe.billingPortal.sessions.create({
        customer: account.stripeCustomerId,
        return_url: `${appUrl()}/settings?billing=portal-return`,
    });
}

export async function applyStripeCheckoutSession(
    session: Stripe.Checkout.Session,
    eventFence: StripeEventFence = {}
) {
    if (session.mode !== 'subscription') return;
    const userId = session.client_reference_id ?? session.metadata?.userId;
    const subscriptionId = stringId(session.subscription);
    const customerId = stringId(session.customer);
    if (!userId || !subscriptionId || !customerId) {
        throw new Error('Stripe checkout session is missing billing identifiers');
    }

    const subscription = await getStripeClient().subscriptions.retrieve(
        subscriptionId,
        { expand: ['items.data.price'] }
    );
    await applyStripeSubscription(subscription, {
        userId,
        customerId,
        ...eventFence,
    });
}

export async function applyStripeSubscription(
    subscription: Stripe.Subscription,
    overrides: {
        userId?: string | null;
        customerId?: string | null;
    } & StripeEventFence = {}
) {
    const customerId = overrides.customerId ?? stringId(subscription.customer);
    if (!customerId) throw new Error('Stripe subscription is missing customer');

    const existing = await prisma.billingAccount.findFirst({
        where: {
            OR: [
                { stripeCustomerId: customerId },
                { stripeSubscriptionId: subscription.id },
            ],
        },
        select: { userId: true },
    });
    const userId =
        overrides.userId ??
        subscription.metadata?.userId ??
        existing?.userId ??
        null;
    if (!userId) {
        throw new Error('Could not map Stripe subscription to a Backranq user');
    }

    const priceId = subscription.items.data[0]?.price.id;
    if (!priceId) throw new Error('Stripe subscription has no price item');

    const active = isPaidSubscriptionStatus(subscription.status);
    const plan = active ? billingPlanForStripePriceId(priceId) : 'FREE';
    const entitlements = active
        ? PAID_PLAN_ENTITLEMENTS[plan as PaidBillingPlan]
        : FREE_ENTITLEMENTS;

    const billingUpdate = await upsertBillingAccountFromStripe({
        userId,
        customerId,
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        priceId,
        currentPeriodStart: subscriptionCurrentPeriodStart(subscription),
        currentPeriodEnd: subscriptionCurrentPeriodEnd(subscription),
        entitlements,
        eventId: overrides.eventId,
        eventCreatedAt: overrides.eventCreatedAt,
    });
    if (billingUpdate.capacityIncreased) {
        scheduleAutoAnalysisWakeup(userId, 'billing');
    }
}

export async function markStripeSubscriptionDeleted(
    subscription: Stripe.Subscription,
    eventFence: StripeEventFence = {}
) {
    await prisma.billingAccount.updateMany({
        where: {
            stripeSubscriptionId: subscription.id,
            ...(eventFence.eventCreatedAt
                ? {
                      OR: [
                          { stripeLastEventCreatedAt: null },
                          {
                              stripeLastEventCreatedAt: {
                                  lte: eventFence.eventCreatedAt,
                              },
                          },
                      ],
                  }
                : {}),
        },
        data: {
            ...billingAccountEntitlementData(FREE_ENTITLEMENTS),
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionStatus: subscription.status,
            stripePriceId: subscription.items.data[0]?.price.id ?? null,
            stripeCurrentPeriodEnd: subscriptionCurrentPeriodEnd(subscription),
            ...(eventFence.eventCreatedAt
                ? {
                      stripeLastEventCreatedAt: eventFence.eventCreatedAt,
                      stripeLastEventId: eventFence.eventId ?? null,
                  }
                : {}),
        },
    });
}

async function createStripeCustomer(args: {
    userId: string;
    email?: string | null;
}) {
    const customer = await getStripeClient().customers.create({
        email: args.email ?? undefined,
        metadata: { userId: args.userId },
    });
    return customer.id;
}

async function upsertBillingAccountFromStripe(args: {
    userId: string;
    customerId: string;
    subscriptionId: string;
    subscriptionStatus: string;
    priceId: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    entitlements: BillingPlanEntitlements;
    eventId?: string | null;
    eventCreatedAt?: Date | null;
}) {
    return runSerializableBillingUpdate(async (tx) => {
        const now = new Date();
        const existing = await tx.billingAccount.findUnique({
            where: { userId: args.userId },
        });
        if (stripeEventIsStaleOrDuplicate(existing, args)) {
            return { capacityIncreased: false, applied: false };
        }

        const paid = args.entitlements.plan !== 'FREE';
        const becamePaid =
            paid &&
            (existing === null ||
                !isPaidStoredStatus(existing.stripeSubscriptionStatus));
        const billingPeriodAdvanced =
            paid &&
            existing?.stripeCurrentPeriodEnd != null &&
            args.currentPeriodEnd != null &&
            args.currentPeriodEnd > existing.stripeCurrentPeriodEnd;
        const storedPeriodEnd = existing?.stripeCurrentPeriodEnd ?? null;
        const effectivePeriodEnd =
            storedPeriodEnd &&
            args.currentPeriodEnd &&
            args.currentPeriodEnd < storedPeriodEnd
                ? storedPeriodEnd
                : args.currentPeriodEnd;
        const entitlementCreditDelta =
            paid && existing
                ? Math.max(
                      0,
                      args.entitlements.monthlyServerCreditsLimit -
                          existing.monthlyServerCreditsLimit
                  )
                : 0;
        const balanceGrant =
            existing == null
                ? args.entitlements.monthlyServerCreditsLimit
                : billingPeriodAdvanced || becamePaid
                  ? Math.max(
                        0,
                        args.entitlements.monthlyServerCreditsLimit -
                            existing.serverCreditsBalance
                    )
                  : entitlementCreditDelta;
        const data = {
            ...billingAccountEntitlementData(args.entitlements),
            stripeCustomerId: args.customerId,
            stripeSubscriptionId: args.subscriptionId,
            stripeSubscriptionStatus: args.subscriptionStatus,
            stripePriceId: args.priceId,
            stripeCurrentPeriodEnd: effectivePeriodEnd,
            ...(args.eventCreatedAt
                ? {
                      stripeLastEventCreatedAt: args.eventCreatedAt,
                      stripeLastEventId: args.eventId ?? null,
                  }
                : {}),
            ...(billingPeriodAdvanced
                ? {
                      serverCreditsBalance: Math.max(
                          existing?.serverCreditsBalance ??
                              DEFAULT_SERVER_CREDITS_BALANCE,
                          args.entitlements.monthlyServerCreditsLimit
                      ),
                      monthlyServerCreditsUsed: 0,
                      serverCreditsPeriodStart:
                          args.currentPeriodStart ?? now,
                      serverCreditsRenewAt:
                          args.currentPeriodEnd ?? nextMonthlyRenewAt(now),
                  }
                : balanceGrant > 0 && existing
                  ? {
                        serverCreditsBalance:
                            existing.serverCreditsBalance + balanceGrant,
                        ...(becamePaid
                            ? {
                                  serverCreditsRenewAt:
                                      args.currentPeriodEnd ??
                                      nextMonthlyRenewAt(now),
                                  serverCreditsPeriodStart:
                                      args.currentPeriodStart ?? now,
                              }
                            : {}),
                    }
                  : {}),
        };

        await tx.billingAccount.upsert({
            where: { userId: args.userId },
            update: data,
            create: {
                userId: args.userId,
                serverCreditsBalance: Math.max(
                    DEFAULT_SERVER_CREDITS_BALANCE,
                    args.entitlements.monthlyServerCreditsLimit
                ),
                monthlyServerCreditsUsed: 0,
                serverCreditsPeriodStart: args.currentPeriodStart ?? now,
                serverCreditsRenewAt:
                    args.currentPeriodEnd ?? nextMonthlyRenewAt(now),
                ...data,
            },
        });
        return {
            applied: true,
            capacityIncreased:
                billingPeriodAdvanced ||
                balanceGrant > 0 ||
                (existing !== null &&
                    (args.entitlements.autoAnalysisDailyGameLimit >
                        existing.autoAnalysisDailyGameLimit ||
                        args.entitlements.autoAnalysisMonthlyGameLimit >
                            existing.autoAnalysisMonthlyGameLimit ||
                        args.entitlements.monthlyServerCreditsLimit >
                            existing.monthlyServerCreditsLimit)),
        };
    });
}

function stripeEventIsStaleOrDuplicate(
    existing: {
        stripeLastEventCreatedAt: Date | null;
        stripeLastEventId: string | null;
    } | null,
    incoming: StripeEventFence
) {
    if (!existing || !incoming.eventCreatedAt) return false;
    if (
        existing.stripeLastEventCreatedAt &&
        incoming.eventCreatedAt < existing.stripeLastEventCreatedAt
    ) {
        return true;
    }
    return (
        incoming.eventId != null &&
        incoming.eventId === existing.stripeLastEventId
    );
}

async function runSerializableBillingUpdate<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return await prisma.$transaction(operation, {
                isolationLevel: 'Serializable',
            });
        } catch (error) {
            if (attempt < 3 && isTransactionWriteConflict(error)) continue;
            throw error;
        }
    }
    throw new Error('Billing transaction retry limit exceeded');
}

function isTransactionWriteConflict(error: unknown) {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2034'
    );
}

function billingAccountEntitlementData(
    entitlements: BillingPlanEntitlements
): BillingPlanEntitlements {
    return {
        plan: entitlements.plan,
        monthlyServerCreditsLimit: entitlements.monthlyServerCreditsLimit,
        autoAnalysisMonthlyGameLimit:
            entitlements.autoAnalysisMonthlyGameLimit,
        autoAnalysisDailyGameLimit:
            entitlements.autoAnalysisDailyGameLimit,
        stopWhenCreditsBelow: entitlements.stopWhenCreditsBelow,
    };
}

function isPaidSubscriptionStatus(status: Stripe.Subscription.Status) {
    return status === 'active' || status === 'trialing';
}

function isPaidStoredStatus(status: string | null) {
    return status === 'active' || status === 'trialing';
}

function stringId(value: string | { id: string } | null | undefined) {
    if (!value) return null;
    return typeof value === 'string' ? value : value.id;
}

function subscriptionCurrentPeriodEnd(subscription: Stripe.Subscription) {
    const periodEnd =
        (subscription as unknown as { current_period_end?: number })
            .current_period_end ??
        (
            subscription.items.data[0] as
                | { current_period_end?: number }
                | undefined
        )?.current_period_end ??
        null;
    return typeof periodEnd === 'number' ? new Date(periodEnd * 1_000) : null;
}

function subscriptionCurrentPeriodStart(subscription: Stripe.Subscription) {
    const periodStart =
        (subscription as unknown as { current_period_start?: number })
            .current_period_start ??
        (
            subscription.items.data[0] as
                | { current_period_start?: number }
                | undefined
        )?.current_period_start ??
        null;
    return typeof periodStart === 'number'
        ? new Date(periodStart * 1_000)
        : null;
}
