'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { SyncGamesModal } from '@/components/sync/SyncGamesModal';
import { AnalyzeGamesModal } from '@/components/analysis/AnalyzeGamesModal';
import { getSyncStatus, type SyncStatus } from '@/lib/services/gameSync';
import { Button } from '@/components/ui/button';

async function fetchPendingUnanalyzedCount() {
    const response = await fetch(
        '/api/games?hasAnalysis=false&page=1&limit=1',
        { cache: 'no-store' }
    );
    const json = (await response.json().catch(() => ({}))) as {
        total?: number;
        error?: string;
    };
    if (!response.ok) {
        throw new Error(json.error ?? 'Could not load pending games');
    }
    if (typeof json.total !== 'number') {
        throw new Error('Pending game count is unavailable');
    }
    return json.total;
}

export function SyncGamesWidget({
    context,
    enableAnalyze = true,
    variant = 'button',
}: {
    context: 'home' | 'games';
    enableAnalyze?: boolean;
    variant?: 'button' | 'banner';
}) {
    const { data: session } = useSession();
    const ownerId = session?.user?.id ?? null;
    const [open, setOpen] = useState(false);
    const [openAnalyze, setOpenAnalyze] = useState(false);
    const router = useRouter();
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [statusOwnerId, setStatusOwnerId] = useState<string | null>(null);
    const [statusState, setStatusState] = useState<
        'loading' | 'ready' | 'error'
    >('loading');
    const [pendingUnanalyzed, setPendingUnanalyzed] = useState<number | null>(null);
    const [pendingOwnerId, setPendingOwnerId] = useState<string | null>(null);
    const [pendingState, setPendingState] = useState<
        'idle' | 'loading' | 'ready' | 'error'
    >('loading');

    const refreshStatus = useCallback(async () => {
        if (!ownerId) return;
        try {
            setStatus(await getSyncStatus());
            setStatusOwnerId(ownerId);
            setStatusState('ready');
        } catch {
            setStatusOwnerId(ownerId);
            setStatusState('error');
        }
    }, [ownerId]);

    useEffect(() => {
        let cancelled = false;
        if (!ownerId) return;
        getSyncStatus()
            .then((nextStatus) => {
                if (cancelled) return;
                setStatus(nextStatus);
                setStatusOwnerId(ownerId);
                setStatusState('ready');
            })
            .catch(() => {
                if (!cancelled) {
                    setStatusOwnerId(ownerId);
                    setStatusState('error');
                }
            });
        return () => {
            cancelled = true;
        };
    }, [ownerId]);

    const currentStatus = statusOwnerId === ownerId ? status : null;
    const currentStatusState =
        statusOwnerId === ownerId ? statusState : 'loading';

    const hasLinked = useMemo(() => {
        return (
            !!currentStatus?.linked.lichessUsername ||
            !!currentStatus?.linked.chesscomUsername
        );
    }, [currentStatus]);

    useEffect(() => {
        if (context !== 'games' || !hasLinked) return;
        let cancelled = false;
        function refresh() {
            void fetchPendingUnanalyzedCount()
                .then((count) => {
                    if (cancelled) return;
                    setPendingUnanalyzed(count);
                    setPendingOwnerId(ownerId);
                    setPendingState('ready');
                })
                .catch(() => {
                    if (cancelled) return;
                    setPendingUnanalyzed(null);
                    setPendingOwnerId(ownerId);
                    setPendingState('error');
                });
        }
        refresh();
        const t = setInterval(refresh, 30_000);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [context, hasLinked, ownerId]);

    async function retryPendingCount() {
        setPendingState('loading');
        try {
            setPendingUnanalyzed(await fetchPendingUnanalyzedCount());
            setPendingOwnerId(ownerId);
            setPendingState('ready');
        } catch {
            setPendingUnanalyzed(null);
            setPendingOwnerId(ownerId);
            setPendingState('error');
        }
    }

    const currentPendingState =
        pendingOwnerId === ownerId ? pendingState : 'loading';
    const currentPending =
        pendingOwnerId === ownerId ? pendingUnanalyzed : null;

    if (currentStatusState === 'loading') {
        return (
            <div className="text-sm text-muted-foreground" role="status">
                Checking linked chess accounts…
            </div>
        );
    }

    if (currentStatusState === 'error') {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                    Could not load account sync status.
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setStatusState('loading');
                        void refreshStatus();
                    }}
                >
                    Try again
                </Button>
            </div>
        );
    }

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
                        <div>Sync games from your linked accounts into Backranq.</div>
                        {context === 'games' && currentPendingState === 'loading' ? (
                            <div className="mt-1" role="status">
                                Checking games awaiting analysis…
                            </div>
                        ) : null}
                        {context === 'games' && currentPendingState === 'error' ? (
                            <div className="mt-1 flex flex-wrap items-center gap-2" role="alert">
                                <span>Unanalyzed game count is currently unknown.</span>
                                <Button
                                    type="button"
                                    variant="link"
                                    size="sm"
                                    className="h-auto p-0"
                                    onClick={() => void retryPendingCount()}
                                >
                                    Try again
                                </Button>
                            </div>
                        ) : null}
                        {context === 'games' && typeof currentPending === 'number' && currentPending > 0 ? (
                            <div className="mt-1">
                                You have <span className="font-semibold">{currentPending}</span> games not analyzed yet.
                            </div>
                        ) : null}
                        {context === 'games' && currentStatus?.analysisJobs ? (
                            <div className="mt-1">
                                Server analysis: {currentStatus.analysisJobs.running} running • {currentStatus.analysisJobs.queued} queued
                                {currentStatus.analysisJobs.failed ? ` • ${currentStatus.analysisJobs.failed} failed` : ''}
                            </div>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {context === 'games' &&
                        typeof currentPending === 'number' &&
                        currentPending > 0 ? (
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
                    void refreshStatus();
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
