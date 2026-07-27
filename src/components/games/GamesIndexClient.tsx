'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { GameCardData } from '@/components/games/GameCard';
import { GamesFilter, type GamesFilters } from '@/components/games/GamesFilter';
import { GamesList } from '@/components/games/GamesList';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import type { ManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import { registerServerAnalysisEnqueue } from '@/lib/games/serverAnalysisTracking';
import { enqueueServerAnalysisJobs } from '@/lib/services/gameSync';

export function GamesIndexClient({
    ownerId,
    games,
    total,
    page,
    totalPages,
    baseQueryString,
    userNameByProvider,
    initialFilters,
    serverAnalysisCapacity,
}: {
    ownerId: string;
    games: GameCardData[];
    total: number;
    page: number;
    totalPages: number;
    baseQueryString: string;
    userNameByProvider: { lichess: string; chesscom: string };
    initialFilters: GamesFilters;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
}) {
    const router = useRouter();
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [reviewAction, setReviewAction] = useState<
        'reanalyze' | 'delete' | null
    >(null);

    // Keep selection clamped to the current page's game ids.
    useEffect(() => {
        setSelected((prev) => {
            const next: Record<string, boolean> = {};
            for (const g of games) next[g.id] = !!prev[g.id];
            return next;
        });
    }, [games]);

    const selectedIds = useMemo(() => {
        return Object.entries(selected)
            .filter(([, v]) => v)
            .map(([id]) => id);
    }, [selected]);

    const selectedCount = selectedIds.length;
    const maximumQueueable = Math.min(
        selectedCount,
        serverAnalysisCapacity.reservableCredits
    );
    const selectedSummary = useMemo(() => {
        const selectedIdSet = new Set(selectedIds);
        return games.reduce(
            (summary, game) => {
                if (!selectedIdSet.has(game.id)) return summary;
                if (game.analyzedAt) summary.analyzed += 1;
                summary.puzzles += game.puzzles?.length ?? 0;
                return summary;
            },
            { analyzed: 0, puzzles: 0 }
        );
    }, [games, selectedIds]);

    function selectAll() {
        const next: Record<string, boolean> = {};
        for (const g of games) next[g.id] = true;
        setSelected(next);
    }

    function deselectAll() {
        const next: Record<string, boolean> = {};
        for (const g of games) next[g.id] = false;
        setSelected(next);
    }

    async function reevaluateSelected() {
        if (selectedIds.length === 0) return;
        setBusy(true);
        try {
            const result = await enqueueServerAnalysisJobs({
                gameIds: selectedIds,
                force: true,
            });
            if (result.queued > 0) {
                registerServerAnalysisEnqueue({
                    ownerId,
                    result,
                });
            }
            const failed = result.errors?.length ?? 0;
            if (result.queued > 0 && failed > 0) {
                toast.warning(
                    `Queued ${result.queued}; ${failed} ${failed === 1 ? 'game was' : 'games were'} not queued.`
                );
            } else if (result.queued > 0) {
                toast.success(
                    `Queued ${result.queued} game${result.queued === 1 ? '' : 's'} for server re-analysis.`
                );
            } else if (failed > 0) {
                toast.error(
                    result.errors?.[0]?.error ??
                        'The selected games could not be queued.'
                );
            } else {
                toast.message(
                    `${result.skipped} ${result.skipped === 1 ? 'game is' : 'games are'} already queued or running.`
                );
            }
            setReviewAction(null);
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Failed to queue analysis');
        } finally {
            setBusy(false);
        }
    }

    async function deleteSelected() {
        if (selectedIds.length === 0) return;

        setBusy(true);
        const tId = toast.loading(
            `Deleting ${selectedIds.length} game${selectedIds.length === 1 ? '' : 's'}…`
        );
        try {
            const results = await Promise.allSettled(
                selectedIds.map(async (id) => {
                    const res = await fetch(`/api/games/${encodeURIComponent(id)}`, {
                        method: 'DELETE',
                    });
                    if (!res.ok) {
                        const json = (await res.json().catch(() => ({}))) as { error?: string };
                        throw new Error(json.error ?? `Delete failed (${res.status})`);
                    }
                    return true;
                })
            );

            const okCount = results.filter((r) => r.status === 'fulfilled').length;
            const failCount = results.length - okCount;
            if (failCount === 0) {
                toast.success(`Deleted ${okCount} game${okCount === 1 ? '' : 's'}.`, { id: tId });
            } else if (okCount === 0) {
                toast.error('Failed to delete games.', { id: tId });
            } else {
                toast.message(`Deleted ${okCount}; ${failCount} failed.`, { id: tId });
            }

            setSelected({});
            setReviewAction(null);
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Delete failed', { id: tId });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-6">
            <Card>
                <CardContent className="p-4">
                    {selectedCount > 0 ? (
                        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                            <div className="text-sm text-muted-foreground">
                                {selectedCount} selected
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={selectAll}
                                    disabled={busy || games.length === 0}
                                >
                                    Select all
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={deselectAll}
                                    disabled={busy || games.length === 0}
                                >
                                    Deselect all
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    onClick={() => setReviewAction('reanalyze')}
                                    disabled={busy || selectedCount === 0}
                                >
                                    Reevaluate
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => setReviewAction('delete')}
                                    disabled={busy || selectedCount === 0}
                                >
                                    Delete
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    <GamesFilter total={total} initial={initialFilters} />
                </CardContent>
            </Card>

            <GamesList
                games={games}
                total={total}
                page={page}
                totalPages={totalPages}
                baseQueryString={baseQueryString}
                userNameByProvider={userNameByProvider}
                selected={selected}
                onSelectedChange={(id, v) => setSelected((s) => ({ ...s, [id]: v }))}
                selectionDisabled={busy}
            />

            <ActionConfirmDialog
                open={reviewAction === 'reanalyze'}
                onOpenChange={(open) =>
                    setReviewAction(open ? 'reanalyze' : null)
                }
                title={`Re-analyze ${selectedCount} selected ${selectedCount === 1 ? 'game' : 'games'}?`}
                description="Server re-analysis runs in the background and can spend one credit per accepted game."
                confirmLabel={`Queue up to ${maximumQueueable} ${maximumQueueable === 1 ? 'game' : 'games'}`}
                onConfirm={reevaluateSelected}
                busy={busy}
                confirmDisabled={maximumQueueable < 1}
            >
                <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Selected games</dt>
                        <dd className="font-semibold">{selectedCount}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Requested maximum cost
                        </dt>
                        <dd className="font-semibold">
                            {selectedCount} {selectedCount === 1 ? 'credit' : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Current credit balance
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.currentBalance}{' '}
                            {serverAnalysisCapacity.currentBalance === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Manual reservable capacity
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.reservableCredits}{' '}
                            {serverAnalysisCapacity.reservableCredits === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Maximum newly queueable
                        </dt>
                        <dd className="font-semibold">
                            {maximumQueueable} of {selectedCount}{' '}
                            {selectedCount === 1 ? 'game' : 'games'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Outstanding reservations
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.outstandingReservations}{' '}
                            {serverAnalysisCapacity.outstandingReservations === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Monthly capacity after reservations
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.monthlyRemaining}{' '}
                            {serverAnalysisCapacity.monthlyRemaining === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Safety floor</dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.stopThreshold}{' '}
                            {serverAnalysisCapacity.stopThreshold === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Existing analysis
                        </dt>
                        <dd className="font-semibold">
                            {selectedSummary.analyzed} of {selectedCount}{' '}
                            {selectedCount === 1 ? 'game' : 'games'}
                        </dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Impact</dt>
                        <dd>
                            Each completed re-analysis replaces that game&apos;s
                            current evaluation. Matching puzzles are updated, stale
                            puzzles are archived, and new puzzles are added. The
                            selection currently contains {selectedSummary.puzzles}{' '}
                            visible{' '}
                            {selectedSummary.puzzles === 1 ? 'puzzle' : 'puzzles'}.
                            Attempt history is preserved. Already queued games may be
                            skipped and do not add another charge.
                        </dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Capacity note</dt>
                        <dd>{serverAnalysisCapacity.limitingReason}</dd>
                    </div>
                    {selectedCount > serverAnalysisCapacity.reservableCredits ? (
                        <div className="sm:col-span-2">
                            <dt className="font-medium text-amber-700 dark:text-amber-300">
                                Partial queue expected
                            </dt>
                            <dd>
                                Current manual capacity can reserve at most{' '}
                                {maximumQueueable}{' '}
                                {maximumQueueable === 1 ? 'game' : 'games'}.
                                Remaining games will not be queued unless earlier
                                selections are already queued or running and
                                therefore skipped without a new reservation.
                            </dd>
                        </div>
                    ) : null}
                </dl>
            </ActionConfirmDialog>

            <ActionConfirmDialog
                open={reviewAction === 'delete'}
                onOpenChange={(open) => setReviewAction(open ? 'delete' : null)}
                title={`Permanently delete ${selectedCount} selected ${selectedCount === 1 ? 'game' : 'games'}?`}
                description="This cannot be undone."
                confirmLabel={`Delete ${selectedCount} ${selectedCount === 1 ? 'game' : 'games'}`}
                onConfirm={deleteSelected}
                variant="destructive"
                busy={busy}
            >
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                    Deleting these {selectedCount}{' '}
                    {selectedCount === 1 ? 'game' : 'games'} also permanently
                    removes every associated puzzle, including archived puzzles, and
                    all of their attempt history.
                </div>
            </ActionConfirmDialog>
        </div>
    );
}
