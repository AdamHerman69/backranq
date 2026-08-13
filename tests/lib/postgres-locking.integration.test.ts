import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTransactionAdvisoryLock } from '@/lib/db/advisoryLock';
import { savePushSubscription } from '@/lib/notifications/pushSubscriptions';

const runPostgresIntegration =
    process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true';
const integration = describe.runIf(runPostgresIntegration);
const db = new PrismaClient();
const userIds = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
];

integration('PostgreSQL locking integration', () => {
    beforeAll(async () => {
        await db.user.deleteMany({ where: { id: { in: userIds } } });
        await db.user.createMany({
            data: userIds.map((id, index) => ({
                id,
                email: `locking-${index}@backranq.test`,
                preferences: {},
            })),
        });
    });

    afterAll(async () => {
        await db.user.deleteMany({ where: { id: { in: userIds } } });
        await db.$disconnect();
    });

    it('acquires pg_advisory_xact_lock without deserializing void', async () => {
        await expect(
            db.$transaction(async (tx) => {
                await acquireTransactionAdvisoryLock(
                    tx,
                    'integration:void-safe'
                );
                return 'acquired';
            })
        ).resolves.toBe('acquired');
    });

    it('never transfers one endpoint between concurrent owners', async () => {
        const endpoint =
            'https://fcm.googleapis.com/fcm/send/locking-shared';
        const save = (userId: string) =>
            savePushSubscription({
                userId,
                endpoint,
                p256dh: `p256dh-${userId}`,
                auth: `auth-${userId}`,
                userAgent: null,
                maxSubscriptions: 10,
                db,
            });

        const results = await Promise.all(userIds.map(save));

        expect(results.sort()).toEqual(['owner-conflict', 'saved']);
        const stored = await db.pushSubscription.findUniqueOrThrow({
            where: { endpoint },
            select: { userId: true, p256dh: true },
        });
        expect(userIds).toContain(stored.userId);
        expect(stored.p256dh).toBe(`p256dh-${stored.userId}`);
    });

    it('serializes the per-owner cap across different endpoints', async () => {
        const userId = userIds[0]!;
        await db.pushSubscription.deleteMany({ where: { userId } });
        const save = (suffix: string) =>
            savePushSubscription({
                userId,
                endpoint: `https://fcm.googleapis.com/fcm/send/cap-${suffix}`,
                p256dh: `p256dh-${suffix}`,
                auth: `auth-${suffix}`,
                userAgent: null,
                maxSubscriptions: 1,
                db,
            });

        const results = await Promise.all([save('a'), save('b')]);

        expect(results.sort()).toEqual(['limit', 'saved']);
        await expect(
            db.pushSubscription.count({ where: { userId } })
        ).resolves.toBe(1);
    });
});
