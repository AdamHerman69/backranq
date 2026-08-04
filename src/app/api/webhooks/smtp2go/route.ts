import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
const MAX_WEBHOOK_BODY_BYTES = 256_000;
const OPTIONAL_TYPES = [
    'PRACTICE_READY',
    'ANALYSIS_FAILED',
    'SYNC_FAILED',
    'NEW_GAMES_SYNCED',
    'WEEKLY_PROGRESS',
    'PRODUCT_NEWS',
] as const;

type Smtp2GoWebhook = {
    event?: string;
    email_id?: string;
    bounce?: string;
    'X-Backranq-Delivery-Id'?: string;
    'x-backranq-delivery-id'?: string;
};

export async function POST(req: Request) {
    const webhookSecret = process.env.SMTP2GO_WEBHOOK_SECRET;
    if (!webhookSecret) {
        return NextResponse.json(
            { error: 'SMTP2GO webhook is not configured' },
            { status: 503 }
        );
    }
    if (!authorized(req.headers.get('authorization'), webhookSecret)) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const contentLength = Number(req.headers.get('content-length') ?? 0);
    if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_WEBHOOK_BODY_BYTES
    ) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    let event: Smtp2GoWebhook;
    try {
        event = JSON.parse(raw) as Smtp2GoWebhook;
    } catch {
        return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }
    if (!event.event) {
        return NextResponse.json({ received: true });
    }

    const hardBounce =
        event.event === 'bounce' && event.bounce?.toLowerCase() !== 'soft';
    const mapping = deliveryMapping(event.event, hardBounce);
    if (!mapping) return NextResponse.json({ received: true });

    const backranqDeliveryId =
        event['X-Backranq-Delivery-Id'] ?? event['x-backranq-delivery-id'];
    const delivery = event.email_id
        ? await prisma.notificationDelivery.findUnique({
              where: { providerMessageId: event.email_id },
              select: { id: true, userId: true, status: true },
          })
        : null;
    const resolvedDelivery =
        delivery ??
        (backranqDeliveryId
            ? await prisma.notificationDelivery.findUnique({
                  where: { id: backranqDeliveryId },
                  select: { id: true, userId: true, status: true },
              })
            : null);
    if (!resolvedDelivery) return NextResponse.json({ received: true });

    await prisma.$transaction(async (tx) => {
        await tx.notificationDelivery.updateMany({
            where: {
                id: resolvedDelivery.id,
                status: { in: statusesPreceding(mapping.status) },
            },
            data: {
                ...mapping,
                ...(!delivery
                    ? {
                          sentAt: new Date(),
                          ...(event.email_id
                              ? { providerMessageId: event.email_id }
                              : {}),
                      }
                    : {}),
            },
        });
        if (hardBounce || event.event === 'spam') {
            await tx.notificationPreference.upsert({
                where: { userId: resolvedDelivery.userId },
                create: {
                    userId: resolvedDelivery.userId,
                    emailSuppressedAt: new Date(),
                },
                update: { emailSuppressedAt: new Date() },
            });
            await tx.notificationDelivery.updateMany({
                where: {
                    userId: resolvedDelivery.userId,
                    channel: 'EMAIL',
                    status: 'PENDING',
                },
                data: { status: 'SUPPRESSED' },
            });
        } else if (event.event === 'unsubscribe') {
            await tx.notificationPreference.upsert({
                where: { userId: resolvedDelivery.userId },
                create: {
                    userId: resolvedDelivery.userId,
                    emailPracticeReady: false,
                    emailAnalysisFailed: false,
                    emailSyncSummary: false,
                    emailWeeklyProgress: false,
                    emailProductNews: false,
                    optionalEmailsUnsubscribedAt: new Date(),
                },
                update: {
                    emailPracticeReady: false,
                    emailAnalysisFailed: false,
                    emailSyncSummary: false,
                    emailWeeklyProgress: false,
                    emailProductNews: false,
                    optionalEmailsUnsubscribedAt: new Date(),
                },
            });
            await tx.notificationDelivery.updateMany({
                where: {
                    userId: resolvedDelivery.userId,
                    channel: 'EMAIL',
                    status: 'PENDING',
                    notification: { type: { in: [...OPTIONAL_TYPES] } },
                },
                data: { status: 'CANCELLED' },
            });
        }
    });
    return NextResponse.json({ received: true });
}

const STATUS_PRECEDENCE = {
    PENDING: 0,
    PROCESSING: 0,
    SENT: 1,
    FAILED: 2,
    DELIVERED: 3,
    BOUNCED: 4,
    COMPLAINED: 5,
    SUPPRESSED: 5,
    CANCELLED: 5,
} as const;

function statusesPreceding(incoming: keyof typeof STATUS_PRECEDENCE) {
    const incomingPrecedence = STATUS_PRECEDENCE[incoming];
    return (Object.keys(STATUS_PRECEDENCE) as Array<keyof typeof STATUS_PRECEDENCE>).filter(
        (status) => STATUS_PRECEDENCE[status] < incomingPrecedence
    );
}

function authorized(header: string | null, secret: string) {
    if (!header) return false;
    const actual = Buffer.from(header);
    const expected = Buffer.from(`Bearer ${secret}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function deliveryMapping(event: string, hardBounce: boolean) {
    switch (event) {
        case 'delivered':
            return { status: 'DELIVERED' as const, deliveredAt: new Date() };
        case 'bounce':
            return { status: hardBounce ? ('BOUNCED' as const) : ('FAILED' as const) };
        case 'spam':
            return { status: 'COMPLAINED' as const };
        case 'unsubscribe':
            return { status: 'SUPPRESSED' as const };
        case 'reject':
            return { status: 'FAILED' as const };
        default:
            return null;
    }
}
