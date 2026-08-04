import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { prisma } from '@/lib/prisma';
import { getOrCreateNotificationPreference } from '@/lib/notifications/service';

export const runtime = 'nodejs';
const MAX_BODY_BYTES = 32_768;

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) {
        return NextResponse.json({ error: 'Web Push is not configured' }, { status: 503 });
    }
    const parsed = await boundedJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status ?? 400 });
    const value = parsed.value;
    if (!isRecord(value) ||
        typeof value.endpoint !== 'string' ||
        value.endpoint.length > 8_192 ||
        !value.endpoint.startsWith('https://')
    ) {
        return NextResponse.json({ error: 'Invalid push subscription' }, { status: 400 });
    }
    const keys = value.keys;
    if (
        !isRecord(keys) ||
        typeof keys.p256dh !== 'string' ||
        typeof keys.auth !== 'string' ||
        keys.p256dh.length > 1_024 ||
        keys.auth.length > 1_024
    ) {
        return NextResponse.json({ error: 'Invalid push subscription keys' }, { status: 400 });
    }
    const p256dh = keys.p256dh as string;
    const authKey = keys.auth as string;
    const saved = await prisma.$transaction(async (tx) => {
        const existing = await tx.pushSubscription.findUnique({
            where: { endpoint: value.endpoint as string },
            select: { userId: true },
        });
        if (existing && existing.userId !== userId) return false;
        await tx.pushSubscription.upsert({
            where: { endpoint: value.endpoint as string },
            create: {
                userId,
                endpoint: value.endpoint as string,
                p256dh,
                auth: authKey,
                userAgent: req.headers.get('user-agent')?.slice(0, 1_000),
            },
            update: {
                userId,
                p256dh,
                auth: authKey,
                userAgent: req.headers.get('user-agent')?.slice(0, 1_000),
            },
        });
        await getOrCreateNotificationPreference(userId, tx);
        await tx.notificationPreference.update({
            where: { userId },
            data: { pushEnabled: true },
        });
        return true;
    });
    if (!saved) {
        return NextResponse.json(
            { error: 'Push subscription belongs to another account' },
            { status: 409 }
        );
    }
    return NextResponse.json({ subscribed: true });
}

export async function DELETE(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const endpoint = new URL(req.url).searchParams.get('endpoint');
    if (!endpoint || endpoint.length > 8_192) {
        return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }
    const result = await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    if ((await prisma.pushSubscription.count({ where: { userId } })) === 0) {
        await getOrCreateNotificationPreference(userId);
        await prisma.notificationPreference.update({ where: { userId }, data: { pushEnabled: false } });
    }
    return NextResponse.json({ deleted: result.count });
}
