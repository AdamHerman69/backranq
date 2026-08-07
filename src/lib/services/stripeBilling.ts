import type { BillingPlan, Prisma } from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { appUrl, getStripeClient } from '@/lib/stripe';
import {
    getOrCreateDefaultBillingAccount,
    reconcileBillingAccountInTransaction,
} from '@/lib/services/billingAccounts';
import { scheduleAutoAnalysisWakeup } from '@/lib/services/autoAnalysisBacklog';

export type PaidBillingPlan = Exclude<BillingPlan, 'FREE'>;
export type StripeEventFence = {
    eventId?: string | null;
    eventCreatedAt?: Date | null;
};

export class ComplimentaryCheckoutNotAllowedError extends Error {
    constructor() {
        super('Paid checkout is unavailable while complimentary Premium is active');
        this.name = 'ComplimentaryCheckoutNotAllowedError';
    }
}

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
    const account = await getOrCreateDefaultBillingAccount(args.userId);
    if (account.planSource === 'ADMIN' || account.planSource === 'COMPLIMENTARY') {
        throw new ComplimentaryCheckoutNotAllowedError();
    }

    const stripe = getStripeClient();
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

    const billingUpdate = await upsertBillingAccountFromStripe({
        userId,
        customerId,
        subscriptionId: subscription.id,
        subscriptionStatus: subscription.status,
        priceId,
        currentPeriodStart: subscriptionCurrentPeriodStart(subscription),
        currentPeriodEnd: subscriptionCurrentPeriodEnd(subscription),
        stripePlan: plan,
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
    await runSerializableBillingUpdate(async (tx) => {
        const existing = await tx.billingAccount.findFirst({
            where: { stripeSubscriptionId: subscription.id },
        });
        if (!existing || stripeEventIsStaleOrDuplicate(existing, eventFence)) {
            return { applied: false };
        }
        const now = eventFence.eventCreatedAt ?? new Date();
        await tx.billingAccount.update({
            where: { userId: existing.userId },
            data: {
                stripePlan: 'FREE',
                stripeSubscriptionId: subscription.id,
                stripeSubscriptionStatus: subscription.status,
                stripePriceId: subscription.items.data[0]?.price.id ?? null,
                stripeCurrentPeriodEnd:
                    subscriptionCurrentPeriodEnd(subscription),
                ...(eventFence.eventCreatedAt
                    ? {
                          stripeLastEventCreatedAt: eventFence.eventCreatedAt,
                          stripeLastEventId: eventFence.eventId ?? null,
                      }
                    : {}),
            },
        });
        await reconcileBillingAccountInTransaction({
            tx,
            userId: existing.userId,
            now,
        });
        return { applied: true };
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
    stripePlan: BillingPlan;
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

        const paid = args.stripePlan !== 'FREE';
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
        const data = {
            stripePlan: args.stripePlan,
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
        };

        await tx.billingAccount.upsert({
            where: { userId: args.userId },
            update: data,
            create: {
                userId: args.userId,
                ...data,
            },
        });
        const reconciled = await reconcileBillingAccountInTransaction({
            tx,
            userId: args.userId,
            now,
            ...(paid &&
            (billingPeriodAdvanced || becamePaid) &&
            args.currentPeriodStart &&
            args.currentPeriodEnd
                ? {
                      stripeAllowancePeriod: {
                          start: args.currentPeriodStart,
                          end: args.currentPeriodEnd,
                      },
                  }
                : {}),
        });
        return {
            applied: true,
            capacityIncreased:
                billingPeriodAdvanced ||
                becamePaid ||
                existing === null ||
                reconciled.serverCreditsBalance >
                    existing.serverCreditsBalance ||
                reconciled.monthlyServerCreditsLimit >
                    existing.monthlyServerCreditsLimit,
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
