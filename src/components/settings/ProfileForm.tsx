'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { ChessAccountLink } from './ChessAccountLink';
import {
    publishChessConnectionsChanged,
    requestIncrementalSync,
    waitForIncrementalSyncJobs,
} from '@/components/sync/syncClient';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { publishLibraryChanged } from '@/lib/analysis/analysisCompletion';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
    type OwnerEpoch,
    type OwnerRunToken,
} from '@/lib/auth/ownerRun';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import type {
    SyncProvider,
    UserSyncActivity,
} from '@/lib/services/gameSync';

export type UserProfile = {
    id: string;
    email: string | null;
    name: string | null;
    image: string | null;
    lichessUsername: string | null;
    chesscomUsername: string | null;
};

type Props = {
    initialUser: UserProfile;
};

export function ProfileForm({ initialUser }: Props) {
    const { data: session, status: sessionStatus } = useSession();
    const activeOwnerId =
        sessionStatus === 'authenticated'
            ? session?.user?.id ?? null
            : null;
    const ownerEpochRef = useRef<OwnerEpoch>({
        ownerId: null,
        generation: 0,
    });
    ownerEpochRef.current = advanceOwnerEpoch(
        ownerEpochRef.current,
        activeOwnerId
    );
    const ownerReady =
        sessionStatus === 'authenticated' &&
        activeOwnerId === initialUser.id;
    const [user, setUser] = useState<UserProfile>(initialUser);
    const [ownerFenceError, setOwnerFenceError] = useState<string | null>(
        null
    );
    const ownerFenceErrorRef = useRef<string | null>(null);
    const writesEnabled = ownerReady && ownerFenceError === null;
    const mutationControllerRef = useRef<AbortController | null>(null);
    const syncControllersRef = useRef<
        Record<SyncProvider, AbortController | null>
    >({
        lichess: null,
        chesscom: null,
    });

    useEffect(() => {
        const controllers = syncControllersRef.current;
        return () => {
            mutationControllerRef.current?.abort();
            controllers.lichess?.abort();
            controllers.chesscom?.abort();
        };
    }, []);

    useEffect(() => {
        ownerFenceErrorRef.current = null;
        setOwnerFenceError(null);
    }, [initialUser.id]);

    useEffect(() => {
        if (ownerReady) return;
        mutationControllerRef.current?.abort();
        syncControllersRef.current.lichess?.abort();
        syncControllersRef.current.chesscom?.abort();
        setUser(initialUser);
    }, [initialUser, ownerReady]);

    const update = useCallback(
        async (patch: Partial<Pick<UserProfile, 'lichessUsername' | 'chesscomUsername'>>) => {
            const run = captureOwnerRun(ownerEpochRef.current);
            if (
                !run ||
                run.ownerId !== initialUser.id ||
                ownerFenceErrorRef.current !== null ||
                !isOwnerRunCurrent(run, ownerEpochRef.current)
            ) {
                throw new Error(
                    'Your signed-in account changed. Reload Settings before making changes.'
                );
            }
            mutationControllerRef.current?.abort();
            const controller = new AbortController();
            mutationControllerRef.current = controller;
            try {
                const res = await fetch('/api/user/profile', {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        [EXPECTED_OWNER_HEADER]: run.ownerId,
                    },
                    body: JSON.stringify(patch),
                    signal: controller.signal,
                });
                const json = (await res.json().catch(() => ({}))) as
                    | { user: UserProfile }
                    | { error?: string };
                if (!res.ok) {
                    const msg =
                        'error' in json && typeof json.error === 'string'
                            ? json.error
                            : 'Update failed';
                    throw new Error(msg);
                }
                if (!('user' in json)) {
                    throw new Error('Profile update returned no user');
                }
                if (
                    json.user.id !== run.ownerId ||
                    !isOwnerRunCurrent(run, ownerEpochRef.current)
                ) {
                    const message =
                        'Your signed-in account changed before the update finished. Reload Settings and verify the linked account.';
                    ownerFenceErrorRef.current = message;
                    setOwnerFenceError(message);
                    setUser(initialUser);
                    throw new Error(message);
                }
                setUser(json.user);
                return json.user;
            } finally {
                if (mutationControllerRef.current === controller) {
                    mutationControllerRef.current = null;
                }
            }
        },
        [initialUser]
    );

    function profileRunIsCurrent(run: OwnerRunToken) {
        return (
            run.ownerId === initialUser.id &&
            isOwnerRunCurrent(run, ownerEpochRef.current)
        );
    }

    async function updateLichess(next: string) {
        if (!writesEnabled) return;
        const replacing = !!user.lichessUsername && !!next;
        const id = toast.loading(
            next
                ? `${replacing ? 'Replacing' : 'Linking'} Lichess account…`
                : 'Disconnecting Lichess…'
        );
        try {
            const updated = await update({
                lichessUsername: next || null,
            });
            const run = captureOwnerRun(ownerEpochRef.current);
            if (!run || !profileRunIsCurrent(run)) return;
            publishChessConnectionsChanged({
                ownerId: updated.id,
                provider: 'lichess',
                username: updated.lichessUsername,
            });
            toast.success(
                next
                    ? 'Lichess account linked'
                    : 'Lichess disconnected; imported games were kept.',
                { id }
            );
            if (next) {
                void startFirstSync(
                    'lichess',
                    updated.lichessUsername ?? next,
                    run
                );
            }
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') {
                toast.dismiss(id);
                throw e;
            }
            toast.error(e instanceof Error ? e.message : 'Save failed', { id });
            throw e;
        }
    }

    async function updateChesscom(next: string) {
        if (!writesEnabled) return;
        const replacing = !!user.chesscomUsername && !!next;
        const id = toast.loading(
            next
                ? `${replacing ? 'Replacing' : 'Linking'} Chess.com account…`
                : 'Disconnecting Chess.com…'
        );
        try {
            const updated = await update({
                chesscomUsername: next || null,
            });
            const run = captureOwnerRun(ownerEpochRef.current);
            if (!run || !profileRunIsCurrent(run)) return;
            publishChessConnectionsChanged({
                ownerId: updated.id,
                provider: 'chesscom',
                username: updated.chesscomUsername,
            });
            toast.success(
                next
                    ? 'Chess.com account linked'
                    : 'Chess.com disconnected; imported games were kept.',
                { id }
            );
            if (next) {
                void startFirstSync(
                    'chesscom',
                    updated.chesscomUsername ?? next,
                    run
                );
            }
        } catch (e) {
            if (e instanceof Error && e.name === 'AbortError') {
                toast.dismiss(id);
                throw e;
            }
            toast.error(e instanceof Error ? e.message : 'Save failed', { id });
            throw e;
        }
    }

    async function startFirstSync(
        provider: SyncProvider,
        expectedUsername: string,
        run: OwnerRunToken
    ) {
        if (!profileRunIsCurrent(run)) return;
        syncControllersRef.current[provider]?.abort();
        const controller = new AbortController();
        syncControllersRef.current[provider] = controller;
        const expectedIdentity = normalizeProviderUsername(expectedUsername);
        try {
            let result = await requestIncrementalSync({
                providers: [provider],
            });
            if (!profileRunIsCurrent(run)) return;
            if (
                result.state === 'partial' ||
                result.state === 'failed' ||
                result.state === 'awaiting-worker'
            ) {
                toast.warning(result.message);
            } else {
                toast.success(result.message);
            }

            let activity: UserSyncActivity | null = result.activity;
            const firstJobIds = result.providers.flatMap((item) =>
                item.jobId ? [item.jobId] : []
            );
            if (firstJobIds.length > 0) {
                const completion = await waitForIncrementalSyncJobs({
                    jobIds: firstJobIds,
                    initialActivity: activity,
                    signal: controller.signal,
                    maxAttempts: 18,
                });
                if (!profileRunIsCurrent(run)) return;
                activity = completion.activity;
                if (completion.timedOut) {
                    const awaitingWorker = result.providers.some(
                        (item) => item.state === 'awaiting-worker'
                    );
                    if (awaitingWorker) {
                        toast.warning(
                            'The account is linked, but the background worker could not be notified. Use Sync now to retry.'
                        );
                    } else {
                        toast.message(
                            'The account is linked and sync is still running in the background.'
                        );
                    }
                    return;
                }
                if (completion.createdCount > 0) {
                    publishLibraryChanged(run.ownerId, {
                        invalidateCompletion: true,
                    });
                }
                if (completion.failed > 0 || completion.cancelled > 0) {
                    toast.warning(
                        `${providerLabel(provider)} sync ended without completing. Use Sync now to retry.`
                    );
                } else {
                    toast.success(
                        completion.createdCount > 0
                            ? `${providerLabel(provider)} sync complete — ${completion.createdCount} new game${completion.createdCount === 1 ? '' : 's'} imported.`
                            : `${providerLabel(provider)} sync complete — your library is up to date.`
                    );
                }
            }
            if (controller.signal.aborted || !profileRunIsCurrent(run)) return;

            // A profile can be replaced while a job for the old identity is
            // still active. Once that job is terminal, explicitly start one
            // bounded follow-up if the provider cursor still belongs to the
            // previous identity.
            const providerActivity = activity?.providers.find(
                (item) =>
                    item.provider ===
                    (provider === 'lichess' ? 'LICHESS' : 'CHESSCOM')
            );
            const currentIdentity = normalizeProviderUsername(
                providerActivity?.username ?? ''
            );
            const syncedIdentity = normalizeProviderUsername(
                providerActivity?.state?.providerUsernameNormalized ?? ''
            );
            if (
                currentIdentity === expectedIdentity &&
                syncedIdentity !== expectedIdentity
            ) {
                result = await requestIncrementalSync({
                    providers: [provider],
                });
                if (!profileRunIsCurrent(run)) return;
                const followUpJobIds = result.providers.flatMap((item) =>
                    item.jobId ? [item.jobId] : []
                );
                if (followUpJobIds.length > 0) {
                    toast.message(
                        `Starting ${providerLabel(provider)} sync for the new username…`
                    );
                    const followUp = await waitForIncrementalSyncJobs({
                        jobIds: followUpJobIds,
                        initialActivity: result.activity,
                        signal: controller.signal,
                        maxAttempts: 18,
                    });
                    if (!profileRunIsCurrent(run)) return;
                    if (followUp.timedOut) {
                        const awaitingWorker = result.providers.some(
                            (item) => item.state === 'awaiting-worker'
                        );
                        if (awaitingWorker) {
                            toast.warning(
                                `${providerLabel(provider)} sync is queued, but the background worker could not be notified. Use Sync now to retry.`
                            );
                        } else {
                            toast.message(
                                `${providerLabel(provider)} sync for the new username is still running in the background.`
                            );
                        }
                        return;
                    }
                    if (followUp.createdCount > 0) {
                        publishLibraryChanged(run.ownerId, {
                            invalidateCompletion: true,
                        });
                    }
                    if (followUp.failed > 0 || followUp.cancelled > 0) {
                        toast.warning(
                            `${providerLabel(provider)} sync for the new username did not complete. Use Sync now to retry.`
                        );
                    } else {
                        toast.success(
                            followUp.createdCount > 0
                                ? `${providerLabel(provider)} sync complete — ${followUp.createdCount} new game${followUp.createdCount === 1 ? '' : 's'} imported.`
                                : `${providerLabel(provider)} sync complete — your library is up to date.`
                        );
                    }
                } else if (
                    result.state === 'failed' ||
                    result.state === 'partial' ||
                    result.state === 'awaiting-worker'
                ) {
                    toast.warning(
                        `${result.message} Use Sync now to retry the new username.`
                    );
                }
            }
        } catch (error) {
            if (
                controller.signal.aborted ||
                !profileRunIsCurrent(run) ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return;
            }
            toast.warning(
                `${
                    error instanceof Error
                        ? error.message
                        : 'The first sync could not be started.'
                } You can use Sync now from Home or Games.`
            );
        } finally {
            if (syncControllersRef.current[provider] === controller) {
                syncControllersRef.current[provider] = null;
            }
        }
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Profile</CardTitle>
                    <CardDescription>
                        {user.email ?? '—'}
                        {user.name ? ` • ${user.name}` : ''}
                    </CardDescription>
                </CardHeader>
            </Card>

            {ownerFenceError ||
            (!ownerReady && sessionStatus !== 'loading') ? (
                <div
                    role="alert"
                    className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
                >
                    {ownerFenceError ??
                        'Your signed-in account changed. Reload Settings before editing linked chess accounts.'}
                </div>
            ) : null}

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Linked accounts</CardTitle>
                    <CardDescription>
                        Link public chess profiles once. New games can then stay
                        up to date automatically without using analysis
                        credits.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <ChessAccountLink
                        provider="lichess"
                        currentUsername={user.lichessUsername}
                        onUpdate={updateLichess}
                        disabled={!writesEnabled}
                    />
                    <ChessAccountLink
                        provider="chesscom"
                        currentUsername={user.chesscomUsername}
                        onUpdate={updateChesscom}
                        disabled={!writesEnabled}
                    />
                </CardContent>
            </Card>
        </div>
    );
}

function normalizeProviderUsername(username: string) {
    return username.trim().toLocaleLowerCase('en-US');
}

function providerLabel(provider: SyncProvider) {
    return provider === 'lichess' ? 'Lichess' : 'Chess.com';
}
