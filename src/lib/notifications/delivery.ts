import { Resend } from 'resend';
import webpush from 'web-push';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import NotificationEmail from '@/emails/NotificationEmail';
import { notificationCopy } from './contracts';
import { createUnsubscribeToken } from './tokens';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';

const DELIVERY_LEASE_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const OPTIONAL_EMAIL_TYPES = new Set([
    'PRACTICE_READY',
    'ANALYSIS_FAILED',
    'SYNC_FAILED',
    'NEW_GAMES_SYNCED',
    'WEEKLY_PROGRESS',
    'PRODUCT_NEWS',
]);

type HydratedDelivery = Prisma.NotificationDeliveryGetPayload<{
    include: {
        notification: true;
        user: { select: { id: true; email: true } };
    };
}>;

function appUrl() {
    const raw =
        process.env.BACKRANQ_APP_URL ??
        process.env.NEXTAUTH_URL ??
        (process.env.VERCEL_PROJECT_PRODUCTION_URL
            ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
            : 'http://localhost:3000');
    return raw.replace(/\/$/, '');
}

function emailConfigured() {
    return !!process.env.RESEND_API_KEY && !!process.env.BACKRANQ_EMAIL_FROM;
}

function pushConfigured() {
    return !!(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY &&
        process.env.VAPID_SUBJECT
    );
}

function resendClient() {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY is not configured');
    return new Resend(key);
}

function configureWebPush() {
    if (!pushConfigured()) throw new Error('Web Push VAPID keys are not configured');
    webpush.setVapidDetails(
        process.env.VAPID_SUBJECT!,
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!
    );
}

export async function dispatchPendingNotificationDeliveries(limit = 50) {
    if (!emailConfigured() && !pushConfigured()) return [];
    const now = new Date();
    await prisma.notificationDelivery.updateMany({
        where: {
            status: 'PROCESSING',
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: { status: 'PENDING', lockedUntil: null },
    });
    const deliveries = await prisma.notificationDelivery.findMany({
        where: {
            status: 'PENDING',
            scheduledFor: { lte: now },
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        take: Math.max(1, Math.min(limit, 100)),
        select: {
            id: true,
            channel: true,
            attempts: true,
            scheduledFor: true,
        },
    });
    const results = [];
    for (const delivery of deliveries) {
        if (delivery.channel === 'EMAIL' && !emailConfigured()) continue;
        if (delivery.channel === 'WEB_PUSH' && !pushConfigured()) continue;
        const published = await publishBackranqQueueMessage(
            { type: 'notification-delivery', deliveryId: delivery.id },
            {
                idempotencyKey: `notification-delivery:${delivery.id}:${delivery.attempts}:${delivery.scheduledFor.toISOString()}`,
            }
        );
        if (!published.queued && process.env.NODE_ENV !== 'production') {
            await processNotificationDelivery(delivery.id);
        }
        results.push({ deliveryId: delivery.id, queued: published.queued });
    }
    return results;
}

export async function processNotificationDelivery(deliveryId: string) {
    const now = new Date();
    const claimed = await prisma.notificationDelivery.updateMany({
        where: {
            id: deliveryId,
            status: 'PENDING',
            scheduledFor: { lte: now },
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: {
            status: 'PROCESSING',
            attempts: { increment: 1 },
            lockedUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
            lastError: null,
        },
    });
    if (claimed.count !== 1) return { status: 'SKIPPED' as const };

    const delivery = await prisma.notificationDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
        include: {
            notification: true,
            user: { select: { id: true, email: true } },
        },
    });
    try {
        const providerMessageId =
            delivery.channel === 'EMAIL'
                ? await deliverEmail(delivery)
                : await deliverWebPush(delivery);
        await prisma.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
                status: 'SENT',
                providerMessageId,
                sentAt: new Date(),
                lockedUntil: null,
                lastError: null,
            },
        });
        return { status: 'SENT' as const, providerMessageId };
    } catch (error) {
        const terminal = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
        const message = error instanceof Error ? error.message : String(error);
        await prisma.notificationDelivery.update({
            where: { id: delivery.id },
            data: {
                status: terminal ? 'FAILED' : 'PENDING',
                scheduledFor: new Date(
                    Date.now() + Math.min(60, 2 ** delivery.attempts) * 60_000
                ),
                lockedUntil: null,
                lastError: message.slice(0, 2_000),
            },
        });
        throw error;
    }
}

async function deliverEmail(delivery: HydratedDelivery) {
    const recipient = delivery.recipient ?? delivery.user.email;
    const from = process.env.BACKRANQ_EMAIL_FROM;
    if (!recipient || !from) throw new Error('Email recipient or sender is missing');
    const copy = notificationCopy(delivery.notification);
    const base = appUrl();
    const optional = OPTIONAL_EMAIL_TYPES.has(delivery.notification.type);
    const unsubscribeUrl = optional
        ? `${base}/api/notifications/unsubscribe?token=${encodeURIComponent(
              createUnsubscribeToken(delivery.userId)
          )}`
        : undefined;
    const actionUrl = `${base}${delivery.notification.href ?? '/home'}`;
    const headers = {
        ...(unsubscribeUrl
            ? {
                  'List-Unsubscribe': `<${unsubscribeUrl}>`,
                  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
              }
            : {}),
        ...(delivery.notification.type === 'PRACTICE_READY'
            ? { Importance: 'low', 'X-Priority': '5' }
            : {}),
    };
    const response = await resendClient().emails.send(
        {
            from,
            to: recipient,
            subject: copy.title,
            react: NotificationEmail({
                preview: copy.body,
                heading: copy.title,
                body: copy.body,
                actionLabel:
                    delivery.notification.type === 'PRACTICE_READY'
                        ? 'Start practicing'
                        : 'Open Backranq',
                actionUrl,
                settingsUrl: `${base}/settings#notifications`,
                unsubscribeUrl,
            }),
            headers: Object.keys(headers).length > 0 ? headers : undefined,
        },
        { idempotencyKey: `notification-${delivery.id}` }
    );
    if (response.error || !response.data?.id) {
        throw new Error(response.error?.message ?? 'Email provider returned no id');
    }
    return response.data.id;
}

async function deliverWebPush(delivery: HydratedDelivery) {
    configureWebPush();
    const subscriptions = await prisma.pushSubscription.findMany({
        where: { userId: delivery.userId },
    });
    if (subscriptions.length === 0) throw new Error('No Web Push subscription');
    const copy = notificationCopy(delivery.notification);
    let sent = 0;
    for (const subscription of subscriptions) {
        try {
            await webpush.sendNotification(
                {
                    endpoint: subscription.endpoint,
                    keys: { p256dh: subscription.p256dh, auth: subscription.auth },
                },
                JSON.stringify({
                    title: copy.title,
                    body: copy.body,
                    href: delivery.notification.href ?? '/home',
                    notificationId: delivery.notification.id,
                })
            );
            sent += 1;
        } catch (error) {
            const statusCode = (error as { statusCode?: number }).statusCode;
            if (statusCode === 404 || statusCode === 410) {
                await prisma.pushSubscription.delete({
                    where: { id: subscription.id },
                });
                continue;
            }
            throw error;
        }
    }
    if (sent === 0) throw new Error('No active Web Push subscriptions');
    return null;
}
