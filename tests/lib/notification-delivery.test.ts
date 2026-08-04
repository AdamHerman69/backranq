import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const sendSmtp2GoEmailMock = vi.fn();
const publishBackranqQueueMessageMock = vi.fn();

async function importDelivery() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('react-email', () => ({ render: vi.fn().mockResolvedValue('<p>Email</p>') }));
    vi.doMock('@/emails/NotificationEmail', () => ({ default: vi.fn(() => null) }));
    vi.doMock('@/lib/notifications/contracts', () => ({
        notificationCopy: () => ({ title: 'Practice ready', body: 'Ready.' }),
    }));
    vi.doMock('@/lib/notifications/tokens', () => ({
        createUnsubscribeToken: () => 'unsubscribe-token',
    }));
    vi.doMock('@/lib/queues/backranq', () => ({
        publishBackranqQueueMessage: publishBackranqQueueMessageMock,
    }));
    vi.doMock('@/lib/notifications/smtp2go', async (importOriginal) => {
        const actual = await importOriginal<
            typeof import('@/lib/notifications/smtp2go')
        >();
        return { ...actual, sendSmtp2GoEmail: sendSmtp2GoEmailMock };
    });
    return import('@/lib/notifications/delivery');
}

const preference = {
    emailPracticeReady: true,
    emailAnalysisFailed: false,
    emailSyncSummary: false,
    emailBilling: true,
    emailWeeklyProgress: false,
    emailProductNews: false,
    productNewsConsentedAt: null,
    optionalEmailsUnsubscribedAt: null,
    emailSuppressedAt: null,
    timezone: 'UTC',
    digestHour: 9,
};

function practiceDelivery() {
    return {
        id: 'delivery-1',
        notificationId: 'notification-1',
        userId: 'user-1',
        channel: 'EMAIL',
        status: 'PROCESSING',
        recipient: 'player@example.net',
        scheduledFor: new Date('2026-08-04T09:00:00.000Z'),
        lockedUntil: new Date('2026-08-04T09:05:00.000Z'),
        attempts: 1,
        providerMessageId: null,
        lastError: null,
        sentAt: null,
        deliveredAt: null,
        createdAt: new Date('2026-08-04T08:00:00.000Z'),
        updatedAt: new Date('2026-08-04T09:00:00.000Z'),
        notification: {
            id: 'notification-1',
            userId: 'user-1',
            type: 'PRACTICE_READY',
            title: 'Practice ready',
            body: 'Ready.',
            href: '/practice',
            metadata: {},
            itemCount: 1,
            secondaryCount: 1,
            dedupeKey: 'practice-ready:user-1:day',
            readAt: null,
            archivedAt: null,
            createdAt: new Date('2026-08-04T08:00:00.000Z'),
            updatedAt: new Date('2026-08-04T08:00:00.000Z'),
        },
        user: { id: 'user-1', email: 'player@example.net' },
    };
}

