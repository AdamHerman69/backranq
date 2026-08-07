import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import {
    CheckoutAlreadyInProgressError,
    ComplimentaryCheckoutNotAllowedError,
    ExistingSubscriptionRequiresPortalError,
    createStripeCheckoutSession,
    type PaidBillingPlan,
} from '@/lib/services/stripeBilling';

export const runtime = 'nodejs';
const MAX_CHECKOUT_BODY_BYTES = 128;

function requestedPlan(value: unknown): PaidBillingPlan | null {
    return value === 'PLUS' || value === 'PRO' ? value : null;
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (expectedOwnerId(req) !== userId) {
        return NextResponse.json(
            {
                code: 'OWNER_MISMATCH',
                error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload Settings before starting checkout.`,
            },
            { status: 409 }
        );
    }

    const parsedBody = await boundedJsonBody(req, MAX_CHECKOUT_BODY_BYTES);
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error, code: 'INVALID_CHECKOUT_REQUEST' },
            { status: parsedBody.status ?? 400 }
        );
    }
    const body = parsedBody.value;
    const plan =
        isRecord(body) &&
        Object.keys(body).length === 1 &&
        Object.hasOwn(body, 'plan')
            ? requestedPlan(body.plan)
            : null;
    if (!plan) {
        return NextResponse.json(
            { error: 'Invalid plan', code: 'INVALID_CHECKOUT_REQUEST' },
            { status: 400 }
        );
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
