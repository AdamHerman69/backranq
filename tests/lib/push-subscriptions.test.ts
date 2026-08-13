import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    deletePushSubscription,
    savePushSubscription,
} from '@/lib/notifications/pushSubscriptions';

function pushDb() {
    const tx = {
        $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]),
        pushSubscription: {
            findUnique: vi.fn(),
            count: vi.fn().mockResolvedValue(0),
            create: vi.fn().mockResolvedValue({}),
            updateMany: vi.fn().mockResolvedValue({ count: 1 }),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        notificationPreference: {
            upsert: vi.fn().mockResolvedValue({}),
            update: vi.fn().mockResolvedValue({}),
        },
    };
    return {
        tx,
        db: {
            $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) =>
                operation(tx)
            ),
        },
    };
}

const input = {
    userId: 'user-1',
    endpoint: 'https://fcm.googleapis.com/fcm/send/device-1',
    p256dh: 'public-key',
    auth: 'auth-key',
    userAgent: 'browser',
    maxSubscriptions: 10,
};

describe('push subscription mutations', () => {
    beforeEach(() => vi.clearAllMocks());

    it('never transfers an endpoint owned by another user', async () => {
        const { db, tx } = pushDb();
        tx.pushSubscription.findUnique.mockResolvedValue({
            userId: 'user-2',
        });

        await expect(
            savePushSubscription({ ...input, db: db as never })
        ).resolves.toBe('owner-conflict');

        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.pushSubscription.create).not.toHaveBeenCalled();
        expect(tx.pushSubscription.updateMany).not.toHaveBeenCalled();
    });

    it('updates keys without making userId mutable', async () => {
        const { db, tx } = pushDb();
        tx.pushSubscription.findUnique.mockResolvedValue({
            userId: 'user-1',
        });

        await expect(
            savePushSubscription({ ...input, db: db as never })
        ).resolves.toBe('saved');

        expect(tx.pushSubscription.updateMany).toHaveBeenCalledWith({
            where: { endpoint: input.endpoint, userId: input.userId },
            data: {
                p256dh: input.p256dh,
                auth: input.auth,
                userAgent: input.userAgent,
            },
        });
        expect(
            tx.pushSubscription.updateMany.mock.calls[0]?.[0]?.data
        ).not.toHaveProperty('userId');
    });

    it('serializes deletion with subscribe and disables push only at zero', async () => {
        const { db, tx } = pushDb();
        tx.pushSubscription.count.mockResolvedValue(0);

        await expect(
            deletePushSubscription({
                userId: input.userId,
                endpoint: input.endpoint,
                db: db as never,
            })
        ).resolves.toEqual({ deleted: 1 });

        expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
        expect(tx.notificationPreference.update).toHaveBeenCalledWith({
            where: { userId: input.userId },
            data: { pushEnabled: false },
        });
    });
});
