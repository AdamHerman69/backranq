import { randomUUID } from 'node:crypto';
import type {
    BillingAccount,
    BillingPlan,
    BillingPlanSource,
    Prisma,
} from '@prisma/client';
import type Stripe from 'stripe';
import { prisma } from '@/lib/prisma';
import { appUrl, getStripeClient } from '@/lib/stripe';
import {
    hasLiveStripeContract,
    stripeSubscriptionProvidesAccess,
} from '@/lib/billing/stripeContract';
import { reconcileBillingAccountInTransaction } from '@/lib/services/billingAccounts';
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

export class ExistingSubscriptionRequiresPortalError extends Error {
    constructor() {
        super('Manage the existing paid subscription in the billing portal');
        this.name = 'ExistingSubscriptionRequiresPortalError';
    }
}

export class CheckoutAlreadyInProgressError extends Error {
    constructor() {
        super('A different billing checkout is already in progress');
        this.name = 'CheckoutAlreadyInProgressError';
    }
}

type CheckoutEntitlementFence = {
    plan: BillingPlan;
    source: BillingPlanSource;
};

type CheckoutClaim = {
    reservationId: string;
    sessionId: string | null;
    customerId: string | null;
    expiresAt: Date;
    fence: CheckoutEntitlementFence;
};

const CHECKOUT_RESERVATION_TTL_MS = 2 * 60 * 60 * 1_000;
const MIN_CHECKOUT_CREATION_WINDOW_MS = 31 * 60 * 1_000;

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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const claim = await claimCheckoutReservation({
            userId: args.userId,
            plan: args.plan,
            now: new Date(),
        });
        if (claim.sessionId) {
            const existing = await stripe.checkout.sessions.retrieve(
                claim.sessionId
            );
            if (existing.status === 'open') return existing;
            if (existing.status === 'complete') {
                throw new ExistingSubscriptionRequiresPortalError();
            }
            await clearCheckoutReservation(args.userId, claim.reservationId);
            continue;
        }

        const customerId =
            claim.customerId ??
            (await createStripeCustomer({
                userId: args.userId,
                email: args.email,
            }));
        if (!claim.customerId) {
            await attachCheckoutCustomer({
                userId: args.userId,
                reservationId: claim.reservationId,
                customerId,
                fence: claim.fence,
            });
        }

        const checkout = await stripe.checkout.sessions.create(
            {
                mode: 'subscription',
                customer: customerId,
                line_items: [
                    {
                        price: stripePriceIdForPlan(args.plan),
                        quantity: 1,
                    },
                ],
                success_url: `${appUrl()}/settings?billing=success&session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${appUrl()}/settings?billing=cancelled`,
                expires_at: Math.floor(claim.expiresAt.getTime() / 1_000),
                client_reference_id: args.userId,
                subscription_data: {
                    metadata: {
                        userId: args.userId,
                        plan: args.plan,
                        checkoutReservationId: claim.reservationId,
                    },
                },
                metadata: {
                    userId: args.userId,
                    plan: args.plan,
                    checkoutReservationId: claim.reservationId,
                },
            },
            { idempotencyKey: `checkout-reservation:${claim.reservationId}` }
        );
        const attached = await attachCheckoutSession({
            userId: args.userId,
            reservationId: claim.reservationId,
            sessionId: checkout.id,
            fence: claim.fence,
        });
        if (!attached) {
            await expireCheckoutSession(checkout.id);
            throw new ComplimentaryCheckoutNotAllowedError();
        }
        return checkout;
    }
    throw new Error('Could not establish an active Stripe checkout session');
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

    const plan = hasLiveStripeContract(subscription.status)
        ? billingPlanForStripePriceId(priceId)
        : 'FREE';

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
                stripeCurrentPeriodStart:
                    subscriptionCurrentPeriodStart(subscription),
                stripeCurrentPeriodEnd:
                    subscriptionCurrentPeriodEnd(subscription),
                ...clearedCheckoutReservation(),
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

