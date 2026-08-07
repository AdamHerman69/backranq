import webpush from 'web-push';
import { render } from 'react-email';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import NotificationEmail from '@/emails/NotificationEmail';
import { notificationCopy } from './contracts';
import { createUnsubscribeToken } from './tokens';
import {
    Smtp2GoAmbiguousSendError,
    Smtp2GoQuotaError,
} from './smtp2go';
import {
    EmailBudgetUnavailableError,
    PracticeEmailWindowClaimedError,
    sendReservedSmtp2GoEmail,
} from './emailReservations';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { getPracticeDueSummary } from '@/lib/training/practiceDue';
import {
    OPTIONAL_EMAIL_TYPES,
    PRIORITY_EMAIL_TYPES,
} from './emailPolicy';

// Provider requests time out after 15 seconds. Fifteen minutes leaves ample
// headroom for rendering, preferences/quota checks and bounded device sends,
// so recovery cannot normally reclaim an active provider handoff.
const DELIVERY_LEASE_MS = 15 * 60_000;
const MAX_DELIVERY_ATTEMPTS = 5;
const DEFAULT_SMTP2GO_EMAILS_PER_DISPATCH = 20;
const MAX_NOTIFICATION_SWEEP_DELAY_SECONDS = 6 * 24 * 60 * 60;
const NOTIFICATION_SWEEP_RETENTION_SECONDS = 7 * 24 * 60 * 60;

type HydratedDelivery = Prisma.NotificationDeliveryGetPayload<{
    include: {
        notification: true;
        user: { select: { id: true; email: true } };
    };
}>;

type QueuedDelivery = {
    id: string;
    channel: 'EMAIL' | 'WEB_PUSH';
    attempts: number;
    scheduledFor: Date;
    dispatchToken: string;
};

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
    const take = Math.max(1, Math.min(limit, 100));
    const recovered = await recoverExpiredNotificationDeliveryLeases(
        now,
        take
    );
    const maxEmailsThisDispatch = positiveIntegerEnv(
        'SMTP2GO_EMAILS_PER_DISPATCH',
        DEFAULT_SMTP2GO_EMAILS_PER_DISPATCH
    );
    const deliveries = await claimPendingNotificationDeliveries({
        now,
        take,
        emailTake: emailConfigured()
            ? Math.min(take, maxEmailsThisDispatch)
            : 0,
        pushTake: pushConfigured() ? take : 0,
    });
    const results = await Promise.all(
        deliveries.map(publishClaimedNotificationDelivery)
    );
    await scheduleNextNotificationSweep(now);
    if (recovered.length === take) {
        const recoveryContinuation = await publishBackranqQueueMessage(
            { type: 'notification-sweep', requestedAt: now.toISOString() },
            {
                idempotencyKey: `notification-sweep:recovery:${recovered.at(-1)?.id ?? 'page'}:${now.toISOString()}`,
                delaySeconds: 1,
                retentionSeconds: NOTIFICATION_SWEEP_RETENTION_SECONDS,
            }
        );
        if (
            !recoveryContinuation.queued &&
            process.env.NODE_ENV === 'production'
        ) {
            throw new Error('Notification recovery queue is unavailable');
        }
    }
    return results;
}

