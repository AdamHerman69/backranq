import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readJson } from '../helpers/route';
import { mockPrismaModule, prismaMock } from '../helpers/route-mocks';

const verifyUnsubscribeTokenMock = vi.fn<(token: string) => string | null>();

async function importRoute() {
    vi.resetModules();
    mockPrismaModule();
    vi.doMock('@/lib/notifications/tokens', () => ({
        verifyUnsubscribeToken: verifyUnsubscribeTokenMock,
    }));
    return import('@/app/api/notifications/unsubscribe/route');
}

describe('/api/notifications/unsubscribe', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        verifyUnsubscribeTokenMock.mockImplementation((token) =>
            token === 'valid' ? 'user-1' : null
        );
        prismaMock.notificationPreference.upsert.mockResolvedValue({});
        prismaMock.notificationDelivery.updateMany.mockResolvedValue({ count: 2 });
        prismaMock.$transaction.mockImplementation(async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
        );
    });

    it('keeps confirmation GET read-only', async () => {
        const route = await importRoute();
        const response = await route.GET(
            new Request('http://localhost/api/notifications/unsubscribe?token=valid')
        );

        expect(response.status).toBe(200);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
        expect(prismaMock.notificationPreference.upsert).not.toHaveBeenCalled();
    });

    it('atomically upserts opt-out state and cancels pending deliveries', async () => {
        const route = await importRoute();
        const response = await route.POST(
            new Request('http://localhost/api/notifications/unsubscribe?token=valid', {
                method: 'POST',
            })
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({ unsubscribed: true });
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
        expect(prismaMock.notificationPreference.upsert).toHaveBeenCalledTimes(1);
        expect(prismaMock.notificationDelivery.updateMany).toHaveBeenCalledTimes(1);
    });

    it('cancels optional emails while preserving push and essential deliveries', async () => {
        const deliveries = [
            ['user-1', 'EMAIL', 'PRACTICE_READY', 'PENDING'],
            ['user-1', 'EMAIL', 'WEEKLY_PROGRESS', 'QUEUED'],
            ['user-1', 'WEB_PUSH', 'PRACTICE_READY', 'PENDING'],
            ['user-1', 'WEB_PUSH', 'WEEKLY_PROGRESS', 'QUEUED'],
            ['user-1', 'EMAIL', 'BILLING_ACTION_REQUIRED', 'PENDING'],
            ['user-1', 'EMAIL', 'PRACTICE_READY', 'SENT'],
            ['user-2', 'EMAIL', 'PRACTICE_READY', 'PENDING'],
        ].map(([userId, channel, type, status]) => ({
            userId, channel, type, status,
        }));
        prismaMock.notificationDelivery.updateMany.mockImplementation(
            async (args: unknown) => {
                const { where, data } = args as {
                    where: {
                        userId: string;
                        channel?: string;
                        status: { in: string[] };
                        notification: { type: { in: string[] } };
                    };
                    data: { status: string };
                };
                let count = 0;
                for (const delivery of deliveries) {
                    if (
                        delivery.userId === where.userId &&
                        (!where.channel || delivery.channel === where.channel) &&
                        where.status.in.includes(delivery.status) &&
                        where.notification.type.in.includes(delivery.type)
                    ) {
                        delivery.status = data.status;
                        count += 1;
                    }
                }
                return { count };
            }
        );
        const route = await importRoute();

        const response = await route.POST(
            new Request('http://localhost/api/notifications/unsubscribe?token=valid', {
                method: 'POST',
            })
        );

        expect(response.status).toBe(200);
        expect(deliveries.map((delivery) => delivery.status)).toEqual([
            'CANCELLED',
            'CANCELLED',
            'PENDING',
            'QUEUED',
            'PENDING',
            'SENT',
            'PENDING',
        ]);
    });
});
