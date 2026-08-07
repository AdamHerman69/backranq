import type { NotificationType } from '@prisma/client';

export const PRIORITY_EMAIL_TYPES = new Set<NotificationType>([
    'LOW_CREDITS',
    'BILLING_ACTION_REQUIRED',
]);

export const OPTIONAL_EMAIL_TYPES = new Set<NotificationType>([
    'PRACTICE_READY',
    'PRACTICE_DUE',
    'ANALYSIS_FAILED',
    'SYNC_FAILED',
    'NEW_GAMES_SYNCED',
    'WEEKLY_PROGRESS',
    'PRODUCT_NEWS',
]);

export function emailDispatchPriority(type: NotificationType) {
    return PRIORITY_EMAIL_TYPES.has(type) ? 0 : 1;
}
