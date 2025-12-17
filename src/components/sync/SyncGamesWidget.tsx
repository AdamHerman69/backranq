'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { SyncGamesModal } from '@/components/sync/SyncGamesModal';
import { getSyncStatus } from '@/lib/services/gameSync';
import { Button } from '@/components/ui/button';

export function SyncGamesWidget({
    context,
    enableAnalyze = true,
    variant = 'button',
}: {
    context: 'home' | 'games';
    enableAnalyze?: boolean;
    variant?: 'button' | 'banner';
}) {
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<{
        linked: { lichessUsername: string | null; chesscomUsername: string | null };
        lastSync: { lichess: string | null; chesscom: string | null };
    } | null>(null);

    useEffect(() => {
        getSyncStatus().then(setStatus).catch(() => {});
    }, []);

    const hasLinked = useMemo(() => {
        return !!status?.linked.lichessUsername || !!status?.linked.chesscomUsername;
    }, [status]);

    if (!hasLinked) {
        return (
            <div className="text-sm text-muted-foreground">
                Link your Lichess/Chess.com usernames in{' '}
                <Link className="underline" href="/settings">
                    Settings
                </Link>{' '}
                to sync games.
            </div>
        );
    }

    return (
        <>
            {variant === 'banner' ? (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-sm text-muted-foreground">
                        Sync games from your linked accounts into BackRank.
                    </div>
                    <Button type="button" onClick={() => setOpen(true)}>
                        Sync games
                    </Button>
                </div>
            ) : (
                <Button type="button" variant="outline" onClick={() => setOpen(true)}>
                    Sync games
                </Button>
            )}

            <SyncGamesModal
                open={open}
                onClose={() => setOpen(false)}
                context={context}
                enableAnalyze={enableAnalyze}
                onFinished={() => {
                    // best-effort refresh without assuming router here
                    window.location.reload();
                }}
            />
        </>
    );
}


