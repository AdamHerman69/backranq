import { NextResponse } from 'next/server';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { prisma } from '@/lib/prisma';
import { recordNotification } from '@/lib/notifications/service';
import { dispatchPendingNotificationDeliveries } from '@/lib/notifications/delivery';

export const runtime = 'nodejs';
export const maxDuration = 60;
const MAX_BODY_BYTES = 64_000;

export async function POST(req: Request) {
    const secret = process.env.BACKRANQ_ADMIN_API_SECRET;
    if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const parsed = await boundedJsonBody(req, MAX_BODY_BYTES);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: parsed.status ?? 400 });
    const body = parsed.value;
    if (
        !isRecord(body) ||
        typeof body.campaignId !== 'string' ||
        !/^[a-z0-9][a-z0-9_-]{2,63}$/i.test(body.campaignId) ||
        typeof body.title !== 'string' ||
        body.title.length < 1 ||
        body.title.length > 160 ||
        typeof body.body !== 'string' ||
        body.body.length < 1 ||
        body.body.length > 5_000 ||
        typeof body.href !== 'string' ||
        body.href.length > 2_048 ||
        !body.href.startsWith('/') ||
        body.href.startsWith('//') ||
        /[\r\n]/.test(body.href)
    ) {
        return NextResponse.json({ error: 'Invalid campaign' }, { status: 400 });
    }
    const cursor = typeof body.cursor === 'string' ? body.cursor : undefined;
    const recipients = await prisma.user.findMany({
        where: {
            ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 501,
        select: { id: true },
    });
    const page = recipients.slice(0, 500);
    for (const recipient of page) {
        await recordNotification({
            userId: recipient.id,
            type: 'PRODUCT_NEWS',
            title: body.title,
            body: body.body,
            href: body.href,
            dedupeKey: `product-news:${body.campaignId}:${recipient.id}`,
            metadata: { campaignId: body.campaignId },
            email: true,
            push: false,
        });
    }
    const deliveries = await dispatchPendingNotificationDeliveries(100);
    return NextResponse.json({
        created: page.length,
        deliveriesQueued: deliveries.length,
        nextCursor: recipients.length > 500 ? page.at(-1)?.id ?? null : null,
    });
}
