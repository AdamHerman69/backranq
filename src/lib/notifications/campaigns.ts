import { prisma } from '@/lib/prisma';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { nextDigestAt } from './scheduling';
import {
    recordAnalysisFailed,
    recordNotification,
    recordSyncFailed,
    recordWelcome,
} from './service';
import {
    cleanupCompletedPracticeDueSweeps,
    schedulePracticeDueSweep,
} from '@/lib/training/practiceDueSweep';

const PAGE_SIZE = 200;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const WEEKLY_CATCHUP_GRACE_MS = 24 * 60 * 60_000;

type ReconcileCursors = {
    analysisCursor?: string | null;
    syncCursor?: string | null;
    userCursor?: string | null;
};

export async function reconcileRecentNotificationEvents(
    now = new Date(),
    cursors: ReconcileCursors = {},
    since = new Date(now.getTime() - WEEK_MS)
) {
    let analysisFailures = 0;
    let syncFailures = 0;
    let welcomeUsers = 0;

    const analysisJobs =
        cursors.analysisCursor === null
            ? []
            : await prisma.analysisJob.findMany({
                  where: {
                      status: 'FAILED',
                      completedAt: { gte: since },
                  },
                  orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
                  take: PAGE_SIZE,
                  ...(cursors.analysisCursor
                      ? {
                            cursor: { id: cursors.analysisCursor },
                            skip: 1,
                        }
                      : {}),
                  select: {
                      id: true,
                      userId: true,
                      gameId: true,
                      lastError: true,
                  },
              });
    for (const job of analysisJobs) {
        await recordAnalysisFailed({
            userId: job.userId,
            jobId: job.id,
            gameId: job.gameId,
            error: job.lastError ?? 'Analysis failed',
        });
    }
    analysisFailures = analysisJobs.length;

    const syncJobs =
        cursors.syncCursor === null
            ? []
            : await prisma.syncJob.findMany({
                  where: {
                      status: 'FAILED',
                      completedAt: { gte: since },
                  },
                  orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
                  take: PAGE_SIZE,
                  ...(cursors.syncCursor
                      ? { cursor: { id: cursors.syncCursor }, skip: 1 }
                      : {}),
                  select: {
                      id: true,
                      userId: true,
                      provider: true,
                      lastError: true,
                  },
              });
    for (const job of syncJobs) {
        await recordSyncFailed({
            userId: job.userId,
            jobId: job.id,
            provider: job.provider,
            error: job.lastError ?? 'Sync failed',
        });
    }
    syncFailures = syncJobs.length;

    const users =
        cursors.userCursor === null
            ? []
            : await prisma.user.findMany({
                  where: { createdAt: { gte: since } },
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                  take: PAGE_SIZE,
                  ...(cursors.userCursor
                      ? { cursor: { id: cursors.userCursor }, skip: 1 }
                      : {}),
                  select: { id: true },
              });
    for (const user of users) await recordWelcome(user.id);
    welcomeUsers = users.length;

    return {
        analysisFailures,
        syncFailures,
        welcomeUsers,
        next: {
            analysisCursor:
                analysisJobs.length === PAGE_SIZE
                    ? (analysisJobs.at(-1)?.id ?? null)
                    : null,
            syncCursor:
                syncJobs.length === PAGE_SIZE
                    ? (syncJobs.at(-1)?.id ?? null)
                    : null,
            userCursor:
                users.length === PAGE_SIZE ? (users.at(-1)?.id ?? null) : null,
        },
    };
}

export async function generateDueWeeklyProgressNotifications(
    now = new Date(),
    cursor?: string | null
) {
    if (cursor === null) return { eligible: 0, created: 0, nextCursor: null };
    let eligible = 0;
    let created = 0;
    const preferences = await prisma.notificationPreference.findMany({
        where: {
            emailWeeklyProgress: true,
            optionalEmailsUnsubscribedAt: null,
            emailSuppressedAt: null,
            user: { email: { not: null } },
        },
        select: { userId: true, timezone: true, digestHour: true },
        orderBy: { userId: 'asc' },
        take: PAGE_SIZE,
        ...(cursor ? { cursor: { userId: cursor }, skip: 1 } : {}),
    });
    eligible += preferences.length;

    const due = preferences.flatMap((preference) => {
        const period = weeklyPeriod(
            now,
            preference.timezone,
            preference.digestHour
        );
        return period ? [{ ...preference, ...period }] : [];
    });
    const userIds = due.map((preference) => preference.userId);
    if (userIds.length > 0) {
            const since = new Date(now.getTime() - WEEK_MS);
            const keys = due.map(
                (preference) =>
                    `weekly-progress:${preference.userId}:${preference.key}`
            );
            const [attemptGroups, successfulGroups, positionGroups, existing] =
                await Promise.all([
                    prisma.trainingAttempt.groupBy({
                        by: ['userId'],
                        where: {
                            userId: { in: userIds },
                            attemptedAt: { gte: since, lte: now },
                        },
                        _count: { id: true },
                    }),
                    prisma.trainingAttempt.groupBy({
                        by: ['userId'],
                        where: {
                            userId: { in: userIds },
                            attemptedAt: { gte: since, lte: now },
                            grade: {
                                in: [
                                    'BEST',
                                    'STRONG',
                                    'GOOD',
                                    'IMPROVED',
                                ],
                            },
                        },
                        _count: { id: true },
                    }),
                    prisma.trainingMoment.groupBy({
                        by: ['userId'],
                        where: {
                            userId: { in: userIds },
                            createdAt: { gte: since, lte: now },
                            status: 'ACTIVE',
                        },
                        _count: { id: true },
                    }),
                    prisma.notification.findMany({
                        where: { dedupeKey: { in: keys } },
                        select: {
                            dedupeKey: true,
                            deliveries: { select: { channel: true } },
                        },
                    }),
                ]);
            const attemptsByUser = new Map(
                attemptGroups.map((group) => [group.userId, group._count.id])
            );
            const successfulByUser = new Map(
                successfulGroups.map((group) => [group.userId, group._count.id])
            );
            const positionsByUser = new Map(
                positionGroups.map((group) => [group.userId, group._count.id])
            );
            const existingByKey = new Map(
                existing.map((notification) => [
                    notification.dedupeKey,
                    notification,
                ])
            );

            for (const preference of due) {
                const dedupeKey = `weekly-progress:${preference.userId}:${preference.key}`;
                const prior = existingByKey.get(dedupeKey);
                if (
                    prior?.deliveries.some(
                        (delivery) => delivery.channel === 'EMAIL'
                    )
                ) {
                    continue;
                }
                const attempts = attemptsByUser.get(preference.userId) ?? 0;
                const successful =
                    successfulByUser.get(preference.userId) ?? 0;
                const newPositions =
                    positionsByUser.get(preference.userId) ?? 0;
                if (attempts === 0 && newPositions === 0) continue;
                await recordNotification({
                    userId: preference.userId,
                    type: 'WEEKLY_PROGRESS',
                    title: 'Your weekly Backranq progress',
                    body: `You practiced ${attempts} position${attempts === 1 ? '' : 's'}, solved ${successful} well, and added ${newPositions} new position${newPositions === 1 ? '' : 's'}.`,
                    href: '/progress',
                    dedupeKey,
                    itemCount: prior ? 0 : attempts,
                    secondaryCount: prior ? 0 : newPositions,
                    metadata: {
                        successful,
                        since: since.toISOString(),
                        scheduledFor: preference.scheduledFor.toISOString(),
                    },
                    email: true,
                    push: false,
                });
                if (!prior) created += 1;
            }
    }

    return {
        eligible,
        created,
        nextCursor:
            preferences.length === PAGE_SIZE
                ? (preferences.at(-1)?.userId ?? null)
                : null,
    };
}

