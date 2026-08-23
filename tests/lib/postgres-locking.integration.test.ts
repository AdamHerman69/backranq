import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireTransactionAdvisoryLock } from '@/lib/db/advisoryLock';
import { savePushSubscription } from '@/lib/notifications/pushSubscriptions';
import { recordOnboardingAnalyticsEvent } from '@/lib/onboarding/analyticsPersistence';
import { readSyncStatusSnapshot } from '@/lib/services/syncStatusRead';
import { withRequestTrace } from '@/lib/performance/requestTrace';

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

    it('records concurrent onboarding events without interactive transaction contention', async () => {
        const sessionId = '10000000-0000-4000-8000-000000000099';
        const namespace = 'onboarding-events';
        const events = Array.from({ length: 20 }, (_, index) => ({
            eventName: 'LANDING_VIEWED' as const,
            sessionId,
            eventId: `concurrent-event-${String(index).padStart(2, '0')}`,
            occurredAt: new Date().toISOString(),
        }));

        const results = await Promise.all(
            events.map((event) => recordOnboardingAnalyticsEvent(event, db))
        );

        expect(results.every((result) => result.recorded)).toBe(true);
        await expect(
            db.onboardingAnalyticsEvent.count({ where: { sessionId } })
        ).resolves.toBe(20);
        await db.onboardingAnalyticsEvent.deleteMany({ where: { sessionId } });
        await db.onboardingRateBucket.deleteMany({ where: { namespace } });
    });

    it('assembles the compact sync status snapshot with PostgreSQL aggregates', async () => {
        let snapshot: Awaited<ReturnType<typeof readSyncStatusSnapshot>>;
        const response = await withRequestTrace(
            { route: '/integration/sync-status' },
            async () => {
                snapshot = await readSyncStatusSnapshot(userIds[0]!, {
                    now: new Date('2026-08-23T12:00:00.000Z'),
                });
                return Response.json(snapshot);
            }
        );

        expect(snapshot!.ownerId).toBe(userIds[0]);
        expect(snapshot!.inventory).toEqual({
            totalImported: 0,
            analyzed: 0,
            unanalyzed: 0,
        });
        expect(snapshot!.analysisJobs).toEqual({
            queued: 0,
            running: 0,
            failed: 0,
        });
        const operationCount = Number(
            response.headers.get('x-backranq-db-operation-count')
        );
        expect(operationCount).toBeGreaterThanOrEqual(6);
        expect(operationCount).toBeLessThanOrEqual(8);
    });
});
