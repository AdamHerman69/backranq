'use client';

import { clearCoachSessionOnSignOut } from '@/lib/coach/sessionCleanup';

type CoachSignOutDependencies = {
    revokeSession: (
        redirectTo: string
    ) => Promise<{ url?: unknown }>;
    clearLocalSession: (ownerId?: string | null) => Promise<void>;
    navigate: (url: string) => void;
};

export async function revokeAuthSession(
    redirectTo: string
): Promise<{ url: string }> {
    const requestOptions: RequestInit = {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
    };
    const csrfResponse = await fetch('/api/auth/csrf', requestOptions);
    if (!csrfResponse.ok) {
        throw new Error('Could not prepare a secure sign-out request.');
    }
    const csrfPayload = (await csrfResponse.json()) as {
        csrfToken?: unknown;
    };
    if (
        typeof csrfPayload.csrfToken !== 'string' ||
        csrfPayload.csrfToken.length === 0
    ) {
        throw new Error('The sign-out response did not include a CSRF token.');
    }

    const response = await fetch('/api/auth/signout', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Auth-Return-Redirect': '1',
        },
        body: new URLSearchParams({
            csrfToken: csrfPayload.csrfToken,
            callbackUrl: redirectTo,
        }),
    });
    if (!response.ok) {
        throw new Error(
            `Sign-out failed with HTTP ${response.status}.`
        );
    }
    // A successful status already confirms server-side revocation. Do not
    // await optional redirect metadata: a truncated response body must not
    // delay or block privacy cleanup.
    try {
        const channel = new BroadcastChannel('next-auth');
        channel.postMessage({
            event: 'session',
            data: { trigger: 'signout' },
        });
        channel.close();
    } catch {
        // The server session is already revoked; other tabs also recheck
        // Auth.js on focus, and the coach storage event locks them now.
    }
    return { url: redirectTo };
}

const defaultDependencies: CoachSignOutDependencies = {
    revokeSession: revokeAuthSession,
    clearLocalSession: clearCoachSessionOnSignOut,
    navigate: (url) => window.location.assign(url),
};

/**
 * Revoke the server session before removing the durable local checkpoint.
 * While Auth.js still accepts the cookie, another tab could otherwise mount
 * `/play` and legitimately clear the sign-out tombstone again.
 */
export async function signOutAndClearCoachSession(
    ownerId?: string | null,
    redirectTo = '/',
    dependencies: CoachSignOutDependencies = defaultDependencies
): Promise<void> {
    const response = await dependencies.revokeSession(redirectTo);
    await dependencies.clearLocalSession(ownerId);
    dependencies.navigate(
        typeof response.url === 'string' && response.url.length > 0
            ? response.url
            : redirectTo
    );
}
