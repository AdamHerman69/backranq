'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';

import { CoachGame } from '@/components/coach/CoachGame';
import { CoachOfflineRegistration } from '@/components/coach/CoachOfflineRegistration';
import {
    EmptyState,
    LoadingState,
} from '@/components/ui/async-state';
import { Button } from '@/components/ui/button';
import {
    hasCoachOfflineAccess,
    subscribeToCoachOfflineAccess,
} from '@/lib/coach/offlineAccess';
import { getRememberedCoachOwnerId } from '@/lib/coach/offlineOwner';

export function CoachOfflineShell() {
    const accessGranted = useSyncExternalStore(
        subscribeToCoachOfflineAccess,
        (): boolean | null =>
            hasCoachOfflineAccess(
                getRememberedCoachOwnerId()
            ),
        (): boolean | null => null
    );

    if (accessGranted === null) {
        return (
            <LoadingState
                title="Opening your offline coach"
                description="Checking this device for the saved coach, engine and active game."
            />
        );
    }

    if (!accessGranted) {
        return (
            <EmptyState
                title="Open Coach online first"
                description="Sign in and open Play once while online to prepare this device for offline coach games."
                action={
                    <Button asChild>
                        <Link href="/play">Open Play online</Link>
                    </Button>
                }
            />
        );
    }

    return (
        <>
            <CoachOfflineRegistration />
            <CoachGame />
        </>
    );
}
