import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isRecord } from '@/lib/api/validation';
import {
    CheckoutAlreadyInProgressError,
    ComplimentaryCheckoutNotAllowedError,
    ExistingSubscriptionRequiresPortalError,
    createStripeCheckoutSession,
    type PaidBillingPlan,
} from '@/lib/services/stripeBilling';

export const runtime = 'nodejs';

function requestedPlan(value: unknown): PaidBillingPlan | null {
    return value === 'PLUS' || value === 'PRO' ? value : null;
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as unknown;
    const plan = isRecord(body) ? requestedPlan(body.plan) : null;
    if (!plan) {
        return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });
    }

    try {
        const checkout = await createStripeCheckoutSession({
            userId,
            email: session.user?.email ?? null,
            plan,
        });
        return NextResponse.json({ id: checkout.id, url: checkout.url });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : 'Could not create checkout session',
            },
            {
                status:
                    error instanceof ComplimentaryCheckoutNotAllowedError ||
                    error instanceof ExistingSubscriptionRequiresPortalError ||
                    error instanceof CheckoutAlreadyInProgressError
                        ? 409
                        : stripeConfigurationError(error)
                          ? 503
                          : 500,
            }
        );
    }
}

function stripeConfigurationError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /not configured|price ID is not configured/i.test(message);
}
