import type { BillingPlan } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { appUrl, getStripeClient } from '@/lib/stripe';
import {
    DEFAULT_AUTO_ANALYSIS_DAILY_CAP,
    DEFAULT_AUTO_ANALYSIS_MONTHLY_CAP,
    DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
    DEFAULT_SERVER_CREDITS_BALANCE,
    DEFAULT_STOP_WHEN_CREDITS_BELOW,
    getOrCreateDefaultBillingAccount,
} from '@/lib/services/billingAccounts';

export type PaidBillingPlan = Exclude<BillingPlan, 'FREE'>;

type BillingPlanEntitlements = {
    plan: BillingPlan;
    monthlyServerCreditsLimit: number;
    autoAnalysisMonthlyCap: number;
    autoAnalysisDailyCap: number;
    stopWhenCreditsBelow: number;
};

const FREE_ENTITLEMENTS: BillingPlanEntitlements = {
    plan: 'FREE',
    monthlyServerCreditsLimit: DEFAULT_MONTHLY_SERVER_CREDITS_LIMIT,
    autoAnalysisMonthlyCap: DEFAULT_AUTO_ANALYSIS_MONTHLY_CAP,
    autoAnalysisDailyCap: DEFAULT_AUTO_ANALYSIS_DAILY_CAP,
    stopWhenCreditsBelow: DEFAULT_STOP_WHEN_CREDITS_BELOW,
};

const PAID_PLAN_ENTITLEMENTS: Record<PaidBillingPlan, BillingPlanEntitlements> = {
    PLUS: {
        plan: 'PLUS',
        monthlyServerCreditsLimit: 1_000,
        autoAnalysisMonthlyCap: 500,
        autoAnalysisDailyCap: 50,
        stopWhenCreditsBelow: 0,
    },
    PRO: {
        plan: 'PRO',
        monthlyServerCreditsLimit: 5_000,
        autoAnalysisMonthlyCap: 5_000,
        autoAnalysisDailyCap: 250,
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
    session: Stripe.Checkout.Session
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
    await applyStripeSubscription(subscription, { userId, customerId });
}

export async function applyStripeSubscription(
    subscription: Stripe.Subscription,
    overrides: { userId?: string | null; customerId?: string | null } = {}
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

    await upsertBillingAccountFromStripe({
        userId,
        customerId,
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        priceId,
        currentPeriodEnd: subscriptionCurrentPeriodEnd(subscription),
        entitlements,
    });
}

export async function markStripeSubscriptionDeleted(
    subscription: Stripe.Subscription
) {
    const customerId = stringId(subscription.customer);
    await prisma.billingAccount.updateMany({
        where: {
            OR: [
                { stripeSubscriptionId: subscription.id },
                ...(customerId ? [{ stripeCustomerId: customerId }] : []),
            ],
        },
        data: {
            ...billingAccountEntitlementData(FREE_ENTITLEMENTS),
            stripeSubscriptionId: subscription.id,
            stripeSubscriptionStatus: subscription.status,
            stripePriceId: subscription.items.data[0]?.price.id ?? null,
            stripeCurrentPeriodEnd: subscriptionCurrentPeriodEnd(subscription),
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
    currentPeriodEnd: Date | null;
    entitlements: BillingPlanEntitlements;
}) {
    const existing = await prisma.billingAccount.findUnique({
        where: { userId: args.userId },
    });
    const shouldTopUp =
        args.entitlements.plan !== 'FREE' &&
        (!existing ||
            existing.plan !== args.entitlements.plan ||
            existing.stripePriceId !== args.priceId ||
            !isPaidStoredStatus(existing.stripeSubscriptionStatus));
    const data = {
        ...billingAccountEntitlementData(args.entitlements),
        stripeCustomerId: args.customerId,
        stripeSubscriptionId: args.subscriptionId,
        stripeSubscriptionStatus: args.subscriptionStatus,
        stripePriceId: args.priceId,
        stripeCurrentPeriodEnd: args.currentPeriodEnd,
        ...(shouldTopUp
            ? {
                  serverCreditsBalance: Math.max(
                      existing?.serverCreditsBalance ??
                          DEFAULT_SERVER_CREDITS_BALANCE,
                      args.entitlements.monthlyServerCreditsLimit
                  ),
                  monthlyServerCreditsUsed: 0,
                  serverCreditsRenewAt: nextMonthlyRenewAt(new Date()),
              }
            : {}),
    };

    await prisma.billingAccount.upsert({
        where: { userId: args.userId },
        update: data,
        create: {
            userId: args.userId,
            serverCreditsBalance: Math.max(
                DEFAULT_SERVER_CREDITS_BALANCE,
                args.entitlements.monthlyServerCreditsLimit
            ),
            monthlyServerCreditsUsed: 0,
            serverCreditsRenewAt: nextMonthlyRenewAt(new Date()),
            ...data,
        },
    });
}

function billingAccountEntitlementData(
    entitlements: BillingPlanEntitlements
): BillingPlanEntitlements {
    return {
        plan: entitlements.plan,
        monthlyServerCreditsLimit: entitlements.monthlyServerCreditsLimit,
        autoAnalysisMonthlyCap: entitlements.autoAnalysisMonthlyCap,
        autoAnalysisDailyCap: entitlements.autoAnalysisDailyCap,
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

function nextMonthlyRenewAt(now: Date) {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return next;
}