describe('notification email delivery safety', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllEnvs();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T10:00:00.000Z'));
        vi.stubEnv('SMTP2GO_API_KEY', 'api-test');
        vi.stubEnv(
            'BACKRANQ_EMAIL_FROM',
            'Backranq <notifications@example.com>'
        );
        sendSmtp2GoEmailMock.mockReset();
        sendSmtp2GoEmailMock.mockResolvedValue('smtp2go-email-id');
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue(
            practiceDelivery()
        );
        prismaMock.notificationPreference.findUnique.mockResolvedValue(preference);
        prismaMock.notificationDelivery.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'delivery-1' });
        prismaMock.notificationDelivery.count.mockResolvedValue(1);
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'message-1',
        });
    });

    it('cancels an optional email when its preference changed before provider send', async () => {
        prismaMock.notificationPreference.findUnique.mockResolvedValue({
            ...preference,
            emailPracticeReady: false,
        });
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1')).resolves.toEqual({
            status: 'CANCELLED',
        });
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: { id: 'delivery-1', status: 'PROCESSING' },
            data: expect.objectContaining({ status: 'CANCELLED', lockedUntil: null }),
        });
    });

    it('cancels a second practice-ready email in the same local calendar day', async () => {
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValueOnce({
            id: 'already-sent',
        });
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1')).resolves.toEqual({
            status: 'CANCELLED',
        });
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
        expect(prismaMock.notificationDelivery.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({
                            status: 'FAILED',
                            lastError: {
                                contains: 'delivery state is unknown',
                            },
                        }),
                    ]),
                }),
            })
        );
    });

    it('does not retry an optional email after an ambiguous SMTP2GO request', async () => {
        const { processNotificationDelivery } = await importDelivery();
        const { Smtp2GoAmbiguousSendError } = await import(
            '@/lib/notifications/smtp2go'
        );
        sendSmtp2GoEmailMock.mockRejectedValue(
            new Smtp2GoAmbiguousSendError('Delivery state is unknown')
        );

        await expect(processNotificationDelivery('delivery-1')).rejects.toThrow(
            'Delivery state is unknown'
        );
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: { id: 'delivery-1', status: 'PROCESSING' },
            data: expect.objectContaining({ status: 'FAILED', lockedUntil: null }),
        });
    });

    it('does not overwrite a webhook state that wins the ambiguous-response race', async () => {
        prismaMock.notificationDelivery.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        const { processNotificationDelivery } = await importDelivery();
        const { Smtp2GoAmbiguousSendError } = await import(
            '@/lib/notifications/smtp2go'
        );
        sendSmtp2GoEmailMock.mockRejectedValue(
            new Smtp2GoAmbiguousSendError('Delivery state is unknown')
        );

        await expect(processNotificationDelivery('delivery-1')).resolves.toEqual({
            status: 'SKIPPED',
        });
    });

    it('does not retry an essential billing email after an ambiguous send', async () => {
        const billingDelivery = {
            ...practiceDelivery(),
            notification: {
                ...practiceDelivery().notification,
                type: 'BILLING_ACTION_REQUIRED',
            },
        };
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue(
            billingDelivery
        );
        const { processNotificationDelivery } = await importDelivery();
        const { Smtp2GoAmbiguousSendError } = await import(
            '@/lib/notifications/smtp2go'
        );
        sendSmtp2GoEmailMock.mockRejectedValue(
            new Smtp2GoAmbiguousSendError('Delivery state is unknown')
        );

        await expect(processNotificationDelivery('delivery-1')).rejects.toThrow(
            'Delivery state is unknown'
        );
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: { id: 'delivery-1', status: 'PROCESSING' },
            data: expect.objectContaining({ status: 'FAILED' }),
        });
        expect(prismaMock.notificationDelivery.count).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    OR: expect.arrayContaining([
                        expect.objectContaining({
                            status: 'FAILED',
                            lastError: {
                                contains: 'delivery state is unknown',
                            },
                        }),
                    ]),
                }),
            })
        );
    });

    it('dispatches billing email before optional email and preserves its reserve', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.count.mockResolvedValue(25);
        prismaMock.notificationDelivery.findMany
            .mockResolvedValueOnce([
                {
                    id: 'billing-delivery',
                    channel: 'EMAIL',
                    attempts: 0,
                    scheduledFor: new Date('2026-08-04T08:00:00.000Z'),
                    notification: { type: 'BILLING_ACTION_REQUIRED' },
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 'practice-delivery',
                    channel: 'EMAIL',
                    attempts: 0,
                    scheduledFor: new Date('2026-08-04T07:00:00.000Z'),
                    notification: { type: 'PRACTICE_READY' },
                },
            ]);
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        const result = await dispatchPendingNotificationDeliveries(10);

        expect(result).toEqual([{ deliveryId: 'billing-delivery', queued: true }]);
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ deliveryId: 'billing-delivery' }),
            expect.any(Object)
        );
    });

    it('schedules a delayed queue sweep for the next future delivery', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue({
            scheduledFor: new Date('2026-08-04T11:00:00.000Z'),
        });
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();

        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            {
                type: 'notification-sweep',
                requestedAt: '2026-08-04T10:00:00.000Z',
            },
            {
                idempotencyKey:
                    'notification-sweep:final:2026-08-04T11:00:00.000Z',
                delaySeconds: 3600,
                retentionSeconds: 604800,
            }
        );
    });

    it('deduplicates final sweeps independently of the dispatcher milliseconds', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue({
            scheduledFor: new Date('2026-08-04T11:00:00.000Z'),
        });
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();
        vi.setSystemTime(new Date('2026-08-04T10:00:00.500Z'));
        await dispatchPendingNotificationDeliveries();

        const sweepOptions = publishBackranqQueueMessageMock.mock.calls
            .filter(([message]) => message.type === 'notification-sweep')
            .map(([, options]) => options);
        expect(sweepOptions).toHaveLength(2);
        expect(sweepOptions[0].idempotencyKey).toBe(
            'notification-sweep:final:2026-08-04T11:00:00.000Z'
        );
        expect(sweepOptions[1].idempotencyKey).toBe(
            sweepOptions[0].idempotencyKey
        );
    });

    it('caps long sweep delays below queue retention and chains another wake-up', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue({
            scheduledFor: new Date('2026-08-14T10:00:00.000Z'),
        });
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();

        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            {
                idempotencyKey:
                    'notification-sweep:checkpoint:2026-08-14T10:00:00.000Z:2026-08-04',
                delaySeconds: 518400,
                retentionSeconds: 604800,
            }
        );
    });

    it('schedules a new sweep when a practice email moves to its digest hour', async () => {
        prismaMock.notificationPreference.findUnique.mockResolvedValue({
            ...preference,
            digestHour: 11,
        });
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue({
            scheduledFor: new Date('2026-08-04T11:00:00.000Z'),
        });
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1')).resolves.toEqual({
            status: 'RESCHEDULED',
        });
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            expect.objectContaining({ delaySeconds: 3600 })
        );
    });

    it('schedules a new sweep after a retryable provider failure', async () => {
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'delivery-1' })
            .mockResolvedValueOnce({
                scheduledFor: new Date('2026-08-04T10:02:00.000Z'),
            });
        sendSmtp2GoEmailMock.mockRejectedValue(new Error('Temporary failure'));
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1')).rejects.toThrow(
            'Temporary failure'
        );
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            expect.objectContaining({ delaySeconds: 120 })
        );
    });
});
