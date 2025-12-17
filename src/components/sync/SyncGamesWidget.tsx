'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SyncGamesModal } from '@/components/sync/SyncGamesModal';
import { AnalyzeGamesModal } from '@/components/analysis/AnalyzeGamesModal';
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
    const [openAnalyze, setOpenAnalyze] = useState(false);
    const router = useRouter();
    const [status, setStatus] = useState<{
        linked: { lichessUsername: string | null; chesscomUsername: string | null };
        lastSync: { lichess: string | null; chesscom: string | null };
    } | null>(null);
    const [pendingUnanalyzed, setPendingUnanalyzed] = useState<number | null>(null);

    useEffect(() => {
        getSyncStatus().then(setStatus).catch(() => {});
    }, []);

    useEffect(() => {
        if (context !== 'games') return;
        let cancelled = false;
        async function refresh() {
            try {
                const res = await fetch('/api/games?hasAnalysis=false&page=1&limit=1', {
                    cache: 'no-store',
                });
                const json = (await res.json().catch(() => ({}))) as { total?: number };
                if (!cancelled) {
                    setPendingUnanalyzed(typeof json.total === 'number' ? json.total : 0);
                }
            } catch {
                if (!cancelled) setPendingUnanalyzed(null);
            }
        }
        refresh();
        const t = setInterval(refresh, 30_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [context]);

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
                        <div>Sync games from your linked accounts into BackRank.</div>
                        {context === 'games' && typeof pendingUnanalyzed === 'number' && pendingUnanalyzed > 0 ? (
                            <div className="mt-1">
                                You have <span className="font-semibold">{pendingUnanalyzed}</span> games not analyzed yet.
                            </div>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {context === 'games' &&
                        typeof pendingUnanalyzed === 'number' &&
                        pendingUnanalyzed > 0 ? (
                            <Button type="button" variant="secondary" onClick={() => setOpenAnalyze(true)}>
                                Analyze games
                            </Button>
                        ) : null}
                        <Button type="button" onClick={() => setOpen(true)}>
                            Sync games
                        </Button>
                    </div>
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
                    // Refresh server components without killing background analysis.
                    router.refresh();
                }}
            />

            <AnalyzeGamesModal
                open={openAnalyze}
                onClose={() => setOpenAnalyze(false)}
                title="Analyze imported games"
            />
        </>
    );
}


