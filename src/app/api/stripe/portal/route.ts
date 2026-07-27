import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createStripePortalSession } from '@/lib/services/stripeBilling';

export const runtime = 'nodejs';

export async function POST() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
