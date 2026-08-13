import type { Prisma, PrismaClient } from '@prisma/client';
import { acquireTransactionAdvisoryLock } from '@/lib/db/advisoryLock';
import { getOrCreateNotificationPreference } from '@/lib/notifications/service';
import { prisma } from '@/lib/prisma';

type PushSubscriptionDb = Pick<PrismaClient, '$transaction'>;

export type SavePushSubscriptionResult =
    | 'saved'
    | 'owner-conflict'
    | 'limit';

function endpointLockKey(endpoint: string) {
    return `push-subscription:endpoint:${endpoint}`;
}

function ownerLockKey(userId: string) {
    return `push-subscription:owner:${userId}`;
}

async function lockMutationStream(args: {
    tx: Prisma.TransactionClient;
    endpoint: string;
    userId: string;
}) {
    // Endpoint first, then owner, is the invariant for every mutation. It
    // serializes ownership checks and per-user caps without introducing a
    // different lock order between subscribe and unsubscribe.
    await acquireTransactionAdvisoryLock(
        args.tx,
        endpointLockKey(args.endpoint)
    );
    await acquireTransactionAdvisoryLock(
        args.tx,
        ownerLockKey(args.userId)
    );
}

export async function savePushSubscription(args: {
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    maxSubscriptions: number;
    db?: PushSubscriptionDb;
}): Promise<SavePushSubscriptionResult> {
    const db = args.db ?? prisma;
    return db.$transaction(async (tx) => {
        await lockMutationStream({
            tx,
            endpoint: args.endpoint,
            userId: args.userId,
        });
        const existing = await tx.pushSubscription.findUnique({
            where: { endpoint: args.endpoint },
            select: { userId: true },
        });
        if (existing && existing.userId !== args.userId) {
            return 'owner-conflict';
        }

        if (!existing) {
            const subscriptionCount = await tx.pushSubscription.count({
                where: { userId: args.userId },
            });
            if (subscriptionCount >= args.maxSubscriptions) return 'limit';
            await tx.pushSubscription.create({
                data: {
                    userId: args.userId,
                    endpoint: args.endpoint,
                    p256dh: args.p256dh,
                    auth: args.auth,
                    userAgent: args.userAgent,
                },
            });
        } else {
            const updated = await tx.pushSubscription.updateMany({
                where: {
                    endpoint: args.endpoint,
                    userId: args.userId,
                },
                data: {
                    p256dh: args.p256dh,
                    auth: args.auth,
                    userAgent: args.userAgent,
                },
            });
            if (updated.count !== 1) {
                throw new Error('Push subscription ownership changed');
            }
        }

        await getOrCreateNotificationPreference(args.userId, tx);
        await tx.notificationPreference.update({
            where: { userId: args.userId },
            data: { pushEnabled: true },
        });
        return 'saved';
    });
}

export async function deletePushSubscription(args: {
    userId: string;
    endpoint: string;
    db?: PushSubscriptionDb;
}) {
    const db = args.db ?? prisma;
    return db.$transaction(async (tx) => {
        await lockMutationStream({
            tx,
            endpoint: args.endpoint,
            userId: args.userId,
        });
        const result = await tx.pushSubscription.deleteMany({
            where: { userId: args.userId, endpoint: args.endpoint },
        });
        const remaining = await tx.pushSubscription.count({
            where: { userId: args.userId },
        });
        if (remaining === 0) {
            await getOrCreateNotificationPreference(args.userId, tx);
            await tx.notificationPreference.update({
                where: { userId: args.userId },
                data: { pushEnabled: false },
            });
        }
        return { deleted: result.count };
    });
}
