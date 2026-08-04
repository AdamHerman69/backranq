import type {
    Notification,
    NotificationChannel,
    NotificationPreference,
    NotificationType,
    Prisma,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
    digestPeriodKey,
    nextDigestAt,
    practiceReadyDeliveryWindow,
} from './scheduling';

export type NotificationDbClient = Pick<
    Prisma.TransactionClient,
    | 'user'
    | 'notificationPreference'
    | 'notification'
    | 'notificationDelivery'
    | 'pushSubscription'
>;
type DbClient = NotificationDbClient;

type RecordNotificationArgs = {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    href?: string;
    dedupeKey: string;
    itemCount?: number;
    secondaryCount?: number;
    metadata?: Prisma.InputJsonValue;
    email?: boolean;
    push?: boolean;
    emailScheduledFor?: Date;
};

export async function getOrCreateNotificationPreference(
    userId: string,
    db: DbClient = prisma
) {
    return db.notificationPreference.upsert({
        where: { userId },
        create: { userId },
        update: {},
    });
}

function emailAllowed(
    preference: NotificationPreference,
    type: NotificationType
) {
    if (preference.emailSuppressedAt) return false;
    const optionalBlocked = !!preference.optionalEmailsUnsubscribedAt;
    switch (type) {
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
            return !preference.emailSuppressedAt;
    }
}

export async function recordNotification(
    args: RecordNotificationArgs,
    db: DbClient = prisma
): Promise<Notification> {
    if (db === prisma) {
        return prisma.$transaction((tx) => recordNotification(args, tx));
    }

    const user = await db.user.findUnique({
        where: { id: args.userId },
        select: { email: true },
    });
    if (!user) throw new Error('Notification user not found');
    const preference = await getOrCreateNotificationPreference(args.userId, db);
    const notification = await db.notification.upsert({
        where: { dedupeKey: args.dedupeKey },
        create: {
            userId: args.userId,
            type: args.type,
            title: args.title,
            body: args.body,
            href: args.href,
            dedupeKey: args.dedupeKey,
            itemCount: args.itemCount ?? 1,
            secondaryCount: args.secondaryCount ?? 0,
            metadata: args.metadata,
        },
        update: {
            itemCount: { increment: args.itemCount ?? 0 },
            secondaryCount: { increment: args.secondaryCount ?? 0 },
            metadata: args.metadata,
        },
    });

    const deliveries: NotificationChannel[] = [];
    if (args.email && user.email && emailAllowed(preference, args.type)) {
        deliveries.push('EMAIL');
    }
    if (args.push && preference.pushEnabled) {
        const subscription = await db.pushSubscription.findFirst({
            where: { userId: args.userId },
            select: { id: true },
        });
        if (subscription) deliveries.push('WEB_PUSH');
    }

    for (const channel of deliveries) {
        await db.notificationDelivery.upsert({
            where: {
                notificationId_channel: {
                    notificationId: notification.id,
                    channel,
                },
            },
            create: {
                notificationId: notification.id,
                userId: args.userId,
                channel,
                recipient: channel === 'EMAIL' ? user.email : null,
                scheduledFor:
                    channel === 'EMAIL' && args.emailScheduledFor
                        ? args.emailScheduledFor
                        : new Date(),
            },
            update: {},
        });
    }
    return notification;
}

export async function recordPracticeReadyInTransaction(args: {
    tx: NotificationDbClient;
    userId: string;
    gameId: string;
    practicePositions: number;
    completedAt: Date;
}) {
    if (args.practicePositions <= 0) return null;
    const preference = await getOrCreateNotificationPreference(
        args.userId,
        args.tx
    );
    const window = practiceReadyDeliveryWindow(
        args.completedAt,
        preference.timezone,
        preference.digestHour
    );
    return recordNotification(
        {
            userId: args.userId,
            type: 'PRACTICE_READY',
            title: 'Your new practice is ready',
            body: 'Fresh practice from your analyzed games is waiting when you are ready.',
            href: '/practice',
            dedupeKey: `practice-ready:${args.userId}:${window.key}`,
            itemCount: args.practicePositions,
            secondaryCount: 1,
            metadata: { latestGameId: args.gameId },
            email: true,
            push: false,
            emailScheduledFor: window.scheduledFor,
        },
        args.tx
    );
}

export function recordAnalysisFailed(args: {
    userId: string;
    jobId: string;
    gameId: string;
    error: string;
}) {
    return recordNotification({
        userId: args.userId,
        type: 'ANALYSIS_FAILED',
        title: 'Game analysis failed',
        body: 'We could not analyze one of your games after several attempts.',
        href: `/games/${args.gameId}`,
        dedupeKey: `analysis-failed:${args.jobId}`,
        metadata: { gameId: args.gameId, error: args.error.slice(0, 500) },
        email: true,
        push: true,
    });
}

export async function recordSyncCompleted(args: {
    userId: string;
    jobId: string;
    provider: string;
    newGames: number;
}, db: DbClient = prisma) {
    if (args.newGames <= 0) return null;
    const preference = await getOrCreateNotificationPreference(args.userId, db);
    const period = digestPeriodKey(
        new Date(),
        preference.syncDigestFrequency,
        preference.timezone
    );
    return recordNotification({
        userId: args.userId,
        type: 'NEW_GAMES_SYNCED',
        title: 'New games synced',
        body: 'New games were added to your library.',
        href: '/games',
        dedupeKey:
            preference.syncDigestFrequency === 'OFF'
                ? `sync-completed:${args.jobId}`
                : `sync-summary:${args.userId}:${period}`,
        itemCount: args.newGames,
        metadata: { provider: args.provider },
        email: true,
        push: true,
        emailScheduledFor:
            preference.syncDigestFrequency === 'OFF'
                ? undefined
                : nextDigestAt(
                      new Date(),
                      preference.timezone,
                      preference.digestHour,
                      preference.syncDigestFrequency
                  ),
    }, db);
}

export function recordSyncFailed(args: {
    userId: string;
    jobId: string;
    provider: string;
    error: string;
}) {
    return recordNotification({
        userId: args.userId,
        type: 'SYNC_FAILED',
        title: `${args.provider} sync failed`,
        body: 'Automatic game synchronization needs your attention.',
        href: '/settings',
        dedupeKey: `sync-failed:${args.jobId}`,
        metadata: { provider: args.provider, error: args.error.slice(0, 500) },
        email: true,
        push: true,
    });
}

export function recordWelcome(userId: string) {
    return recordNotification({
        userId,
        type: 'WELCOME',
        title: 'Welcome to Backranq',
        body: 'Connect your chess account and turn your games into personal practice.',
        href: '/settings',
        dedupeKey: `welcome:${userId}`,
        email: true,
        push: false,
    });
}

export function recordBillingNotification(args: {
    userId: string;
    eventId: string;
    type: 'LOW_CREDITS' | 'BILLING_ACTION_REQUIRED';
    title: string;
    body: string;
}, db: DbClient = prisma) {
    return recordNotification({
        ...args,
        href: '/settings#billing',
        dedupeKey: `billing:${args.userId}:${args.type}:${args.eventId}`,
        email: true,
        push: true,
    }, db);
}
