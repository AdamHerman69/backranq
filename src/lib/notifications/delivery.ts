import webpush from 'web-push';
import { render } from 'react-email';
import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import NotificationEmail from '@/emails/NotificationEmail';
import { notificationCopy } from './contracts';
import { createUnsubscribeToken } from './tokens';
import {
    sendSmtp2GoEmail,
    Smtp2GoAmbiguousSendError,
    Smtp2GoQuotaError,
} from './smtp2go';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';

const DELIVERY_LEASE_MS = 5 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_SMTP2GO_DAILY_SEND_LIMIT = 30;
const DEFAULT_SMTP2GO_EMAILS_PER_DISPATCH = 20;
const DEFAULT_SMTP2GO_TRANSACTIONAL_RESERVE = 5;
const MAX_NOTIFICATION_SWEEP_DELAY_SECONDS = 6 * 24 * 60 * 60;
const NOTIFICATION_SWEEP_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const PRIORITY_EMAIL_TYPES = new Set<NotificationType>([
    'LOW_CREDITS',
    'BILLING_ACTION_REQUIRED',
]);
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

class DeliveryCancelledError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DeliveryCancelledError';
    }
}

class DeliveryRescheduledError extends Error {
    readonly scheduledFor: Date;

    constructor(message: string, scheduledFor: Date) {
        super(message);
        this.name = 'DeliveryRescheduledError';
        this.scheduledFor = scheduledFor;
    }
}

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
    return !!process.env.SMTP2GO_API_KEY && !!process.env.BACKRANQ_EMAIL_FROM;
}

function pushConfigured() {
    return !!(
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY &&
        process.env.VAPID_PRIVATE_KEY &&
        process.env.VAPID_SUBJECT
    );
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
    const take = Math.max(1, Math.min(limit, 100));
    const pendingWhere: Prisma.NotificationDeliveryWhereInput = {
            status: 'PENDING',
            scheduledFor: { lte: now },
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        };
    const priorityDeliveries = await prisma.notificationDelivery.findMany({
        where: {
            ...pendingWhere,
            channel: 'EMAIL',
            notification: { type: { in: [...PRIORITY_EMAIL_TYPES] } },
        },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        take,
        select: {
            id: true,
            channel: true,
            attempts: true,
            scheduledFor: true,
            notification: { select: { type: true } },
        },
    });
    const deliveries = [
        ...priorityDeliveries,
        ...(priorityDeliveries.length < take
            ? await prisma.notificationDelivery.findMany({
                  where: {
                      ...pendingWhere,
                      id: { notIn: priorityDeliveries.map((delivery) => delivery.id) },
                  },
                  orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
                  take: take - priorityDeliveries.length,
                  select: {
                      id: true,
                      channel: true,
                      attempts: true,
                      scheduledFor: true,
                      notification: { select: { type: true } },
                  },
              })
            : []),
    ];
    const results = [];
    const maxEmailsThisDispatch = positiveIntegerEnv(
        'SMTP2GO_EMAILS_PER_DISPATCH',
        DEFAULT_SMTP2GO_EMAILS_PER_DISPATCH
    );
    const sentToday = await emailsSentToday();
    const dailyEmailRemaining = Math.max(0, smtp2GoDailySendLimit() - sentToday);
    const optionalEmailRemaining = Math.max(
        0,
        smtp2GoDailySendLimit() - smtp2GoTransactionalReserve() - sentToday
    );
    let emailBudget = Math.min(maxEmailsThisDispatch, dailyEmailRemaining);
    let optionalEmailBudget = Math.min(
        maxEmailsThisDispatch,
        optionalEmailRemaining
    );
    for (const delivery of deliveries) {
        if (delivery.channel === 'EMAIL' && !emailConfigured()) continue;
        if (delivery.channel === 'WEB_PUSH' && !pushConfigured()) continue;
        const priorityEmail =
            delivery.channel === 'EMAIL' &&
            PRIORITY_EMAIL_TYPES.has(delivery.notification.type);
        if (
            delivery.channel === 'EMAIL' &&
            (emailBudget <= 0 || (!priorityEmail && optionalEmailBudget <= 0))
        ) {
            await prisma.notificationDelivery.updateMany({
                where: { id: delivery.id, status: 'PENDING' },
                data: { scheduledFor: nextUtcQuotaWindow() },
            });
            continue;
        }
        const published = await publishBackranqQueueMessage(
            { type: 'notification-delivery', deliveryId: delivery.id },
            {
                idempotencyKey: `notification-delivery:${delivery.id}:${delivery.attempts}:${delivery.scheduledFor.toISOString()}`,
            }
        );
        if (delivery.channel === 'EMAIL') {
            emailBudget -= 1;
            if (!priorityEmail) optionalEmailBudget -= 1;
        }
        if (!published.queued && process.env.NODE_ENV !== 'production') {
            await processNotificationDelivery(delivery.id);
        }
        results.push({ deliveryId: delivery.id, queued: published.queued });
    }
    await scheduleNextNotificationSweep(now);
    return results;
}

