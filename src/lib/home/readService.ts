import type { HomeDashboardSnapshot } from '@/lib/home/contracts';
import { readSyncStatusSnapshot } from '@/lib/services/syncStatusRead';
import { getPracticeInventorySummary } from '@/lib/training/practiceDue';

export async function readHomeDashboardSnapshot(
    userId: string,
    options: { now?: Date } = {}
): Promise<HomeDashboardSnapshot> {
    const now = options.now ?? new Date();
    const [practiceResult, syncStatusResult] = await Promise.allSettled([
        getPracticeInventorySummary(userId, now),
        readSyncStatusSnapshot(userId, { now }),
    ]);
    const practice =
        practiceResult.status === 'fulfilled'
            ? practiceResult.value
            : null;
    const syncStatus =
        syncStatusResult.status === 'fulfilled'
            ? syncStatusResult.value
            : null;
    const inventory = syncStatus?.inventory ?? null;
    const coreReady = practice !== null && inventory !== null;

    return Object.freeze({
        ownerId: userId,
        generatedAt: now.toISOString(),
        status: coreReady ? 'ready' : 'error',
        trainingMomentCount: practice?.availableCount ?? 0,
        trainingMomentCountIsExact:
            practice?.availableCountIsExact ?? true,
        duePracticeCount: practice?.dueCount ?? 0,
        duePracticeCountIsExact: practice?.dueCountIsExact ?? true,
        earliestDueAt: practice?.earliestDueAt?.toISOString() ?? null,
        gameCount: inventory?.totalImported ?? 0,
        unanalyzedGameCount: inventory?.unanalyzed ?? 0,
        syncStatus,
        error: coreReady
            ? null
            : 'Could not load your practice overview.',
    });
}
