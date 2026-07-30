'use client';

import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useEffect, useState, useSyncExternalStore } from 'react';

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

export function CoachOnlineShell({ ownerId }: { ownerId: string }) {
    const { data: session, status: sessionStatus } = useSession();
    const [initialEnrollmentPending, setInitialEnrollmentPending] =
        useState(true);
    const accessGranted = useSyncExternalStore(
        subscribeToCoachOfflineAccess,
        () => hasCoachOfflineAccess(ownerId),
        (): boolean | null => null
    );
    const sessionOwnerId = session?.user?.id;
    const ownsSession =
        sessionStatus === 'authenticated' &&
        sessionOwnerId === ownerId;
    const waitingForInitialEnrollment =
        ownsSession &&
        accessGranted !== true &&
        initialEnrollmentPending;

    useEffect(() => {
        if (!ownsSession) return;
        const timeoutId = window.setTimeout(
            () => setInitialEnrollmentPending(false),
            0
        );
        return () => window.clearTimeout(timeoutId);
    }, [ownsSession]);

    return (
        <>
            {ownsSession ? (
                <CoachOfflineRegistration
                    authenticatedOwnerId={ownerId}
                />
            ) : null}

            {sessionStatus === 'loading' ||
            waitingForInitialEnrollment ? (
                <div
                    role="status"
                    className="text-sm text-muted-foreground"
                >
                    Securing coach access…
                </div>
            ) : !ownsSession || accessGranted !== true ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Coach locked after sign-out</CardTitle>
                        <CardDescription>
                            This tab stopped the local game because the
                            account session or this device&apos;s coach
                            access was revoked.
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <Button asChild>
                            <Link href="/login?callbackUrl=%2Fplay">
                                Sign in to Play
                            </Link>
                        </Button>
                    </CardContent>
                </Card>
            ) : (
                <CoachGame ownerId={ownerId} />
            )}
        </>
    );
}