async function scheduleNextNotificationSweep(now: Date) {
    const channels = [
        ...(emailConfigured() ? (['EMAIL'] as const) : []),
        ...(pushConfigured() ? (['WEB_PUSH'] as const) : []),
    ];
    if (channels.length === 0) return null;
    const next = await prisma.notificationDelivery.findFirst({
        where: {
            status: 'PENDING',
            channel: { in: channels },
            scheduledFor: { gt: now },
        },
        orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'asc' }],
        select: { scheduledFor: true },
    });
    if (!next) return null;
    const requestedDelaySeconds = Math.max(
        1,
        Math.ceil((next.scheduledFor.getTime() - now.getTime()) / 1_000)
    );
    const delaySeconds = Math.min(
        requestedDelaySeconds,
        MAX_NOTIFICATION_SWEEP_DELAY_SECONDS
    );
    const finalHop = requestedDelaySeconds <= MAX_NOTIFICATION_SWEEP_DELAY_SECONDS;
    const idempotencyKey = finalHop
        ? `notification-sweep:final:${next.scheduledFor.toISOString()}`
        : `notification-sweep:checkpoint:${next.scheduledFor.toISOString()}:${now
              .toISOString()
              .slice(0, 10)}`;
    return publishBackranqQueueMessage(
        { type: 'notification-sweep', requestedAt: now.toISOString() },
        {
            idempotencyKey,
            delaySeconds,
            retentionSeconds: NOTIFICATION_SWEEP_RETENTION_SECONDS,
        }
    );
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
        await prisma.notificationDelivery.updateMany({
            where: { id: delivery.id, status: 'PROCESSING' },
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
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DeliveryCancelledError) {
            const transition = await prisma.notificationDelivery.updateMany({
                where: { id: delivery.id, status: 'PROCESSING' },
                data: {
                    status: 'CANCELLED',
                    lockedUntil: null,
                    lastError: message.slice(0, 2_000),
                },
            });
            if (transition.count === 0) return { status: 'SKIPPED' as const };
            return { status: 'CANCELLED' as const };
        }
        if (error instanceof DeliveryRescheduledError) {
            const transition = await prisma.notificationDelivery.updateMany({
                where: { id: delivery.id, status: 'PROCESSING' },
                data: {
                    status: 'PENDING',
                    scheduledFor: error.scheduledFor,
                    lockedUntil: null,
                    lastError: message.slice(0, 2_000),
                },
            });
            if (transition.count === 0) return { status: 'SKIPPED' as const };
            await scheduleNextNotificationSweep(new Date());
            return { status: 'RESCHEDULED' as const };
        }
        if (error instanceof Smtp2GoQuotaError) {
            const transition = await prisma.notificationDelivery.updateMany({
                where: { id: delivery.id, status: 'PROCESSING' },
                data: {
                    status: 'PENDING',
                    scheduledFor: error.retryAt,
                    lockedUntil: null,
                    lastError: message.slice(0, 2_000),
                },
            });
            if (transition.count === 0) return { status: 'SKIPPED' as const };
            await scheduleNextNotificationSweep(new Date());
            return { status: 'RESCHEDULED' as const };
        }
        const ambiguousEmail =
            error instanceof Smtp2GoAmbiguousSendError &&
            delivery.channel === 'EMAIL';
        const terminal = ambiguousEmail || delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
        const transition = await prisma.notificationDelivery.updateMany({
            where: { id: delivery.id, status: 'PROCESSING' },
            data: {
                status: terminal ? 'FAILED' : 'PENDING',
                scheduledFor: new Date(
                    Date.now() + Math.min(60, 2 ** delivery.attempts) * 60_000
                ),
                lockedUntil: null,
                lastError: message.slice(0, 2_000),
            },
        });
        if (transition.count === 0) return { status: 'SKIPPED' as const };
        if (!terminal) await scheduleNextNotificationSweep(new Date());
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
    const actionLabel =
        delivery.notification.type === 'PRACTICE_READY'
            ? 'Start practicing'
            : 'Open Backranq';
    const html = await render(
        NotificationEmail({
            preview: copy.body,
            heading: copy.title,
            body: copy.body,
            actionLabel,
            actionUrl,
            settingsUrl: `${base}/settings#notifications`,
            unsubscribeUrl,
        })
    );
    const text = [
        copy.title,
        '',
        copy.body,
        '',
        `${actionLabel}: ${actionUrl}`,
        '',
        `Notification settings: ${base}/settings#notifications`,
        ...(unsubscribeUrl ? ['', `Unsubscribe: ${unsubscribeUrl}`] : []),
    ].join('\n');
    await ensureEmailCanBeSent(delivery);
    return sendSmtp2GoEmail({
        from,
        to: recipient,
        subject: copy.title,
        html,
        text,
        headers: {
            ...headers,
            'X-Backranq-Delivery-Id': delivery.id,
        },
    });
}

