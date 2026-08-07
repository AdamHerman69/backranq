import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import { createStripePortalSession } from '@/lib/services/stripeBilling';

export const runtime = 'nodejs';

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
                error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload Settings before opening billing.`,
            },
            { status: 409 }
        );
    }

    try {
        const portal = await createStripePortalSession(userId);
        return NextResponse.json({ id: portal.id, url: portal.url });
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : 'Could not create customer portal session',
            },
            { status: stripeConfigurationError(error) ? 503 : 500 }
        );
    }
}

function stripeConfigurationError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /not configured/i.test(message);
}
