'use client';

import { useEffect } from 'react';

import { grantCoachOfflineAccess } from '@/lib/coach/offlineAccess';

export const COACH_OFFLINE_READY_EVENT =
    'backranq:coach-offline-ready';

/**
 * Register the production worker only after someone opens the coach. This
 * keeps the roughly 9 MB offline payload out of unrelated landing/login
 * visits while preserving a true cold offline start after the first visit.
 */
export function CoachOfflineRegistration({
    authenticatedOwnerId,
}: {
    authenticatedOwnerId?: string;
}) {
    useEffect(() => {
        if (authenticatedOwnerId) {
            grantCoachOfflineAccess(authenticatedOwnerId);
        }
        if (
            process.env.NODE_ENV !== 'production' ||
            !('serviceWorker' in navigator)
        ) {
            return;
        }
        let cancelled = false;
        void navigator.serviceWorker
            .register('/serwist/sw.js', {
                scope: '/',
                type: 'module',
            })
            .then(() => navigator.serviceWorker.ready)
            .then(() => {
                if (!cancelled) {
                    window.dispatchEvent(
                        new Event(COACH_OFFLINE_READY_EVENT)
                    );
                }
            })
            .catch(() => {
                // The game still works online or in an already open session.
            });
        return () => {
            cancelled = true;
        };
    }, [authenticatedOwnerId]);

    return null;
}
