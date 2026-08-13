import { NextResponse } from 'next/server';
import { ECDH } from 'node:crypto';
import { auth } from '@/lib/auth';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import {
    deletePushSubscription,
    savePushSubscription,
} from '@/lib/notifications/pushSubscriptions';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 32_768;
const MAX_SUBSCRIPTIONS_PER_USER = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_REQUESTS = 20;
const mutationBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(userId: string) {
    const now = Date.now();
    const current = mutationBuckets.get(userId);
    if (!current || current.resetAt <= now) {
        mutationBuckets.set(userId, {
            count: 1,
            resetAt: now + RATE_LIMIT_WINDOW_MS,
        });
        return false;
    }
    current.count += 1;
    return current.count > RATE_LIMIT_REQUESTS;
}

function isAllowedPushEndpoint(value: string) {
    if (value.length > 8_192) return false;
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.hash
    ) {
        return false;
    }
    const hostname = url.hostname.toLowerCase();
    return (
        hostname === 'fcm.googleapis.com' ||
        hostname === 'android.googleapis.com' ||
        hostname === 'updates.push.services.mozilla.com' ||
        hostname === 'push.services.mozilla.com' ||
        hostname === 'web.push.apple.com' ||
        hostname.endsWith('.push.apple.com') ||
        hostname.endsWith('.notify.windows.com')
    );
}

function decodeBase64Url(value: string, byteLength: number) {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
    try {
        const decoded = Buffer.from(value, 'base64url');
        return decoded.length === byteLength ? decoded : false;
    } catch {
        return false;
    }
}

function isValidP256dh(value: string) {
    const decoded = decodeBase64Url(value, 65);
    if (!decoded) return false;
    try {
        ECDH.convertKey(decoded, 'prime256v1');
        return true;
    } catch {
        return false;
    }
}

function tooManyRequests() {
    return NextResponse.json(
        { error: 'Too many push subscription requests' },
        { status: 429, headers: { 'Retry-After': '60' } }
    );
}

function ownerMismatch() {
    return NextResponse.json(
        {
            error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload Settings before changing Web Push.`,
        },
        { status: 409 }
    );
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (expectedOwnerId(req) !== userId) return ownerMismatch();
    if (rateLimited(userId)) return tooManyRequests();
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
        return NextResponse.json({ error: 'Web Push is not configured' }, { status: 503 });
    }
    const parsed = await boundedJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status ?? 400 });
    const value = parsed.value;
    if (!isRecord(value) ||
        typeof value.endpoint !== 'string' ||
        !isAllowedPushEndpoint(value.endpoint)
    ) {
        return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
    }
    const keys = value.keys;
    if (
        !isRecord(keys) ||
        typeof keys.p256dh !== 'string' ||
        typeof keys.auth !== 'string' ||
        !isValidP256dh(keys.p256dh) ||
        !decodeBase64Url(keys.auth, 16)
    ) {
        return NextResponse.json({ error: 'Invalid push subscription keys' }, { status: 400 });
    }
    const p256dh = keys.p256dh as string;
    const authKey = keys.auth as string;
    const saved = await savePushSubscription({
        userId,
        endpoint: value.endpoint,
        p256dh,
        auth: authKey,
        userAgent: req.headers.get('user-agent')?.slice(0, 1_000) ?? null,
        maxSubscriptions: MAX_SUBSCRIPTIONS_PER_USER,
    });
    if (saved === 'owner-conflict') {
        return NextResponse.json(
            { error: 'Push subscription belongs to another account' },
            { status: 409 }
        );
    }
    if (saved === 'limit') {
        return NextResponse.json(
            { error: 'Push subscription limit reached' },
            { status: 409 }
        );
    }
    return NextResponse.json({ ownerId: userId, subscribed: true });
}

export async function DELETE(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (expectedOwnerId(req) !== userId) return ownerMismatch();
    if (rateLimited(userId)) return tooManyRequests();
    const endpoint = new URL(req.url).searchParams.get('endpoint');
    if (!endpoint || !isAllowedPushEndpoint(endpoint)) {
        return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }
    return NextResponse.json({
        ownerId: userId,
        ...(await deletePushSubscription({ userId, endpoint })),
    });
}