async function ensureEmailCanBeSent(delivery: HydratedDelivery) {
    const preference = await prisma.notificationPreference.findUnique({
        where: { userId: delivery.userId },
        select: {
            emailPracticeReady: true,
            emailAnalysisFailed: true,
            emailSyncSummary: true,
            emailBilling: true,
            emailWeeklyProgress: true,
            emailProductNews: true,
            productNewsConsentedAt: true,
            optionalEmailsUnsubscribedAt: true,
            emailSuppressedAt: true,
            timezone: true,
            digestHour: true,
        },
    });
    if (!preference || preference.emailSuppressedAt) {
        throw new DeliveryCancelledError('Email is currently suppressed');
    }
    const optionalBlocked = !!preference.optionalEmailsUnsubscribedAt;
    const allowed = (() => {
        switch (delivery.notification.type) {
            case 'PRACTICE_READY':
                return preference.emailPracticeReady && !optionalBlocked;
            case 'ANALYSIS_FAILED':
            case 'SYNC_FAILED':
                return preference.emailAnalysisFailed && !optionalBlocked;
            case 'NEW_GAMES_SYNCED':
                return preference.emailSyncSummary && !optionalBlocked;
            case 'LOW_CREDITS':
            case 'BILLING_ACTION_REQUIRED':
                return preference.emailBilling;
            case 'WEEKLY_PROGRESS':
                return preference.emailWeeklyProgress && !optionalBlocked;
            case 'PRODUCT_NEWS':
                return (
                    preference.emailProductNews &&
                    !!preference.productNewsConsentedAt &&
                    !optionalBlocked
                );
            case 'WELCOME':
                return true;
        }
    })();
    if (!allowed) {
        throw new DeliveryCancelledError('Email preference was disabled before send');
    }

    if (delivery.notification.type === 'PRACTICE_READY') {
        await guardPracticeReadyCalendarDay(
            delivery,
            preference.timezone,
            preference.digestHour
        );
    }
    await guardSmtp2GoDailyQuota(delivery);
}

