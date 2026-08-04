import { prisma } from '@/lib/prisma';
import {
    recordAnalysisFailed,
    recordNotification,
    recordSyncFailed,
    recordWelcome,
} from './service';

export async function reconcileRecentNotificationEvents(now = new Date()) {
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const [analysisJobs, syncJobs, users] = await Promise.all([
        prisma.analysisJob.findMany({
            where: { status: 'FAILED', completedAt: { gte: since } },
            orderBy: { completedAt: 'desc' },
            take: 200,
            select: { id: true, userId: true, gameId: true, lastError: true },
        }),
        prisma.syncJob.findMany({
            where: { status: 'FAILED', completedAt: { gte: since } },
            orderBy: { completedAt: 'desc' },
            take: 200,
            select: { id: true, userId: true, provider: true, lastError: true },
        }),
        prisma.user.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: { id: true },
        }),
    ]);
    const expectedKeys = [
        ...analysisJobs.map((job) => `analysis-failed:${job.id}`),
        ...syncJobs.map((job) => `sync-failed:${job.id}`),
        ...users.map((user) => `welcome:${user.id}`),
    ];
    const existing = new Set(
        (
            await prisma.notification.findMany({
                where: { dedupeKey: { in: expectedKeys } },
                select: { dedupeKey: true },
            })
        ).map((notification) => notification.dedupeKey)
    );
    for (const job of analysisJobs) {
        if (existing.has(`analysis-failed:${job.id}`)) continue;
        await recordAnalysisFailed({
            userId: job.userId,
            jobId: job.id,
            gameId: job.gameId,
            error: job.lastError ?? 'Analysis failed',
        });
    }
    for (const job of syncJobs) {
        if (existing.has(`sync-failed:${job.id}`)) continue;
        await recordSyncFailed({
            userId: job.userId,
            jobId: job.id,
            provider: job.provider,
            error: job.lastError ?? 'Sync failed',
        });
    }
    for (const user of users) {
        if (!existing.has(`welcome:${user.id}`)) await recordWelcome(user.id);
    }
    return {
        analysisFailures: analysisJobs.length,
        syncFailures: syncJobs.length,
        welcomeUsers: users.length,
    };
}

export async function generateDueWeeklyProgressNotifications(now = new Date()) {
    const preferences = await prisma.notificationPreference.findMany({
        where: {
            emailWeeklyProgress: true,
            optionalEmailsUnsubscribedAt: null,
            emailSuppressedAt: null,
            user: { email: { not: null } },
        },
        select: { userId: true, timezone: true, digestHour: true },
        take: 1_000,
    });
    let created = 0;
    const due = preferences.filter((preference) => {
        const local = localScheduleParts(now, preference.timezone);
        return local.weekday === 'Mon' && local.hour === preference.digestHour;
    });
    if (due.length === 0) return { eligible: preferences.length, created };
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    const userIds = due.map((preference) => preference.userId);
    const [attemptGroups, successfulGroups, positionGroups] = await Promise.all([
        prisma.trainingAttempt.groupBy({
            by: ['userId'],
            where: { userId: { in: userIds }, attemptedAt: { gte: since } },
            _count: { id: true },
        }),
        prisma.trainingAttempt.groupBy({
            by: ['userId'],
            where: {
                userId: { in: userIds },
                attemptedAt: { gte: since },
                grade: { in: ['BEST', 'GOOD', 'IMPROVED'] },
            },
            _count: { id: true },
        }),
        prisma.trainingMoment.groupBy({
            by: ['userId'],
            where: {
                userId: { in: userIds },
                createdAt: { gte: since },
                status: 'ACTIVE',
            },
            _count: { id: true },
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
    for (const preference of due) {
        const local = localScheduleParts(now, preference.timezone);
        const attempts = attemptsByUser.get(preference.userId) ?? 0;
        const successful = successfulByUser.get(preference.userId) ?? 0;
        const newPositions = positionsByUser.get(preference.userId) ?? 0;
        if (attempts === 0 && newPositions === 0) continue;
        const notification = await recordNotification({
            userId: preference.userId,
            type: 'WEEKLY_PROGRESS',
            title: 'Your weekly Backranq progress',
            body: `You practiced ${attempts} position${attempts === 1 ? '' : 's'}, solved ${successful} well, and added ${newPositions} new position${newPositions === 1 ? '' : 's'}.`,
            href: '/progress',
            dedupeKey: `weekly-progress:${preference.userId}:${local.date}`,
            itemCount: attempts,
            secondaryCount: newPositions,
            metadata: { successful, since: since.toISOString() },
            email: true,
            push: false,
        });
        if (notification) created += 1;
    }
    return { eligible: preferences.length, created };
}

function localScheduleParts(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        weekday: 'short',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return {
        weekday: value('weekday'),
        hour: Number(value('hour')),
        date: `${value('year')}-${value('month')}-${value('day')}`,
    };
}
