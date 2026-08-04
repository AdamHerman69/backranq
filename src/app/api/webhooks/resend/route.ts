import { NextResponse } from 'next/server';
import { Resend } from 'resend';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
const MAX_WEBHOOK_BODY_BYTES = 256_000;

export async function POST(req: Request) {
    const key = process.env.RESEND_API_KEY;
    const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
    if (!key || !webhookSecret) {
        return NextResponse.json({ error: 'Resend webhook is not configured' }, { status: 503 });
    }
    const contentLength = Number(req.headers.get('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    const payload = await req.text();
    if (Buffer.byteLength(payload, 'utf8') > MAX_WEBHOOK_BODY_BYTES) {
        return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
    }
    let event: ReturnType<Resend['webhooks']['verify']>;
    try {
        event = new Resend(key).webhooks.verify({
            payload,
            headers: {
                id: req.headers.get('svix-id') ?? '',
                timestamp: req.headers.get('svix-timestamp') ?? '',
                signature: req.headers.get('svix-signature') ?? '',
            },
            webhookSecret,
        });
    } catch {
        return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }
    const data = event.data as unknown as { email_id?: string; to?: string[] };
    const providerMessageId = data.email_id;
    if (!providerMessageId) return NextResponse.json({ received: true });
    let mapping:
        | { status: 'DELIVERED'; deliveredAt: Date }
        | { status: 'BOUNCED' | 'COMPLAINED' | 'SUPPRESSED' | 'FAILED' }
        | null = null;
    switch (event.type) {
        case 'email.delivered':
            mapping = { status: 'DELIVERED', deliveredAt: new Date() };
            break;
        case 'email.bounced':
            mapping = { status: 'BOUNCED' };
            break;
        case 'email.complained':
            mapping = { status: 'COMPLAINED' };
            break;
        case 'email.suppressed':
            mapping = { status: 'SUPPRESSED' };
            break;
        case 'email.failed':
            mapping = { status: 'FAILED' };
            break;
    }
    if (!mapping) return NextResponse.json({ received: true });
    const delivery = await prisma.notificationDelivery.findUnique({
        where: { providerMessageId },
        select: { userId: true },
    });
    if (delivery) {
        await prisma.$transaction(async (tx) => {
            await tx.notificationDelivery.update({
                where: { providerMessageId },
                data: mapping,
            });
            if (['BOUNCED', 'COMPLAINED', 'SUPPRESSED'].includes(mapping.status)) {
                await tx.notificationPreference.upsert({
                    where: { userId: delivery.userId },
                    create: { userId: delivery.userId, emailSuppressedAt: new Date() },
                    update: { emailSuppressedAt: new Date() },
                });
                await tx.notificationDelivery.updateMany({
                    where: { userId: delivery.userId, channel: 'EMAIL', status: 'PENDING' },
                    data: { status: 'SUPPRESSED' },
                });
            }
        });
    }
    return NextResponse.json({ received: true });
}