async function guardPracticeReadyCalendarDay(
    delivery: HydratedDelivery,
    timezone: string,
    digestHour: number
) {
    const now = new Date();
    const { start, end, digestAt } = localCalendarDayWindow(
        now,
        timezone,
        digestHour
    );
    if (now < digestAt) {
        throw new DeliveryRescheduledError(
            'Practice-ready email rescheduled to the current preferred hour',
            digestAt
        );
    }
    const sentToday = await prisma.notificationDelivery.findFirst({
        where: {
            id: { not: delivery.id },
            userId: delivery.userId,
            channel: 'EMAIL',
            OR: [
                { sentAt: { gte: start, lt: end } },
                {
                    status: 'FAILED',
                    updatedAt: { gte: start, lt: end },
                    lastError: { contains: 'delivery state is unknown' },
                },
            ],
            notification: { type: 'PRACTICE_READY' },
        },
        select: { id: true },
    });
    if (sentToday) {
        throw new DeliveryCancelledError(
            'A practice-ready email was already sent in this local calendar day'
        );
    }

    const firstActive = await prisma.notificationDelivery.findFirst({
        where: {
            userId: delivery.userId,
            channel: 'EMAIL',
            status: 'PROCESSING',
            notification: { type: 'PRACTICE_READY' },
            OR: [{ id: delivery.id }, { lockedUntil: { gt: now } }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
    });
    if (firstActive && firstActive.id !== delivery.id) {
        throw new DeliveryCancelledError(
            'A concurrent practice-ready email already owns this send window'
        );
    }
}

async function guardSmtp2GoDailyQuota(delivery: HydratedDelivery) {
    const start = utcDayStart(new Date());
    const end = new Date(start.getTime() + 24 * 60 * 60_000);
    const reserved = await prisma.notificationDelivery.count({
        where: {
            channel: 'EMAIL',
            OR: [
                { sentAt: { gte: start, lt: end } },
                {
                    status: 'PROCESSING',
                    updatedAt: { gte: start, lt: end },
                },
                {
                    status: 'FAILED',
                    updatedAt: { gte: start, lt: end },
                    lastError: { contains: 'delivery state is unknown' },
                },
            ],
        },
    });
    // The current PROCESSING delivery is part of the reservation count.
    const priority = PRIORITY_EMAIL_TYPES.has(delivery.notification.type);
    const allowed = priority
        ? smtp2GoDailySendLimit()
        : Math.max(0, smtp2GoDailySendLimit() - smtp2GoTransactionalReserve());
    if (reserved > allowed) {
        throw new DeliveryRescheduledError(
            `SMTP2GO daily safety limit reached before delivery ${delivery.id}`,
            nextUtcQuotaWindow()
        );
    }
}

async function emailsSentToday() {
    const start = utcDayStart(new Date());
    return prisma.notificationDelivery.count({
        where: {
            channel: 'EMAIL',
            OR: [
                { sentAt: { gte: start } },
                {
                    status: 'FAILED',
                    updatedAt: { gte: start },
                    lastError: { contains: 'delivery state is unknown' },
                },
            ],
        },
    });
}

function smtp2GoDailySendLimit() {
    return positiveIntegerEnv(
        'SMTP2GO_DAILY_SEND_LIMIT',
        DEFAULT_SMTP2GO_DAILY_SEND_LIMIT
    );
}

function smtp2GoTransactionalReserve() {
    return Math.min(
        smtp2GoDailySendLimit(),
        positiveIntegerEnv(
            'SMTP2GO_TRANSACTIONAL_RESERVE',
            DEFAULT_SMTP2GO_TRANSACTIONAL_RESERVE
        )
    );
}

function positiveIntegerEnv(name: string, fallback: number) {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDayStart(now: Date) {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function nextUtcQuotaWindow() {
    const start = utcDayStart(new Date());
    return new Date(start.getTime() + 24 * 60 * 60_000 + 5 * 60_000);
}

function localCalendarDayWindow(now: Date, timezone: string, digestHour: number) {
    const local = zonedDateParts(now, timezone);
    const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
    const nextLocalDate = new Date(localDate);
    nextLocalDate.setUTCDate(nextLocalDate.getUTCDate() + 1);
    return {
        start: localTimeToUtc(localDate, 0, timezone),
        end: localTimeToUtc(nextLocalDate, 0, timezone),
        digestAt: localTimeToUtc(localDate, digestHour, timezone),
    };
}

function zonedDateParts(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
    };
}

function localTimeToUtc(localDate: Date, hour: number, timezone: string) {
    let candidate = new Date(
        Date.UTC(
            localDate.getUTCFullYear(),
            localDate.getUTCMonth(),
            localDate.getUTCDate(),
            hour
        )
    );
    for (let index = 0; index < 3; index += 1) {
        const actual = zonedDateParts(candidate, timezone);
        const wantedMs = Date.UTC(
            localDate.getUTCFullYear(),
            localDate.getUTCMonth(),
            localDate.getUTCDate(),
            hour
        );
        const actualMs = Date.UTC(
            actual.year,
            actual.month - 1,
            actual.day,
            actual.hour
        );
        candidate = new Date(candidate.getTime() + wantedMs - actualMs);
    }
    return candidate;
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