export async function generatePracticeDueNotifications(
    now = new Date(),
    cursor?: string | null
) {
    if (cursor === null) {
        return {
            dueUsers: 0,
            processed: 0,
            scannedUsers: 0,
            nextCursor: null,
        };
    }
    const sweep = await schedulePracticeDueSweep(now);
    return {
        dueUsers: 0,
        processed: 0,
        scannedUsers: 0,
        nextCursor: null,
        sweep,
    };
}

type MaintenanceArgs = ReconcileCursors & {
    referenceAt?: Date;
    since?: Date;
    weeklyCursor?: string | null;
    practiceDueCursor?: string | null;
};

export async function runNotificationMaintenance(args: MaintenanceArgs = {}) {
    const referenceAt = args.referenceAt ?? new Date();
    const since = args.since ?? new Date(referenceAt.getTime() - WEEK_MS);
    const [practiceDue, weekly, reconciled, practiceDueCleanup] =
        await Promise.all([
            generatePracticeDueNotifications(
                referenceAt,
                args.practiceDueCursor
            ),
            generateDueWeeklyProgressNotifications(
                referenceAt,
                args.weeklyCursor
            ),
            reconcileRecentNotificationEvents(referenceAt, args, since),
            cleanupCompletedPracticeDueSweeps(referenceAt),
        ]);
    const hasContinuation =
        practiceDueCleanup.hasMore ||
        practiceDue.nextCursor !== null ||
        weekly.nextCursor !== null ||
        reconciled.next.analysisCursor !== null ||
        reconciled.next.syncCursor !== null ||
        reconciled.next.userCursor !== null;
    let continuationQueued = false;
    if (hasContinuation) {
        const message = {
            type: 'notification-maintenance' as const,
            referenceAt: referenceAt.toISOString(),
            since: since.toISOString(),
            analysisCursor: reconciled.next.analysisCursor,
            syncCursor: reconciled.next.syncCursor,
            userCursor: reconciled.next.userCursor,
            weeklyCursor: weekly.nextCursor,
            practiceDueCursor: practiceDue.nextCursor,
            practiceDueCleanupCursor:
                practiceDueCleanup.lastDeletedId,
        };
        const continuation = await publishBackranqQueueMessage(message, {
            idempotencyKey: `notification-maintenance:${message.referenceAt}:${message.analysisCursor ?? 'done'}:${message.syncCursor ?? 'done'}:${message.userCursor ?? 'done'}:${message.weeklyCursor ?? 'done'}:${message.practiceDueCursor ?? 'done'}:${message.practiceDueCleanupCursor ?? 'done'}`,
        });
        if (!continuation.queued && process.env.NODE_ENV === 'production') {
            throw new Error('Notification maintenance queue is unavailable');
        }
        continuationQueued = continuation.queued;
    }
    return {
        practiceDue,
        weekly,
        reconciled,
        practiceDueCleanup,
        continuationQueued,
    };
}

function weeklyPeriod(now: Date, timezone: string, digestHour: number) {
    const nextSlot = nextDigestAt(now, timezone, digestHour, 'WEEKLY');
    if (
        nextSlot > now &&
        localDateKey(nextSlot, timezone) === localDateKey(now, timezone)
    ) {
        return null;
    }
    const scheduledFor = nextDigestAt(
        new Date(now.getTime() - WEEK_MS),
        timezone,
        digestHour,
        'WEEKLY'
    );
    if (now.getTime() - scheduledFor.getTime() > WEEKLY_CATCHUP_GRACE_MS) {
        return null;
    }
    return {
        scheduledFor,
        key: localDateKey(scheduledFor, timezone),
    };
}

function localDateKey(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const value = (type: string) =>
        parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}-${value('month')}-${value('day')}`;
}