async function recoverExpiredNotificationDeliveryLeases(
    now: Date,
    take: number
) {
    return prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH expired AS MATERIALIZED (
            SELECT delivery."id"
            FROM "NotificationDelivery" delivery
            WHERE delivery."status" IN (
                'QUEUED'::"NotificationDeliveryStatus",
                'PROCESSING'::"NotificationDeliveryStatus"
            )
              AND (
                  delivery."lockedUntil" IS NULL OR
                  delivery."lockedUntil" < ${now}
              )
            ORDER BY delivery."lockedUntil" ASC NULLS FIRST, delivery."id" ASC
            LIMIT ${take}
            FOR UPDATE SKIP LOCKED
        )
        UPDATE "NotificationDelivery" delivery
        SET
            "status" = 'PENDING'::"NotificationDeliveryStatus",
            "dispatchToken" = NULL,
            "lockedUntil" = NULL,
            "updatedAt" = ${now}
        FROM expired
        WHERE delivery."id" = expired."id"
          AND delivery."status" IN (
              'QUEUED'::"NotificationDeliveryStatus",
              'PROCESSING'::"NotificationDeliveryStatus"
          )
        RETURNING delivery."id"
    `);
}

async function claimPendingNotificationDeliveries(args: {
    now: Date;
    take: number;
    emailTake: number;
    pushTake: number;
}) {
    if (args.emailTake === 0 && args.pushTake === 0) return [];
    const leaseUntil = new Date(args.now.getTime() + DELIVERY_LEASE_MS);
    return prisma.$queryRaw<QueuedDelivery[]>(Prisma.sql`
        WITH priority_email AS MATERIALIZED (
            SELECT
                delivery."id",
                delivery."dispatchPriority",
                delivery."scheduledFor",
                delivery."createdAt"
            FROM "NotificationDelivery" delivery
            WHERE delivery."status" = 'PENDING'::"NotificationDeliveryStatus"
              AND delivery."channel" = 'EMAIL'::"NotificationChannel"
              AND delivery."dispatchPriority" = 0
              AND delivery."scheduledFor" <= ${args.now}
            ORDER BY
                delivery."scheduledFor" ASC,
                delivery."createdAt" ASC,
                delivery."id" ASC
            LIMIT ${args.emailTake}
            FOR UPDATE OF delivery SKIP LOCKED
        ), optional_email AS MATERIALIZED (
            SELECT
                delivery."id",
                delivery."dispatchPriority",
                delivery."scheduledFor",
                delivery."createdAt"
            FROM "NotificationDelivery" delivery
            WHERE delivery."status" = 'PENDING'::"NotificationDeliveryStatus"
              AND delivery."channel" = 'EMAIL'::"NotificationChannel"
              AND delivery."dispatchPriority" = 1
              AND delivery."scheduledFor" <= ${args.now}
            ORDER BY
                delivery."scheduledFor" ASC,
                delivery."createdAt" ASC,
                delivery."id" ASC
            LIMIT ${args.emailTake}
            FOR UPDATE OF delivery SKIP LOCKED
        ), email_candidates AS MATERIALIZED (
            SELECT * FROM priority_email
            UNION ALL
            SELECT * FROM optional_email
            ORDER BY
                "dispatchPriority" ASC,
                "scheduledFor" ASC,
                "createdAt" ASC,
                "id" ASC
            LIMIT ${args.emailTake}
        ), push_candidates AS MATERIALIZED (
            SELECT
                delivery."id",
                delivery."dispatchPriority",
                delivery."scheduledFor",
                delivery."createdAt"
            FROM "NotificationDelivery" delivery
            WHERE delivery."status" = 'PENDING'::"NotificationDeliveryStatus"
              AND delivery."channel" = 'WEB_PUSH'::"NotificationChannel"
              AND delivery."dispatchPriority" = 1
              AND delivery."scheduledFor" <= ${args.now}
            ORDER BY
                delivery."scheduledFor" ASC,
                delivery."createdAt" ASC,
                delivery."id" ASC
            LIMIT ${args.pushTake}
            FOR UPDATE OF delivery SKIP LOCKED
        ), candidates AS MATERIALIZED (
            SELECT * FROM email_candidates
            UNION ALL
            SELECT * FROM push_candidates
            ORDER BY
                "dispatchPriority" ASC,
                "scheduledFor" ASC,
                "createdAt" ASC,
                "id" ASC
            LIMIT ${args.take}
        )
        UPDATE "NotificationDelivery" delivery
        SET
            "status" = 'QUEUED'::"NotificationDeliveryStatus",
            "dispatchToken" = gen_random_uuid(),
            "lockedUntil" = ${leaseUntil},
            "lastError" = NULL,
            "updatedAt" = ${args.now}
        FROM candidates
        WHERE delivery."id" = candidates."id"
          AND delivery."status" = 'PENDING'::"NotificationDeliveryStatus"
        RETURNING
            delivery."id",
            delivery."channel",
            delivery."attempts",
            delivery."scheduledFor",
            delivery."dispatchToken"
    `);
}

async function publishClaimedNotificationDelivery(
    delivery: QueuedDelivery
) {
    try {
        const published = await publishBackranqQueueMessage(
            {
                type: 'notification-delivery',
                deliveryId: delivery.id,
                dispatchToken: delivery.dispatchToken,
            },
            {
                idempotencyKey: `notification-delivery:${delivery.id}:${delivery.dispatchToken}`,
            }
        );
        if (!published.queued) {
            if (process.env.NODE_ENV !== 'production') {
                await processNotificationDelivery(
                    delivery.id,
                    delivery.dispatchToken
                );
            } else {
                throw new Error('Notification queue is unavailable');
            }
        }
        return { deliveryId: delivery.id, queued: published.queued };
    } catch (error) {
        await prisma.notificationDelivery.updateMany({
            where: {
                id: delivery.id,
                status: 'QUEUED',
                dispatchToken: delivery.dispatchToken,
            },
            data: {
                status: 'PENDING',
                dispatchToken: null,
                lockedUntil: null,
                lastError: 'Queue publication failed',
            },
        });
        throw error;
    }
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
        },
        orderBy: [
            { scheduledFor: 'asc' },
            { createdAt: 'asc' },
            { id: 'asc' },
        ],
        select: { id: true, scheduledFor: true },
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
        ? `notification-sweep:final:${next.id}:${next.scheduledFor.toISOString()}`
        : `notification-sweep:checkpoint:${next.id}:${next.scheduledFor.toISOString()}:${now
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

export async function processNotificationDelivery(
    deliveryId: string,
    dispatchToken: string
) {
    const now = new Date();
    const claimed = await prisma.notificationDelivery.updateMany({
        where: {
            id: deliveryId,
            status: 'QUEUED',
            dispatchToken,
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
    if (delivery.dispatchToken !== dispatchToken) {
        return { status: 'SKIPPED' as const };
    }
    const processingWhere = {
        id: delivery.id,
        status: 'PROCESSING' as const,
        dispatchToken,
    };
    try {
        const providerMessageId =
            delivery.channel === 'EMAIL'
                ? await deliverEmail(delivery)
                : await deliverWebPush(delivery);
        const transition = await prisma.notificationDelivery.updateMany({
            where: processingWhere,
            data: {
                status: 'SENT',
                dispatchToken: null,
                providerMessageId,
                sentAt: new Date(),
                lockedUntil: null,
                lastError: null,
            },
        });
        if (transition.count !== 1) return { status: 'SKIPPED' as const };
        return { status: 'SENT' as const, providerMessageId };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof DeliveryCancelledError) {
            const transition = await prisma.notificationDelivery.updateMany({
                where: processingWhere,
                data: {
                    status: 'CANCELLED',
                    dispatchToken: null,
                    lockedUntil: null,
                    lastError: message.slice(0, 2_000),
                },
            });
            if (transition.count === 0) return { status: 'SKIPPED' as const };
            return { status: 'CANCELLED' as const };
        }
        if (error instanceof DeliveryRescheduledError) {
            const transition = await prisma.notificationDelivery.updateMany({
                where: processingWhere,
                data: {
                    status: 'PENDING',
                    dispatchToken: null,
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
                where: processingWhere,
                data: {
                    status: 'PENDING',
                    dispatchToken: null,
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
            where: processingWhere,
            data: {
                status: terminal ? 'FAILED' : 'PENDING',
                dispatchToken: null,
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

async function ensurePracticeDueStillCurrent(delivery: HydratedDelivery) {
    if (delivery.notification.type !== 'PRACTICE_DUE') return;
    const recheck = await getPracticeDueSummary(delivery.userId);
    if (recheck.state === 'UNKNOWN') {
        // The durable sweep is authoritative for this reminder. A bounded
        // live scan that only encountered stale rows cannot disprove it.
        return;
    }
    if (recheck.state === 'EMPTY') {
        throw new DeliveryCancelledError(
            'Practice review queue was completed before delivery'
        );
    }
    const summary = recheck.summary;
    const metadata =
        delivery.notification.metadata &&
        typeof delivery.notification.metadata === 'object' &&
        !Array.isArray(delivery.notification.metadata)
            ? delivery.notification.metadata
            : {};
    if (
        summary.dueCount === delivery.notification.itemCount &&
        metadata.dueCountIsExact === summary.dueCountIsExact
    ) {
        return;
    }
    const nextMetadata = {
        ...metadata,
        dueCountIsExact: summary.dueCountIsExact,
        earliestDueAt: summary.earliestDueAt.toISOString(),
        refreshedAt: new Date().toISOString(),
    };
    await prisma.notification.update({
        where: { id: delivery.notification.id },
        data: {
            itemCount: summary.dueCount,
            metadata: nextMetadata,
        },
    });
    delivery.notification.itemCount = summary.dueCount;
    delivery.notification.metadata = nextMetadata;
}

async function deliverEmail(delivery: HydratedDelivery) {
    const recipient = delivery.recipient ?? delivery.user.email;
    const from = process.env.BACKRANQ_EMAIL_FROM;
    if (!recipient || !from) throw new Error('Email recipient or sender is missing');
    if (!delivery.dispatchToken) {
        throw new Error('Email delivery is missing its dispatch token');
    }
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
        ...(['PRACTICE_READY', 'PRACTICE_DUE'].includes(
            delivery.notification.type
        )
            ? { Importance: 'low', 'X-Priority': '5' }
            : {}),
    };
    const actionLabel =
        ['PRACTICE_READY', 'PRACTICE_DUE'].includes(
            delivery.notification.type
        )
            ? 'Start practicing'
            : 'Open Backranq';
    const practiceWindowKey = await ensureEmailCanBeSent(delivery);
    await ensurePracticeDueStillCurrent(delivery);
    const renderContent = async () => {
        const copy = notificationCopy(delivery.notification);
        return {
            copy,
            html: await render(
                NotificationEmail({
                    preview: copy.body,
                    heading: copy.title,
                    body: copy.body,
                    actionLabel,
                    actionUrl,
                    settingsUrl: `${base}/settings#notifications`,
                    unsubscribeUrl,
                })
            ),
            text: [
                copy.title,
                '',
                copy.body,
                '',
                `${actionLabel}: ${actionUrl}`,
                '',
                `Notification settings: ${base}/settings#notifications`,
                ...(unsubscribeUrl
                    ? ['', `Unsubscribe: ${unsubscribeUrl}`]
                    : []),
            ].join('\n'),
        };
    };
    let content = await renderContent();
    const renderedCount = delivery.notification.itemCount;
    const renderedMetadata = JSON.stringify(delivery.notification.metadata);
    // Best-effort final freshness check after preferences/calendar checks and
    // as close as possible to the durable provider reservation and handoff.
    await ensurePracticeDueStillCurrent(delivery);
    if (
        delivery.notification.itemCount !== renderedCount ||
        JSON.stringify(delivery.notification.metadata) !== renderedMetadata
    ) {
        content = await renderContent();
    }
    try {
        return await sendReservedSmtp2GoEmail({
            ownerType: 'NOTIFICATION_DELIVERY',
            ownerId: delivery.id,
            ownerToken: delivery.dispatchToken,
            priority: PRIORITY_EMAIL_TYPES.has(delivery.notification.type),
            practiceWindowKey,
            email: {
                from,
                to: recipient,
                subject: content.copy.title,
                html: content.html,
                text: content.text,
                headers: {
                    ...headers,
                    'X-Backranq-Delivery-Id': delivery.id,
                },
            },
        });
    } catch (error) {
        if (error instanceof EmailBudgetUnavailableError) {
            throw new DeliveryRescheduledError(error.message, error.retryAt);
        }
        if (error instanceof PracticeEmailWindowClaimedError) {
            throw new DeliveryCancelledError(error.message);
        }
        throw error;
    }
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
            case 'PRACTICE_DUE':
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

    let practiceWindowKey: string | undefined;
    if (
        ['PRACTICE_READY', 'PRACTICE_DUE'].includes(
            delivery.notification.type
        )
    ) {
        practiceWindowKey = await guardPracticeEmailCalendarDay(
            delivery,
            preference.timezone,
            preference.digestHour
        );
    }
    return practiceWindowKey;
}

async function guardPracticeEmailCalendarDay(
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
            'Practice email rescheduled to the current preferred hour',
            digestAt
        );
    }
    return `practice-email:${delivery.userId}:${start.toISOString()}:${end.toISOString()}`;
}

function positiveIntegerEnv(name: string, fallback: number) {
    const parsed = Number(process.env[name]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
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
    await ensurePracticeDueStillCurrent(delivery);
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
