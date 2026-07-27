import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { getStripeClient } from '@/lib/stripe';
import { prisma } from '@/lib/prisma';
import {
    applyStripeCheckoutSession,
    applyStripeSubscription,
    markStripeSubscriptionDeleted,
} from '@/lib/services/stripeBilling';

export const runtime = 'nodejs';

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

    try {
        const duplicate = await recordStripeWebhookProcessing(event);
        if (duplicate) {
            return NextResponse.json({ received: true, duplicate: true });
        }
        await handleStripeEvent(event);
        await markStripeWebhookSucceeded(event.id);
    } catch (error) {
        await markStripeWebhookFailed(event.id, error).catch(() => undefined);
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

async function recordStripeWebhookProcessing(event: Stripe.Event) {
    const existing = await prisma.stripeWebhookEvent.findUnique({
        where: { id: event.id },
        select: { status: true },
    });
    if (existing?.status === 'SUCCEEDED' || existing?.status === 'PROCESSING') {
        return true;
    }

    await prisma.stripeWebhookEvent.upsert({
        where: { id: event.id },
        update: {
            type: event.type,
            status: 'PROCESSING',
            attempts: { increment: 1 },
            lastError: null,
        },
        create: {
            id: event.id,
            type: event.type,
            status: 'PROCESSING',
        },
    });
    return false;
}

async function markStripeWebhookSucceeded(eventId: string) {
    await prisma.stripeWebhookEvent.update({
        where: { id: eventId },
        data: {
            status: 'SUCCEEDED',
            processedAt: new Date(),
            lastError: null,
        },
    });
}

async function markStripeWebhookFailed(eventId: string, error: unknown) {
    await prisma.stripeWebhookEvent.update({
        where: { id: eventId },
        data: {
            status: 'FAILED',
            lastError:
                error instanceof Error
                    ? error.message.slice(0, 2_000)
                    : String(error).slice(0, 2_000),
        },
    });
}

async function handleStripeEvent(event: Stripe.Event) {
    switch (event.type) {
        case 'checkout.session.completed':
            await applyStripeCheckoutSession(
                event.data.object as Stripe.Checkout.Session
            );
            return;
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
            await applyStripeSubscription(event.data.object as Stripe.Subscription);
            return;
        case 'customer.subscription.deleted':
            await markStripeSubscriptionDeleted(
                event.data.object as Stripe.Subscription
            );
            return;
        case 'invoice.paid':
        case 'invoice.payment_failed':
            await syncSubscriptionFromInvoice(event.data.object as Stripe.Invoice);
            return;
        default:
            return;
    }
}

async function syncSubscriptionFromInvoice(invoice: Stripe.Invoice) {
    const subscriptionId =
        (invoice as unknown as { subscription?: string | { id: string } | null })
            .subscription ?? null;
    if (!subscriptionId) return;
    const id =
        typeof subscriptionId === 'string' ? subscriptionId : subscriptionId.id;
    const subscription = await getStripeClient().subscriptions.retrieve(id, {
        expand: ['items.data.price'],
    });
    await applyStripeSubscription(subscription);
}
