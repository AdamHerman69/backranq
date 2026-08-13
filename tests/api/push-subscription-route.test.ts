import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createECDH } from 'node:crypto';
import { createJsonRequest, readJson } from '../helpers/route';
import {
    mockAuthModule,
    mockPrismaModule,
    prismaMock,
    setMockUserId,
} from '../helpers/route-mocks';

const validSubscription = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/subscription-id',
    keys: {
        p256dh: createECDH('prime256v1').generateKeys().toString('base64url'),
        auth: Buffer.alloc(16, 2).toString('base64url'),
    },
};

function pushRequest(body: unknown, ownerId = 'user-1') {
    return createJsonRequest(
        'http://localhost/api/notifications/push-subscription',
        body,
        { headers: { 'X-Backranq-Owner-Id': ownerId } }
    );
}

async function importRoute() {
    vi.resetModules();
    mockAuthModule();
    mockPrismaModule();
    return import('@/app/api/notifications/push-subscription/route');
}

describe('/api/notifications/push-subscription', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setMockUserId('user-1');
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'configured';
        prismaMock.$transaction.mockImplementation(async (callback: unknown) =>
            (callback as (tx: typeof prismaMock) => Promise<unknown>)(prismaMock)
        );
        prismaMock.$queryRaw.mockResolvedValue([{ acquired: true }]);
        prismaMock.pushSubscription.findUnique.mockResolvedValue(null);
        prismaMock.pushSubscription.count.mockResolvedValue(0);
        prismaMock.pushSubscription.create.mockResolvedValue({});
        prismaMock.pushSubscription.updateMany.mockResolvedValue({ count: 1 });
        prismaMock.notificationPreference.upsert.mockResolvedValue({});
        prismaMock.notificationPreference.update.mockResolvedValue({});
    });

    it('rejects arbitrary HTTPS endpoints before persistence', async () => {
        const route = await importRoute();
        const response = await route.POST(
            pushRequest({
                ...validSubscription,
                endpoint: 'https://127.0.0.1/internal',
            })
        );

        expect(response.status).toBe(400);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('rejects malformed Web Push key material', async () => {
        const route = await importRoute();
        const response = await route.POST(
            pushRequest({
                ...validSubscription,
                keys: { p256dh: 'short', auth: 'short' },
            })
        );

        expect(response.status).toBe(400);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('accepts a valid browser push subscription', async () => {
        const route = await importRoute();
        const response = await route.POST(
            pushRequest(validSubscription)
        );

        expect(response.status).toBe(200);
        await expect(readJson(response)).resolves.toEqual({
            ownerId: 'user-1',
            subscribed: true,
        });
        expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
        expect(prismaMock.pushSubscription.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                endpoint: validSubscription.endpoint,
            }),
        });
    });

    it('caps subscriptions created for one user', async () => {
        prismaMock.pushSubscription.count.mockResolvedValue(10);
        const route = await importRoute();
        const response = await route.POST(
            pushRequest(validSubscription)
        );

        expect(response.status).toBe(409);
        expect(prismaMock.pushSubscription.upsert).not.toHaveBeenCalled();
    });

    it('rate limits repeated subscription mutations for one user', async () => {
        const route = await importRoute();
        let response: Response | undefined;
        for (let index = 0; index < 21; index += 1) {
            response = await route.POST(
                pushRequest(validSubscription)
            );
        }

        expect(response?.status).toBe(429);
        expect(response?.headers.get('retry-after')).toBe('60');
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(20);
    });

    it('rejects a stale owner before parsing or persisting a subscription', async () => {
        const route = await importRoute();
        const response = await route.POST(
            pushRequest(validSubscription, 'user-a')
        );

        expect(response.status).toBe(409);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a stale owner before deleting a subscription', async () => {
        const route = await importRoute();
        const response = await route.DELETE(
            new Request(
                `http://localhost/api/notifications/push-subscription?endpoint=${encodeURIComponent(validSubscription.endpoint)}`,
                {
                    method: 'DELETE',
                    headers: { 'X-Backranq-Owner-Id': 'user-a' },
                }
            )
        );

        expect(response.status).toBe(409);
        expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
});
