import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { consumeProviderProxyRateLimit } from '@/lib/api/providerProxyRateLimit';
import {
    lookupProviderProfile,
    type ProfileProvider,
} from '@/lib/providers/profileLookup';

export const runtime = 'nodejs';

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const provider = url.searchParams.get('provider');
    const username = (url.searchParams.get('username') ?? '').trim();

    if (provider !== 'lichess' && provider !== 'chesscom') {
        return NextResponse.json(
            { error: 'Invalid provider' },
            { status: 400 }
        );
    }
    if (!username) {
        return NextResponse.json({ ok: true, exists: true });
    }
    const rateLimit = await consumeProviderProxyRateLimit({
        request: req,
        userId,
        operation: 'profile',
    });
    if (!rateLimit.allowed) {
        return NextResponse.json(
            {
                ok: false,
                retryable: true,
                error: 'Too many provider lookups. Try again shortly.',
            },
            {
                status: 429,
                headers: {
                    'Retry-After': String(rateLimit.retryAfterSeconds),
                },
            }
        );
    }

    const lookup = await lookupProviderProfile({
        provider: provider as ProfileProvider,
        username,
    });
    if (lookup.state === 'found') {
        return NextResponse.json({ ok: true, exists: true });
    }
    if (lookup.state === 'not-found') {
        return NextResponse.json({ ok: true, exists: false });
    }
    return NextResponse.json(
        {
            ok: false,
            retryable: true,
            error: lookup.error,
            sourceStatus: lookup.sourceStatus,
        },
        { status: lookup.httpStatus }
    );
}
