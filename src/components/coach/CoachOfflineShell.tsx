'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';

import { CoachGame } from '@/components/coach/CoachGame';
import { CoachOfflineRegistration } from '@/components/coach/CoachOfflineRegistration';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
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
            <div role="status" className="text-sm text-muted-foreground">
                Checking offline coach access…
            </div>
        );
    }

    if (!accessGranted) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Open Coach online first</CardTitle>
                    <CardDescription>
                        Sign in and open Play once while online to prepare
                        this device for offline coach games.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button asChild>
                        <Link href="/play">Open Play online</Link>
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <>
            <CoachOfflineRegistration />
            <CoachGame />
        </>
    );
}
