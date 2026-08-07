import type {
    Notification,
    NotificationPreference,
    NotificationType,
} from '@prisma/client';

export const NOTIFICATION_PAGE_SIZE = 20;
export const NOTIFICATION_MAX_PAGE_SIZE = 50;

export type NotificationDto = {
    id: string;
    type: NotificationType;
    title: string;
    body: string;
    href: string | null;
    itemCount: number;
    secondaryCount: number;
    readAt: string | null;
    createdAt: string;
};

export type NotificationPreferenceDto = Pick<
    NotificationPreference,
    | 'emailPracticeReady'
    | 'emailAnalysisFailed'
    | 'emailSyncSummary'
    | 'emailBilling'
    | 'emailWeeklyProgress'
    | 'emailProductNews'
    | 'pushEnabled'
    | 'syncDigestFrequency'
    | 'timezone'
    | 'digestHour'
> & {
    productNewsConsentedAt: string | null;
    optionalEmailsUnsubscribedAt: string | null;
    emailSuppressedAt: string | null;
};

export function notificationCopy(
    notification: Pick<
        Notification,
        'type' | 'title' | 'body' | 'itemCount' | 'secondaryCount'
    > &
        Partial<Pick<Notification, 'metadata'>>
) {
    switch (notification.type) {
        case 'PRACTICE_READY':
            return {
                title: 'Your new practice is ready',
                body: `${notification.itemCount} practice position${notification.itemCount === 1 ? '' : 's'} from ${notification.secondaryCount} analyzed game${notification.secondaryCount === 1 ? '' : 's'} ${notification.itemCount === 1 ? 'is' : 'are'} ready.`,
            };
        case 'PRACTICE_DUE': {
            const dueCountIsExact = !(
                !!notification.metadata &&
                typeof notification.metadata === 'object' &&
                !Array.isArray(notification.metadata) &&
                notification.metadata.dueCountIsExact === false
            );
            return {
                title: 'Your practice review is due',
                body: `${notification.itemCount}${dueCountIsExact ? '' : '+'} practice position${notification.itemCount === 1 && dueCountIsExact ? ' is' : 's are'} ready for review.`,
            };
        }
        case 'NEW_GAMES_SYNCED':
            return {
                title: 'New games synced',
                body: `${notification.itemCount} new game${notification.itemCount === 1 ? '' : 's'} ${notification.itemCount === 1 ? 'was' : 'were'} added to your library.`,
            };
        default:
            return { title: notification.title, body: notification.body };
    }
}

export function notificationDto(notification: Notification): NotificationDto {
    const copy = notificationCopy(notification);
    return {
        id: notification.id,
        type: notification.type,
        title: copy.title,
        body: copy.body,
        href: notification.href,
        itemCount: notification.itemCount,
        secondaryCount: notification.secondaryCount,
        readAt: notification.readAt?.toISOString() ?? null,
        createdAt: notification.createdAt.toISOString(),
    };
}

export function preferenceDto(
    preference: NotificationPreference
): NotificationPreferenceDto {
    return {
        emailPracticeReady: preference.emailPracticeReady,
        emailAnalysisFailed: preference.emailAnalysisFailed,
        emailSyncSummary: preference.emailSyncSummary,
        emailBilling: preference.emailBilling,
        emailWeeklyProgress: preference.emailWeeklyProgress,
        emailProductNews: preference.emailProductNews,
        pushEnabled: preference.pushEnabled,
        syncDigestFrequency: preference.syncDigestFrequency,
        timezone: preference.timezone,
        digestHour: preference.digestHour,
        productNewsConsentedAt:
            preference.productNewsConsentedAt?.toISOString() ?? null,
        optionalEmailsUnsubscribedAt:
            preference.optionalEmailsUnsubscribedAt?.toISOString() ?? null,
        emailSuppressedAt:
            preference.emailSuppressedAt?.toISOString() ?? null,
    };
}
