import type { SyncStatusSnapshot } from '@/lib/services/syncStatusRead';

export type HomeViewer = Readonly<{
    id: string;
    name: string | null;
}>;

export type HomeSyncStatus = SyncStatusSnapshot;

/** JSON-safe server snapshot passed across the RSC boundary. */
export type HomeDashboardSnapshot = Readonly<{
    ownerId: string;
    generatedAt: string;
    status: 'ready' | 'error';
    trainingMomentCount: number;
    trainingMomentCountIsExact: boolean;
    duePracticeCount: number;
    duePracticeCountIsExact: boolean;
    earliestDueAt: string | null;
    gameCount: number;
    unanalyzedGameCount: number;
    syncStatus: HomeSyncStatus | null;
    error: string | null;
}>;