async function claimCheckoutReservation(args: {
    userId: string;
    plan: PaidBillingPlan;
    now: Date;
}): Promise<CheckoutClaim> {
    return runSerializableBillingUpdate(async (tx) => {
        const account = await reconcileBillingAccountInTransaction({
            tx,
            userId: args.userId,
            now: args.now,
        });
        assertCheckoutAllowed(account);

        const reservationIsActive =
            account.stripeCheckoutReservationId !== null &&
            account.stripeCheckoutExpiresAt !== null &&
            account.stripeCheckoutExpiresAt > args.now &&
            (account.stripeCheckoutSessionId !== null ||
                account.stripeCheckoutExpiresAt.getTime() -
                    args.now.getTime() >=
                    MIN_CHECKOUT_CREATION_WINDOW_MS);
        if (reservationIsActive) {
            if (account.stripeCheckoutPlan !== args.plan) {
                throw new CheckoutAlreadyInProgressError();
            }
            return {
                reservationId: account.stripeCheckoutReservationId!,
                sessionId: account.stripeCheckoutSessionId,
                customerId: account.stripeCustomerId,
                expiresAt: account.stripeCheckoutExpiresAt!,
                fence: {
                    plan: account.stripeCheckoutFencePlan ?? account.plan,
                    source:
                        account.stripeCheckoutFenceSource ?? account.planSource,
                },
            };
        }

        const reservationId = randomUUID();
        const expiresAt = new Date(
            args.now.getTime() + CHECKOUT_RESERVATION_TTL_MS
        );
        await tx.billingAccount.update({
            where: { userId: args.userId },
            data: {
                stripeCheckoutReservationId: reservationId,
                stripeCheckoutSessionId: null,
                stripeCheckoutPlan: args.plan,
                stripeCheckoutExpiresAt: expiresAt,
                stripeCheckoutFencePlan: account.plan,
                stripeCheckoutFenceSource: account.planSource,
            },
        });
        return {
            reservationId,
            sessionId: null,
            customerId: account.stripeCustomerId,
            expiresAt,
            fence: { plan: account.plan, source: account.planSource },
        };
    });
}

async function attachCheckoutCustomer(args: {
    userId: string;
    reservationId: string;
    customerId: string;
    fence: CheckoutEntitlementFence;
}) {
    const attached = await runSerializableBillingUpdate(async (tx) => {
        const account = await reconcileBillingAccountInTransaction({
            tx,
            userId: args.userId,
            now: new Date(),
        });
        if (!checkoutFenceMatches(account, args.fence)) return false;
        assertCheckoutAllowed(account);
        const result = await tx.billingAccount.updateMany({
            where: {
                userId: args.userId,
                stripeCheckoutReservationId: args.reservationId,
                stripeCheckoutSessionId: null,
                stripeCheckoutExpiresAt: { gt: new Date() },
                stripeCheckoutFencePlan: args.fence.plan,
                stripeCheckoutFenceSource: args.fence.source,
            },
            data: { stripeCustomerId: args.customerId },
        });
        return result.count === 1;
    });
    if (!attached) throw new ComplimentaryCheckoutNotAllowedError();
}

async function attachCheckoutSession(args: {
    userId: string;
    reservationId: string;
    sessionId: string;
    fence: CheckoutEntitlementFence;
}) {
    return runSerializableBillingUpdate(async (tx) => {
        const account = await reconcileBillingAccountInTransaction({
            tx,
            userId: args.userId,
            now: new Date(),
        });
        if (!checkoutFenceMatches(account, args.fence)) return false;
        try {
            assertCheckoutAllowed(account);
        } catch {
            return false;
        }
        if (
            account.stripeCheckoutReservationId === args.reservationId &&
            account.stripeCheckoutSessionId === args.sessionId
        ) {
            return true;
        }
        const result = await tx.billingAccount.updateMany({
            where: {
                userId: args.userId,
                stripeCheckoutReservationId: args.reservationId,
                stripeCheckoutSessionId: null,
                stripeCheckoutExpiresAt: { gt: new Date() },
                stripeCheckoutFencePlan: args.fence.plan,
                stripeCheckoutFenceSource: args.fence.source,
            },
            data: { stripeCheckoutSessionId: args.sessionId },
        });
        return result.count === 1;
    });
}

