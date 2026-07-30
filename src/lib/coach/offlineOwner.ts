export const COACH_OFFLINE_OWNER_STORAGE_KEY =
    'backranq.coach.offlineOwner.v1';

const LOCAL_OWNER_ID = 'local';
const MAX_OWNER_ID_LENGTH = 256;

function validOwnerId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_OWNER_ID_LENGTH
    );
}

/**
 * The static offline shell cannot ask Auth.js who is signed in. Remembering
 * the last authenticated local namespace lets that shell recover the same
 * device-only checkpoint. Explicit sign-out removes both this alias and the
 * stored coach sessions.
 */
export function resolveCoachOwnerId(
    authenticatedOwnerId: string | null | undefined
): string {
    if (typeof window === 'undefined') {
        return validOwnerId(authenticatedOwnerId)
            ? authenticatedOwnerId
            : LOCAL_OWNER_ID;
    }
    if (validOwnerId(authenticatedOwnerId)) {
        try {
            window.localStorage.setItem(
                COACH_OFFLINE_OWNER_STORAGE_KEY,
                authenticatedOwnerId
            );
        } catch {
            // The signed-in page can still use its explicit owner ID.
        }
        return authenticatedOwnerId;
    }

    try {
        const remembered = window.localStorage.getItem(
            COACH_OFFLINE_OWNER_STORAGE_KEY
        );
        return validOwnerId(remembered)
            ? remembered
            : LOCAL_OWNER_ID;
    } catch {
        return LOCAL_OWNER_ID;
    }
}

export function getRememberedCoachOwnerId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const remembered = window.localStorage.getItem(
            COACH_OFFLINE_OWNER_STORAGE_KEY
        );
        return validOwnerId(remembered) ? remembered : null;
    } catch {
        return null;
    }
}

export function clearCoachOfflineOwner(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.removeItem(
            COACH_OFFLINE_OWNER_STORAGE_KEY
        );
    } catch {
        // Sign-out cleanup remains best-effort when storage is unavailable.
    }
}
