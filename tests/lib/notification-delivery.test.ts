import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const sendSmtp2GoEmailMock = vi.fn();
const sendReservedSmtp2GoEmailMock = vi.fn();
const publishBackranqQueueMessageMock = vi.fn();
const getPracticeDueSummaryMock = vi.fn();

class EmailBudgetUnavailableErrorMock extends Error {
    readonly retryAt: Date;

    constructor(retryAt: Date) {
        super('SMTP2GO daily safety budget is exhausted');
        this.retryAt = retryAt;
    }
}

class PracticeEmailWindowClaimedErrorMock extends Error {}
class EmailAttemptInProgressErrorMock extends Error {
    readonly retryAt: Date;

    constructor(retryAt: Date) {
        super('This logical email attempt is already in progress');
        this.retryAt = retryAt;
    }
}

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
    vi.doMock('@/lib/training/practiceDue', () => ({
        getPracticeDueSummary: getPracticeDueSummaryMock,
    }));
    vi.doMock('@/lib/notifications/emailReservations', () => ({
        EmailAttemptInProgressError: EmailAttemptInProgressErrorMock,
        EmailBudgetUnavailableError: EmailBudgetUnavailableErrorMock,
        PracticeEmailWindowClaimedError: PracticeEmailWindowClaimedErrorMock,
        sendReservedSmtp2GoEmail: sendReservedSmtp2GoEmailMock,
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
        dispatchToken: 'dispatch-1',
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

function scheduledDelivery(id: string, scheduledFor: string) {
    return {
        id,
        scheduledFor: new Date(scheduledFor),
        createdAt: new Date('2026-08-04T08:00:00.000Z'),
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
        sendReservedSmtp2GoEmailMock.mockReset();
        sendReservedSmtp2GoEmailMock.mockImplementation(
            async (args: { email: unknown }) =>
                sendSmtp2GoEmailMock(args.email)
        );
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue(
            practiceDelivery()
        );
        prismaMock.notificationPreference.findUnique.mockResolvedValue(preference);
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
        publishBackranqQueueMessageMock.mockResolvedValue({
            queued: true,
            messageId: 'message-1',
        });
        getPracticeDueSummaryMock.mockReset();
        getPracticeDueSummaryMock.mockResolvedValue({ state: 'UNKNOWN' });
        prismaMock.$queryRaw.mockResolvedValue([]);
    });

    it('cancels an optional email when its preference changed before provider send', async () => {
        prismaMock.notificationPreference.findUnique.mockResolvedValue({
            ...preference,
            emailPracticeReady: false,
        });
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).resolves.toEqual({
            status: 'CANCELLED',
        });
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                status: 'PROCESSING',
                dispatchToken: 'dispatch-1',
            },
            data: expect.objectContaining({ status: 'CANCELLED', lockedUntil: null }),
        });
    });

    it('replays a notification logical attempt with a new dispatch token without a second provider call', async () => {
        const sentAttempts = new Map<string, string>();
        sendReservedSmtp2GoEmailMock.mockImplementation(
            async (args: {
                logicalAttemptKey: string;
                ownerToken: string;
                email: unknown;
            }) => {
                const replay = sentAttempts.get(args.logicalAttemptKey);
                if (replay) return replay;
                const providerId = await sendSmtp2GoEmailMock(args.email);
                sentAttempts.set(args.logicalAttemptKey, providerId);
                return providerId;
            }
        );
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-1')
        ).resolves.toMatchObject({ status: 'SENT' });
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue({
            ...practiceDelivery(),
            dispatchToken: 'dispatch-2',
        });
        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-2')
        ).resolves.toMatchObject({ status: 'SENT' });

        expect(sendSmtp2GoEmailMock).toHaveBeenCalledOnce();
        expect(sendReservedSmtp2GoEmailMock).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                ownerToken: 'dispatch-1',
                logicalAttemptKey: 'notification-delivery:delivery-1',
            })
        );
        expect(sendReservedSmtp2GoEmailMock).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                ownerToken: 'dispatch-2',
                logicalAttemptKey: 'notification-delivery:delivery-1',
            })
        );
    });

    it('cancels a second practice email when the durable local-day window is already claimed', async () => {
        sendReservedSmtp2GoEmailMock.mockRejectedValue(
            new PracticeEmailWindowClaimedErrorMock()
        );
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).resolves.toEqual({
            status: 'CANCELLED',
        });
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
        expect(sendReservedSmtp2GoEmailMock).toHaveBeenCalledWith(
            expect.objectContaining({
                practiceWindowKey: expect.stringContaining(
                    'practice-email:user-1:'
                ),
            })
        );
    });

    it('cancels a due reminder completed before provider delivery', async () => {
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue({
            ...practiceDelivery(),
            notification: {
                ...practiceDelivery().notification,
                type: 'PRACTICE_DUE',
                href: '/practice?mode=review',
            },
        });
        getPracticeDueSummaryMock.mockResolvedValue({ state: 'EMPTY' });
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-1')
        ).resolves.toEqual({ status: 'CANCELLED' });
        expect(getPracticeDueSummaryMock).toHaveBeenCalledWith('user-1');
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
    });

    it('preserves a durable due snapshot when a bounded live recheck is unknown', async () => {
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue({
            ...practiceDelivery(),
            notification: {
                ...practiceDelivery().notification,
                type: 'PRACTICE_DUE',
                href: '/practice?mode=review',
                itemCount: 100,
                metadata: {
                    dueCountIsExact: false,
                    generatedAt: '2026-08-04T08:00:00.000Z',
                },
            },
        });
        getPracticeDueSummaryMock.mockResolvedValue({ state: 'UNKNOWN' });
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-1')
        ).resolves.toMatchObject({ status: 'SENT' });
        expect(getPracticeDueSummaryMock).toHaveBeenCalledTimes(2);
        expect(sendSmtp2GoEmailMock).toHaveBeenCalledTimes(1);
        expect(prismaMock.notification.update).not.toHaveBeenCalled();
    });

    it('refreshes a changed due count immediately before delivery', async () => {
        const delivery = {
            ...practiceDelivery(),
            notification: {
                ...practiceDelivery().notification,
                type: 'PRACTICE_DUE',
                href: '/practice?mode=review',
                itemCount: 5,
            },
        };
        prismaMock.notificationDelivery.findUniqueOrThrow.mockResolvedValue(
            delivery
        );
        getPracticeDueSummaryMock.mockResolvedValue({
            state: 'DUE',
            summary: {
                userId: 'user-1',
                dueCount: 2,
                dueCountIsExact: true,
                earliestDueAt: new Date('2026-08-01T09:00:00.000Z'),
            },
        });
        prismaMock.notification.update.mockResolvedValue({});
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-1')
        ).resolves.toMatchObject({ status: 'SENT' });
        expect(prismaMock.notification.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'notification-1' },
                data: expect.objectContaining({ itemCount: 2 }),
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

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).rejects.toThrow(
            'Delivery state is unknown'
        );
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                status: 'PROCESSING',
                dispatchToken: 'dispatch-1',
            },
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

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).resolves.toEqual({
            status: 'SKIPPED',
        });
    });

    it('does not report SENT when a token-fenced terminal transition loses its lease', async () => {
        prismaMock.notificationDelivery.updateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 });
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-1')
        ).resolves.toEqual({ status: 'SKIPPED' });
        expect(sendSmtp2GoEmailMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a stale dispatch token before any provider work', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValueOnce({
            count: 0,
        });
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'stale-token')
        ).resolves.toEqual({ status: 'SKIPPED' });
        expect(prismaMock.notificationDelivery.findUniqueOrThrow).not.toHaveBeenCalled();
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
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

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).rejects.toThrow(
            'Delivery state is unknown'
        );
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                status: 'PROCESSING',
                dispatchToken: 'dispatch-1',
            },
            data: expect.objectContaining({ status: 'FAILED' }),
        });
        expect(sendReservedSmtp2GoEmailMock).toHaveBeenCalledWith(
            expect.objectContaining({ priority: true })
        );
    });

    it('publishes the bounded priority-first set returned by the atomic claim', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.$queryRaw.mockResolvedValue([
                {
                    id: 'billing-delivery',
                    channel: 'EMAIL',
                    attempts: 0,
                    scheduledFor: new Date('2026-08-04T08:00:00.000Z'),
                    dispatchToken: 'billing-token',
                },
                {
                    id: 'practice-delivery',
                    channel: 'EMAIL',
                    attempts: 0,
                    scheduledFor: new Date('2026-08-04T07:00:00.000Z'),
                    dispatchToken: 'practice-token',
                },
            ]);
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        const result = await dispatchPendingNotificationDeliveries(10);

        expect(result).toEqual([
            { deliveryId: 'billing-delivery', queued: true },
            { deliveryId: 'practice-delivery', queued: true },
        ]);
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ deliveryId: 'billing-delivery' }),
            expect.any(Object)
        );
    });

    it('claims from fixed index-backed streams before a bounded merge', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.$queryRaw.mockResolvedValue([]);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries(101);

        const queries = prismaMock.$queryRaw.mock.calls.map(
            ([query]) =>
                query as {
                    strings: readonly string[];
                    values: unknown[];
                }
        );
        const recovery = queries.find((query) =>
            query.strings.join('').includes('WITH expired AS MATERIALIZED')
        )!;
        const claim = queries.find((query) =>
            query.strings.join('').includes('WITH priority_email AS MATERIALIZED')
        )!;
        expect(recovery.strings.join('')).toContain(
            'FOR UPDATE SKIP LOCKED'
        );
        expect(recovery.values).toContain(100);
        const claimQuery = claim as {
            strings: readonly string[];
            values: unknown[];
        };
        const text = claimQuery.strings.join('');
        expect(text).toContain('FOR UPDATE OF delivery SKIP LOCKED');
        expect(text).toContain('optional_email AS MATERIALIZED');
        expect(text).toContain('push_candidates AS MATERIALIZED');
        expect(text).not.toContain('INNER JOIN "Notification"');
        expect(text).not.toContain('CASE');
        expect(text).toContain('"status" = \'QUEUED\'');
        expect(claimQuery.values).toContain(100);
        expect(claimQuery.values).toContain(20);
    });

    it('releases only its own queued token when publication fails', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.$queryRaw.mockResolvedValue([
            {
                id: 'delivery-failed-publish',
                channel: 'EMAIL',
                attempts: 0,
                scheduledFor: new Date('2026-08-04T09:00:00.000Z'),
                dispatchToken: 'publish-token',
                },
        ]);
        publishBackranqQueueMessageMock.mockRejectedValueOnce(
            new Error('queue unavailable')
        );
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await expect(dispatchPendingNotificationDeliveries()).rejects.toThrow(
            'queue unavailable'
        );
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-failed-publish',
                status: 'QUEUED',
                dispatchToken: 'publish-token',
            },
            data: expect.objectContaining({
                status: 'PENDING',
                dispatchToken: null,
                lockedUntil: null,
            }),
        });
    });

    it('continues stale-lease recovery after one bounded 100-row page', async () => {
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.$queryRaw.mockImplementation(async (query: unknown) => {
            const text = (
                query as { strings?: readonly string[] }
            ).strings?.join('');
            return text?.includes('WITH expired AS MATERIALIZED')
                ? Array.from({ length: 100 }, (_, index) => ({
                      id: `expired-${index}`,
                  }))
                : [];
        });
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(null);
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries(100);

        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            {
                type: 'notification-sweep',
                requestedAt: '2026-08-04T10:00:00.000Z',
            },
            {
                idempotencyKey:
                    'notification-sweep:recovery:expired-99:2026-08-04T10:00:00.000Z',
                delaySeconds: 1,
                retentionSeconds: 604800,
            }
        );
    });

    it('schedules a delayed queue sweep for the next future delivery', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(
            scheduledDelivery(
                'next-delivery',
                '2026-08-04T11:00:00.000Z'
            )
        );
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();

        expect(prismaMock.notificationDelivery.findFirst).toHaveBeenCalledWith({
            where: { status: 'PENDING', channel: 'EMAIL' },
            orderBy: [
                { scheduledFor: 'asc' },
                { createdAt: 'asc' },
                { id: 'asc' },
            ],
            select: { id: true, scheduledFor: true, createdAt: true },
        });

        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            {
                type: 'notification-sweep',
                requestedAt: '2026-08-04T10:00:00.000Z',
            },
            {
                idempotencyKey:
                    'notification-sweep:final:next-delivery:2026-08-04T11:00:00.000Z',
                delaySeconds: 3600,
                retentionSeconds: 604800,
            }
        );
    });

    it('immediately continues from the earliest overdue pending delivery', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.$queryRaw.mockResolvedValue([]);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(
            scheduledDelivery(
                'overdue-delivery',
                '2026-08-04T09:00:00.000Z'
            )
        );
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();

        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            expect.objectContaining({
                idempotencyKey:
                    'notification-sweep:final:overdue-delivery:2026-08-04T09:00:00.000Z',
                delaySeconds: 1,
            })
        );
    });

    it('deduplicates final sweeps independently of the dispatcher milliseconds', async () => {
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
        prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
        prismaMock.notificationDelivery.count.mockResolvedValue(0);
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(
            scheduledDelivery(
                'next-delivery',
                '2026-08-04T11:00:00.000Z'
            )
        );
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();
        vi.setSystemTime(new Date('2026-08-04T10:00:00.500Z'));
        await dispatchPendingNotificationDeliveries();

        const sweepOptions = publishBackranqQueueMessageMock.mock.calls
            .filter(([message]) => message.type === 'notification-sweep')
            .map(([, options]) => options);
        expect(sweepOptions).toHaveLength(2);
        expect(sweepOptions[0].idempotencyKey).toBe(
            'notification-sweep:final:next-delivery:2026-08-04T11:00:00.000Z'
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
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(
            scheduledDelivery(
                'next-delivery',
                '2026-08-14T10:00:00.000Z'
            )
        );
        const { dispatchPendingNotificationDeliveries } = await importDelivery();

        await dispatchPendingNotificationDeliveries();

        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            {
                idempotencyKey:
                    'notification-sweep:checkpoint:next-delivery:2026-08-14T10:00:00.000Z:2026-08-04',
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
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(
            scheduledDelivery(
                'digest-delivery',
                '2026-08-04T11:00:00.000Z'
            )
        );
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).resolves.toEqual({
            status: 'RESCHEDULED',
        });
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            expect.objectContaining({ delaySeconds: 3600 })
        );
    });

    it('schedules a new sweep after a retryable provider failure', async () => {
        prismaMock.notificationDelivery.findFirst.mockReset();
        prismaMock.notificationDelivery.findFirst.mockResolvedValue(
            scheduledDelivery(
                'retry-delivery',
                '2026-08-04T10:02:00.000Z'
            )
        );
        sendSmtp2GoEmailMock.mockRejectedValue(new Error('Temporary failure'));
        const { processNotificationDelivery } = await importDelivery();

        await expect(processNotificationDelivery('delivery-1', 'dispatch-1')).rejects.toThrow(
            'Temporary failure'
        );
        expect(publishBackranqQueueMessageMock).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'notification-sweep' }),
            expect.objectContaining({ delaySeconds: 120 })
        );
    });

    it('reschedules without provider work when the shared SMTP budget is exhausted', async () => {
        const retryAt = new Date('2026-08-05T00:05:00.000Z');
        sendReservedSmtp2GoEmailMock.mockRejectedValue(
            new EmailBudgetUnavailableErrorMock(retryAt)
        );
        const { processNotificationDelivery } = await importDelivery();

        await expect(
            processNotificationDelivery('delivery-1', 'dispatch-1')
        ).resolves.toEqual({ status: 'RESCHEDULED' });
        expect(sendSmtp2GoEmailMock).not.toHaveBeenCalled();
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'delivery-1',
                status: 'PROCESSING',
                dispatchToken: 'dispatch-1',
            },
            data: expect.objectContaining({
                status: 'PENDING',
                scheduledFor: retryAt,
            }),
        });
    });
});
