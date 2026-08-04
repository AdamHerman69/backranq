import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, txMock, calls } = vi.hoisted(() => {
    const calls: string[] = [];
    const txMock = {
        user: { findUnique: vi.fn() },
        notificationPreference: { upsert: vi.fn() },
        notification: { upsert: vi.fn() },
        notificationDelivery: { upsert: vi.fn() },
        pushSubscription: { findFirst: vi.fn() },
    };
    const prismaMock = {
        $transaction: vi.fn(),
        user: { findUnique: vi.fn() },
        notificationPreference: { upsert: vi.fn() },
        notification: { upsert: vi.fn() },
        notificationDelivery: { upsert: vi.fn() },
        pushSubscription: { findFirst: vi.fn() },
    };
    return { prismaMock, txMock, calls };
});

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { recordNotification } from '@/lib/notifications/service';
import type { NotificationDbClient } from '@/lib/notifications/service';

describe('recordNotification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        calls.length = 0;
        prismaMock.$transaction.mockImplementation(async (callback) =>
            callback(txMock)
        );
        txMock.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
        txMock.notificationPreference.upsert.mockResolvedValue({
            emailSuppressedAt: null,
            optionalEmailsUnsubscribedAt: null,
            emailPracticeReady: true,
            emailAnalysisFailed: true,
            emailSyncSummary: true,
            emailBilling: true,
            emailWeeklyProgress: true,
            emailProductNews: false,
            productNewsConsentedAt: null,
            pushEnabled: false,
        });
        txMock.notification.upsert.mockImplementation(async () => {
            calls.push('notification');
            return { id: 'notification-1' };
        });
        txMock.notificationDelivery.upsert.mockImplementation(async () => {
            calls.push('delivery');
            return { id: 'delivery-1' };
        });
    });

    it('writes the notification and its delivery in one default-client transaction', async () => {
        await recordNotification({
            userId: 'user-1',
            type: 'WELCOME',
            title: 'Welcome',
            body: 'Hello',
            dedupeKey: 'welcome:user-1',
            email: true,
        });

        expect(prismaMock.$transaction).toHaveBeenCalledOnce();
        expect(calls).toEqual(['notification', 'delivery']);
        expect(prismaMock.notification.upsert).not.toHaveBeenCalled();
        expect(prismaMock.notificationDelivery.upsert).not.toHaveBeenCalled();
    });

    it('does not open a nested transaction for an explicit transaction client', async () => {
        await recordNotification(
            {
                userId: 'user-1',
                type: 'WELCOME',
                title: 'Welcome',
                body: 'Hello',
                dedupeKey: 'welcome:user-1',
                email: true,
            },
            txMock as unknown as NotificationDbClient
        );

        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(calls).toEqual(['notification', 'delivery']);
    });
});
