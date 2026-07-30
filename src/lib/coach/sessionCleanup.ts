import {
    clearCoachOfflineOwner,
    getRememberedCoachOwnerId,
} from '@/lib/coach/offlineOwner';
import { clearCoachOfflineAccess } from '@/lib/coach/offlineAccess';

/**
 * Small, dependency-free sign-out cleanup so the global navigation does not
 * pull chess.js and the full checkpoint sanitizer into every app page.
 */
export async function clearCoachSessionOnSignOut(
    authenticatedOwnerId?: string | null
): Promise<void> {
    const ownerId =
        authenticatedOwnerId ?? getRememberedCoachOwnerId();
    clearCoachOfflineAccess();
    clearCoachOfflineOwner();
    if (!ownerId) return;
    const { clearCoachSessionForSignOut } = await import(
        '@/lib/coach/sessionStore'
    );
    await clearCoachSessionForSignOut(ownerId);
}
