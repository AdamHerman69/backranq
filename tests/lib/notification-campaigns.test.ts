import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, serviceMocks, publishQueueMock } = vi.hoisted(() => ({
    prismaMock: {
        analysisJob: { findMany: vi.fn() },
        syncJob: { findMany: vi.fn() },
        user: { findMany: vi.fn() },
        notificationPreference: { findMany: vi.fn() },
        trainingAttempt: { groupBy: vi.fn() },
        trainingMoment: { groupBy: vi.fn() },
        notification: { findMany: vi.fn() },
    },
    serviceMocks: {
        recordAnalysisFailed: vi.fn(),
        recordSyncFailed: vi.fn(),
        recordWelcome: vi.fn(),
        recordNotification: vi.fn(),
    },
    publishQueueMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/notifications/service', () => serviceMocks);
vi.mock('@/lib/queues/backranq', () => ({
    publishBackranqQueueMessage: publishQueueMock,
}));

import {
    generateDueWeeklyProgressNotifications,
    reconcileRecentNotificationEvents,
    runNotificationMaintenance,
} from '@/lib/notifications/campaigns';

describe('notification campaigns', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        serviceMocks.recordNotification.mockResolvedValue({ id: 'notification' });
        publishQueueMock.mockResolvedValue({ queued: true, messageId: 'message-1' });
    });

    it('pages through all recent failures and replays existing notification keys to repair delivery', async () => {
        const firstPage = Array.from({ length: 200 }, (_, index) => ({
            id: `analysis-${String(index).padStart(3, '0')}`,
            userId: 'user-1',
            gameId: `game-${index}`,
            lastError: 'failed',
        }));
        prismaMock.analysisJob.findMany
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([
                {
                    id: 'analysis-existing-notification',
                    userId: 'user-1',
                    gameId: 'game-last',
                    lastError: 'failed',
                },
            ]);
        prismaMock.syncJob.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);

        const first = await reconcileRecentNotificationEvents(
            new Date('2026-08-04T12:00:00.000Z')
        );
        const second = await reconcileRecentNotificationEvents(
            new Date('2026-08-04T12:00:00.000Z'),
            first.next
        );

        expect(first.analysisFailures + second.analysisFailures).toBe(201);
        expect(serviceMocks.recordAnalysisFailed).toHaveBeenCalledTimes(201);
        expect(prismaMock.analysisJob.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({
                cursor: { id: 'analysis-199' },
                skip: 1,
            })
        );
    });

    it('pages beyond the first users and catches up a weekly digest after its Monday hour', async () => {
        const firstPage = Array.from({ length: 200 }, (_, index) => ({
            userId: `user-${String(index).padStart(3, '0')}`,
            timezone: 'UTC',
            digestHour: 9,
        }));
        prismaMock.notificationPreference.findMany
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([
                { userId: 'user-200', timezone: 'UTC', digestHour: 9 },
            ]);
        prismaMock.trainingAttempt.groupBy
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ userId: 'user-200', _count: { id: 4 } }])
            .mockResolvedValueOnce([{ userId: 'user-200', _count: { id: 3 } }]);
        prismaMock.trainingMoment.groupBy
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ userId: 'user-200', _count: { id: 2 } }]);
        prismaMock.notification.findMany.mockResolvedValue([]);

        const first = await generateDueWeeklyProgressNotifications(
            new Date('2026-08-03T14:00:00.000Z')
        );
        const second = await generateDueWeeklyProgressNotifications(
            new Date('2026-08-03T14:00:00.000Z'),
            first.nextCursor
        );

        expect(first.eligible + second.eligible).toBe(201);
        expect(first.created + second.created).toBe(1);
        expect(serviceMocks.recordNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                userId: 'user-200',
                dedupeKey: 'weekly-progress:user-200:2026-08-03',
                itemCount: 4,
                secondaryCount: 2,
            })
        );
        expect(prismaMock.notificationPreference.findMany).toHaveBeenLastCalledWith(
            expect.objectContaining({ cursor: { userId: 'user-199' }, skip: 1 })
        );
    });

    it('repairs a missing weekly email without incrementing stored aggregates', async () => {
        prismaMock.notificationPreference.findMany.mockResolvedValue([
            { userId: 'user-1', timezone: 'UTC', digestHour: 9 },
        ]);
        prismaMock.trainingAttempt.groupBy
            .mockResolvedValueOnce([{ userId: 'user-1', _count: { id: 4 } }])
            .mockResolvedValueOnce([{ userId: 'user-1', _count: { id: 3 } }]);
        prismaMock.trainingMoment.groupBy.mockResolvedValue([
            { userId: 'user-1', _count: { id: 2 } },
        ]);
        prismaMock.notification.findMany.mockResolvedValue([
            {
                dedupeKey: 'weekly-progress:user-1:2026-08-03',
                deliveries: [],
            },
        ]);

        const result = await generateDueWeeklyProgressNotifications(
            new Date('2026-08-03T14:00:00.000Z')
        );

        expect(result.created).toBe(0);
        expect(serviceMocks.recordNotification).toHaveBeenCalledWith(
            expect.objectContaining({ itemCount: 0, secondaryCount: 0 })
        );
    });

    it('waits for the current Monday digest hour instead of sending two periods', async () => {
        prismaMock.notificationPreference.findMany.mockResolvedValue([
            { userId: 'user-1', timezone: 'UTC', digestHour: 9 },
        ]);
        prismaMock.trainingAttempt.groupBy
            .mockResolvedValueOnce([{ userId: 'user-1', _count: { id: 1 } }])
            .mockResolvedValueOnce([{ userId: 'user-1', _count: { id: 1 } }]);
        prismaMock.trainingMoment.groupBy.mockResolvedValue([]);
        prismaMock.notification.findMany.mockResolvedValue([]);

        await generateDueWeeklyProgressNotifications(
            new Date('2026-08-03T08:00:00.000Z')
        );
        expect(serviceMocks.recordNotification).not.toHaveBeenCalled();

        await generateDueWeeklyProgressNotifications(
            new Date('2026-08-03T09:00:00.000Z')
        );
        expect(serviceMocks.recordNotification).toHaveBeenCalledTimes(1);
        expect(serviceMocks.recordNotification).toHaveBeenCalledWith(
            expect.objectContaining({
                dedupeKey: 'weekly-progress:user-1:2026-08-03',
            })
        );
    });

    it('does not send an old catch-up on Sunday before the next weekly slot', async () => {
        prismaMock.notificationPreference.findMany.mockResolvedValue([
            { userId: 'user-1', timezone: 'UTC', digestHour: 9 },
        ]);
        prismaMock.trainingAttempt.groupBy
            .mockResolvedValueOnce([{ userId: 'user-1', _count: { id: 1 } }])
            .mockResolvedValueOnce([{ userId: 'user-1', _count: { id: 1 } }]);
        prismaMock.trainingMoment.groupBy.mockResolvedValue([]);
        prismaMock.notification.findMany.mockResolvedValue([]);

        await generateDueWeeklyProgressNotifications(
            new Date('2026-08-02T14:00:00.000Z')
        );
        expect(serviceMocks.recordNotification).not.toHaveBeenCalled();

        await generateDueWeeklyProgressNotifications(
            new Date('2026-08-03T09:00:00.000Z')
        );
        expect(serviceMocks.recordNotification).toHaveBeenCalledTimes(1);
    });

    it('continues bounded maintenance pages through the durable queue', async () => {
        prismaMock.analysisJob.findMany.mockResolvedValue([]);
        prismaMock.syncJob.findMany.mockResolvedValue([]);
        prismaMock.user.findMany.mockResolvedValue([]);
        prismaMock.notificationPreference.findMany.mockResolvedValue(
            Array.from({ length: 200 }, (_, index) => ({
                userId: `user-${String(index).padStart(3, '0')}`,
                timezone: 'UTC',
                digestHour: 9,
            }))
        );
        prismaMock.trainingAttempt.groupBy.mockResolvedValue([]);
        prismaMock.trainingMoment.groupBy.mockResolvedValue([]);
        prismaMock.notification.findMany.mockResolvedValue([]);

        const result = await runNotificationMaintenance({
            referenceAt: new Date('2026-08-03T14:00:00.000Z'),
        });

        expect(result.continuationQueued).toBe(true);
        expect(publishQueueMock).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'notification-maintenance',
                weeklyCursor: 'user-199',
            }),
            expect.objectContaining({
                idempotencyKey: expect.stringContaining('user-199'),
            })
        );
    });
});
