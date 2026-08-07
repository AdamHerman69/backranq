import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { Prisma } from '@prisma/client';
import { getStripeClient } from '@/lib/stripe';
import { prisma } from '@/lib/prisma';
import {
    applyStripeCheckoutSession,
    applyStripeSubscription,
    markStripeSubscriptionDeleted,
} from '@/lib/services/stripeBilling';
import { recordBillingNotification } from '@/lib/notifications/service';
import { dispatchPendingNotificationDeliveries } from '@/lib/notifications/delivery';
import { stripeSubscriptionRequiresAction } from '@/lib/billing/stripeContract';

export const runtime = 'nodejs';
const STRIPE_WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1_000;

export async function POST(req: Request) {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
        return NextResponse.json(
            { error: 'Stripe webhook is not configured' },
            { status: 500 }
        );
    }

    const signature = req.headers.get('stripe-signature');
    if (!signature) {
        return NextResponse.json(
            { error: 'Missing stripe-signature header' },
            { status: 400 }
        );
    }

    const rawBody = await req.text();
    let event: Stripe.Event;
    try {
        event = getStripeClient().webhooks.constructEvent(
            rawBody,
            signature,
            webhookSecret
        );
    } catch {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    let processingToken: string | null = null;
    try {
        const claim = await claimStripeWebhookEvent(event);
        if (claim.state === 'succeeded') {
            return NextResponse.json({ received: true, duplicate: true });
        }
        if (claim.state === 'processing') {
            return NextResponse.json(
                { error: 'Stripe webhook is already being processed' },
                { status: 503 }
            );
        }
        processingToken = claim.processingToken;
        await handleStripeEvent(event);
        const marked = await markStripeWebhookSucceeded(
            event.id,
            processingToken
        );
        if (!marked) {
            throw new Error('Stripe webhook processing lease was lost');
        }
    } catch (error) {
        if (processingToken) {
            await markStripeWebhookFailed(
                event.id,
                processingToken,
                error
            ).catch(() => undefined);
        }
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : 'Stripe webhook handler failed',
            },
            { status: 500 }
        );
    }

    return NextResponse.json({ received: true });
}

async function claimStripeWebhookEvent(event: Stripe.Event) {
    const now = new Date();
    const processingToken = crypto.randomUUID();
    const processingUntil = new Date(
        now.getTime() + STRIPE_WEBHOOK_PROCESSING_LEASE_MS
    );
    try {
        await prisma.stripeWebhookEvent.create({
            data: {
                id: event.id,
                type: event.type,
                status: 'PROCESSING',
                processingToken,
                processingUntil,
            },
        });
        return { state: 'claimed' as const, processingToken };
    } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
    }

    const takeover = await prisma.stripeWebhookEvent.updateMany({
        where: {
            id: event.id,
            OR: [
                { status: 'FAILED' },
                {
                    status: 'PROCESSING',
                    OR: [
                        { processingUntil: null },
                        { processingUntil: { lt: now } },
                    ],
                },
            ],
        },
        data: {
            type: event.type,
            status: 'PROCESSING',
            attempts: { increment: 1 },
            lastError: null,
            processedAt: null,
            processingToken,
            processingUntil,
        },
    });
    if (takeover.count === 1) {
        return { state: 'claimed' as const, processingToken };
    }

    const existing = await prisma.stripeWebhookEvent.findUnique({
        where: { id: event.id },
        select: { status: true },
    });
    return existing?.status === 'SUCCEEDED'
        ? { state: 'succeeded' as const }
        : { state: 'processing' as const };
}

async function markStripeWebhookSucceeded(
    eventId: string,
    processingToken: string
) {
    const result = await prisma.stripeWebhookEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING', processingToken },
        data: {
            status: 'SUCCEEDED',
            processedAt: new Date(),
            lastError: null,
            processingToken: null,
            processingUntil: null,
        },
    });
    return result.count === 1;
}

async function markStripeWebhookFailed(
    eventId: string,
    processingToken: string,
    error: unknown
) {
    await prisma.stripeWebhookEvent.updateMany({
        where: { id: eventId, status: 'PROCESSING', processingToken },
        data: {
            status: 'FAILED',
            processingToken: null,
            processingUntil: null,
            lastError:
                error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : String(error).slice(0, 2_000),
        },
    });
}

async function handleStripeEvent(event: Stripe.Event) {
    const eventFence = {
        eventId: event.id,
        eventCreatedAt: new Date(event.created * 1_000),
    };
    switch (event.type) {
        case 'checkout.session.completed':
            await applyStripeCheckoutSession(
                event.data.object as Stripe.Checkout.Session,
                eventFence
            );
            return;
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
            const eventSubscription =
                event.data.object as Stripe.Subscription;
            const currentSubscription =
                await getStripeClient().subscriptions.retrieve(
                    eventSubscription.id,
                    { expand: ['items.data.price'] }
                );
            await applyStripeSubscription(currentSubscription, eventFence);
            return;
        }
        case 'customer.subscription.deleted':
            await markStripeSubscriptionDeleted(
                event.data.object as Stripe.Subscription,
                eventFence
            );
            return;
        case 'invoice.paid':
            await syncSubscriptionFromInvoice(
                event.data.object as Stripe.Invoice,
                eventFence
            );
            return;
        case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            const applied = await syncSubscriptionFromInvoice(
                invoice,
                eventFence
            );
            if (
                applied?.applied &&
                stripeSubscriptionRequiresAction(
                    applied.subscriptionStatus
                )
            ) {
                await recordBillingNotification({
                    userId: applied.userId,
                    eventId: event.id,
                    type: 'BILLING_ACTION_REQUIRED',
                    title: 'Your Backranq payment failed',
                    body: 'Your paid subscription needs attention. Open billing settings to review it.',
                });
                await dispatchPendingNotificationDeliveries().catch(
                    (notificationError) => {
                        console.error(
                            '[notifications] delivery wakeup failed',
                            notificationError
                        );
                    }
                );
            }
            return;
        }
        default:
            return;
    }
}

async function syncSubscriptionFromInvoice(
    invoice: Stripe.Invoice,
    eventFence: {
        eventId: string;
        eventCreatedAt: Date;
    }
) {
    const subscriptionId =
        (invoice as unknown as { subscription?: string | { id: string } | null })
            .subscription ?? null;
    if (!subscriptionId) return null;
    const id =
        typeof subscriptionId === 'string' ? subscriptionId : subscriptionId.id;
    const subscription = await getStripeClient().subscriptions.retrieve(id, {
        expand: ['items.data.price'],
    });
    return applyStripeSubscription(subscription, eventFence);
}

function isUniqueConstraintError(error: unknown) {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
    ) || (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2002'
    );
}
