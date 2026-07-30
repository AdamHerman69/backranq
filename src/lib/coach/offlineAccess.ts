import { COACH_OFFLINE_OWNER_STORAGE_KEY } from '@/lib/coach/offlineOwner';

export const COACH_OFFLINE_ACCESS_STORAGE_KEY =
    'backranq.coach.offlineAccess.v1';
export const COACH_OFFLINE_ACCESS_CHANGE_EVENT =
    'backranq:coach-offline-access-change';

type CoachOfflineAccessRecord = {
    version: 1;
    ownerId: string;
    grantedAt: number;
};

function validOwnerId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256
    );
}

export function grantCoachOfflineAccess(ownerId: string): void {
    if (typeof window === 'undefined' || !validOwnerId(ownerId)) return;
    try {
        window.localStorage.setItem(
            COACH_OFFLINE_ACCESS_STORAGE_KEY,
            JSON.stringify({
                version: 1,
                ownerId,
                grantedAt: Date.now(),
            } satisfies CoachOfflineAccessRecord)
        );
        window.dispatchEvent(
            new Event(COACH_OFFLINE_ACCESS_CHANGE_EVENT)
        );
    } catch {
        // Offline enrollment is best-effort on storage-restricted devices.
    }
}

export function hasCoachOfflineAccess(ownerId: string | null): boolean {
    if (typeof window === 'undefined' || !validOwnerId(ownerId)) {
        return false;
    }
    try {
        const parsed = JSON.parse(
            window.localStorage.getItem(
                COACH_OFFLINE_ACCESS_STORAGE_KEY
            ) ?? 'null'
        ) as Partial<CoachOfflineAccessRecord> | null;
        return (
            parsed?.version === 1 &&
            parsed.ownerId === ownerId &&
            typeof parsed.grantedAt === 'number' &&
            Number.isFinite(parsed.grantedAt)
        );
    } catch {
        return false;
    }
}

export function clearCoachOfflineAccess(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(
            COACH_OFFLINE_ACCESS_STORAGE_KEY
        );
        window.dispatchEvent(
            new Event(COACH_OFFLINE_ACCESS_CHANGE_EVENT)
        );
    } catch {
        // Explicit sign-out continues even without local storage.
    }
}

export function subscribeToCoachOfflineAccess(
    onStoreChange: () => void
): () => void {
    if (
        typeof window === 'undefined' ||
        typeof window.addEventListener !== 'function'
    ) {
        return () => undefined;
    }
    const onStorage = (event: StorageEvent) => {
        if (
            event.key === COACH_OFFLINE_ACCESS_STORAGE_KEY ||
            event.key === COACH_OFFLINE_OWNER_STORAGE_KEY
        ) {
            onStoreChange();
        }
    };
    window.addEventListener(
        COACH_OFFLINE_ACCESS_CHANGE_EVENT,
        onStoreChange
    );
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(
            COACH_OFFLINE_ACCESS_CHANGE_EVENT,
            onStoreChange
        );
        window.removeEventListener('storage', onStorage);
    };
}
