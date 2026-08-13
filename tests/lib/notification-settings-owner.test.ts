import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    disableWebPushForOwner,
    isNotificationSettingsRunCurrent,
    resolveNotificationSettingsOwnerId,
} from '@/components/settings/NotificationSettingsCard';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    type OwnerEpoch,
} from '@/lib/auth/ownerRun';

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('notification settings owner fencing', () => {
    it('uses the server owner only while the live session is loading', () => {
        expect(
            resolveNotificationSettingsOwnerId({
                sessionStatus: 'loading',
                liveOwnerId: null,
                initialOwnerId: 'user-a',
            })
        ).toBe('user-a');
        expect(
            resolveNotificationSettingsOwnerId({
                sessionStatus: 'authenticated',
                liveOwnerId: 'user-b',
                initialOwnerId: 'user-a',
            })
        ).toBe('user-b');
    });

    it('drops a deferred A response after switching to B and never commits the stale write', async () => {
        let epoch: OwnerEpoch = advanceOwnerEpoch(
            { ownerId: null, generation: 0 },
            'user-a'
        );
        const run = captureOwnerRun(epoch)!;
        let currentGeneration = 1;
        let release!: (value: { ownerId: string; enabled: boolean }) => void;
        const deferred = new Promise<{ ownerId: string; enabled: boolean }>(
            (resolve) => {
                release = resolve;
            }
        );
        let committed: { ownerId: string; enabled: boolean } | null = null;

        const write = deferred.then((payload) => {
            if (
                !isNotificationSettingsRunCurrent({
                    run,
                    epoch,
                    generation: 1,
                    currentGeneration,
                }) || payload.ownerId !== run.ownerId
            ) {
                return;
            }
            committed = payload;
        });

        epoch = advanceOwnerEpoch(epoch, 'user-b');
        currentGeneration += 1;
        release({ ownerId: 'user-a', enabled: true });
        await write;

        expect(committed).toBeNull();
    });

    it('disables push on the server without waiting for a local service-worker registration', async () => {
        const getRegistration = vi.fn().mockResolvedValue(undefined);
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    ownerId: 'user-a',
                    preferences: { pushEnabled: false },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            disableWebPushForOwner({
                ownerId: 'user-a',
                signal: new AbortController().signal,
                isCurrent: () => true,
                serviceWorker: { getRegistration } as Pick<
                    ServiceWorkerContainer,
                    'getRegistration'
                >,
            })
        ).resolves.toMatchObject({ pushEnabled: false });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/notifications/preferences',
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify({ pushEnabled: false }),
            })
        );
        expect(getRegistration).toHaveBeenCalledWith('/');
    });
});