async function clearCheckoutReservation(
    userId: string,
    reservationId: string
) {
    await prisma.billingAccount.updateMany({
        where: { userId, stripeCheckoutReservationId: reservationId },
        data: clearedCheckoutReservation(),
    });
}

async function expireCheckoutSession(sessionId: string) {
    await getStripeClient().checkout.sessions.expire(sessionId);
}

function assertCheckoutAllowed(
    account: Pick<
        BillingAccount,
        'planSource' | 'stripeSubscriptionStatus'
    >
) {
    if (hasLiveStripeContract(account.stripeSubscriptionStatus)) {
        throw new ExistingSubscriptionRequiresPortalError();
    }
    if (
        account.planSource === 'ADMIN' ||
        account.planSource === 'COMPLIMENTARY'
    ) {
        throw new ComplimentaryCheckoutNotAllowedError();
    }
}

function checkoutFenceMatches(
    account: Pick<BillingAccount, 'plan' | 'planSource'>,
    fence: CheckoutEntitlementFence
) {
    return account.plan === fence.plan && account.planSource === fence.source;
}

function clearedCheckoutReservation() {
    return {
        stripeCheckoutReservationId: null,
        stripeCheckoutSessionId: null,
        stripeCheckoutPlan: null,
        stripeCheckoutExpiresAt: null,
        stripeCheckoutFencePlan: null,
        stripeCheckoutFenceSource: null,
    } satisfies Prisma.BillingAccountUpdateInput;
}

async function createStripeCustomer(args: {
    userId: string;
    email?: string | null;
}) {
    const customer = await getStripeClient().customers.create(
        {
            email: args.email ?? undefined,
            metadata: { userId: args.userId },
        },
        { idempotencyKey: `billing-customer:${args.userId}` }
    );
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

        const paid =
            args.stripePlan !== 'FREE' &&
            stripeSubscriptionProvidesAccess(args.subscriptionStatus);
        const becamePaid =
            paid &&
            (existing === null ||
                existing.stripePlan === 'FREE' ||
                !stripeSubscriptionProvidesAccess(
                    existing.stripeSubscriptionStatus
                ));
        const billingPeriodAdvanced =
            paid &&
            existing?.stripeCurrentPeriodEnd != null &&
            args.currentPeriodEnd != null &&
            args.currentPeriodEnd > existing.stripeCurrentPeriodEnd;
        const storedPeriodEnd = existing?.stripeCurrentPeriodEnd ?? null;
        const preserveStoredPeriod =
            storedPeriodEnd != null &&
            args.currentPeriodEnd != null &&
            args.currentPeriodEnd < storedPeriodEnd;
        const effectivePeriodEnd = preserveStoredPeriod
            ? storedPeriodEnd
            : args.currentPeriodEnd;
        const effectivePeriodStart = preserveStoredPeriod
            ? (existing?.stripeCurrentPeriodStart ?? args.currentPeriodStart)
            : args.currentPeriodStart;
        const data = {
            stripePlan: args.stripePlan,
            stripeCustomerId: args.customerId,
            stripeSubscriptionId: args.subscriptionId,
            stripeSubscriptionStatus: args.subscriptionStatus,
            stripePriceId: args.priceId,
            stripeCurrentPeriodStart: effectivePeriodStart,
            stripeCurrentPeriodEnd: effectivePeriodEnd,
            ...clearedCheckoutReservation(),
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
