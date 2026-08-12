'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import type { GameCardData } from '@/components/games/GameCard';
import { GamesFilter, type GamesFilters } from '@/components/games/GamesFilter';
import { GamesList } from '@/components/games/GamesList';
import { GamesSelectionDeleteDialog } from '@/components/games/GamesSelectionDeleteDialog';
import { GamesSelectionReanalysisDialog } from '@/components/games/GamesSelectionReanalysisDialog';
import { GamesSelectionToolbar } from '@/components/games/GamesSelectionToolbar';
import type { ManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import {
    acceptedServerAnalysisCount,
    queueServerAnalysisBatch,
    useHasConfirmingServerAnalysisRequest,
} from '@/lib/analysis/serverAnalysisCoordinator';

export function GamesIndexClient({
    ownerId,
    games,
    total,
    page,
    totalPages,
    baseQueryString,
    initialFilters,
    serverAnalysisCapacity,
}: {
    ownerId: string;
    games: GameCardData[];
    total: number;
    page: number;
    totalPages: number;
    baseQueryString: string;
    initialFilters: GamesFilters;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
}) {
    const router = useRouter();
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);
    const [selectionMode, setSelectionMode] = useState(false);
    const [reviewAction, setReviewAction] = useState<
        'reanalyze' | 'delete' | null
    >(null);
    const hasConfirmingServerRequest =
        useHasConfirmingServerAnalysisRequest(ownerId);

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
        serverAnalysisCapacity.reservableGames
    );
    const selectedSummary = useMemo(() => {
        const selectedIdSet = new Set(selectedIds);
        return games.reduce(
            (summary, game) => {
                if (!selectedIdSet.has(game.id)) return summary;
                if (game.analyzedAt) summary.analyzed += 1;
                summary.trainingMoments +=
                    game.trainingMoments?.length ?? 0;
                return summary;
            },
            { analyzed: 0, trainingMoments: 0 }
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
            const result = await queueServerAnalysisBatch({
                ownerId,
                gameIds: selectedIds,
                force: true,
            });
            if (result.state === 'confirming') {
                toast.message(
                    'The server is still confirming this request. Backranq will keep checking it in the background.'
                );
                setReviewAction(null);
                return;
            }
            const batch = result.batch;
            const accepted = acceptedServerAnalysisCount(batch);
            const failed = batch.failed;
            if (accepted > 0 && failed > 0) {
                toast.warning(
                    `Accepted ${accepted}; ${failed} ${failed === 1 ? 'game was' : 'games were'} not queued.`
                );
            } else if (accepted > 0) {
                toast.success(
                    `Accepted ${accepted} game${accepted === 1 ? '' : 's'} for server re-analysis.`
                );
            } else if (failed > 0) {
                toast.error('The selected games could not be queued.');
            } else {
                toast.message(
                    `${batch.skipped} ${batch.skipped === 1 ? 'game is' : 'games are'} already queued or complete.`
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
            <div className="border-y border-foreground/10 py-3 sm:py-4">
                <GamesSelectionToolbar
                    selectedCount={selectedCount}
                    busy={busy || hasConfirmingServerRequest}
                    hasGames={games.length > 0}
                    onSelectAll={selectAll}
                    onDeselectAll={deselectAll}
                    onReevaluate={() => setReviewAction('reanalyze')}
                    onDelete={() => setReviewAction('delete')}
                />

                <GamesFilter
                    total={total}
                    initial={initialFilters}
                    selectionMode={selectionMode}
                    onSelectionModeChange={(active) => {
                        setSelectionMode(active);
                        if (!active) deselectAll();
                    }}
                />
            </div>

            <GamesList
                games={games}
                total={total}
                page={page}
                totalPages={totalPages}
                baseQueryString={baseQueryString}
                selected={selected}
                onSelectedChange={
                    selectionMode
                        ? (id, v) => setSelected((s) => ({ ...s, [id]: v }))
                        : undefined
                }
                selectionDisabled={busy || hasConfirmingServerRequest}
            />

            <GamesSelectionReanalysisDialog
                open={reviewAction === 'reanalyze'}
                onOpenChange={(open) =>
                    setReviewAction(open ? 'reanalyze' : null)
                }
                selectedCount={selectedCount}
                maximumQueueable={maximumQueueable}
                selectedSummary={selectedSummary}
                serverAnalysisCapacity={serverAnalysisCapacity}
                onConfirm={reevaluateSelected}
                busy={busy}
                requestBlocked={hasConfirmingServerRequest}
            />

            <GamesSelectionDeleteDialog
                open={reviewAction === 'delete'}
                onOpenChange={(open) => setReviewAction(open ? 'delete' : null)}
                selectedCount={selectedCount}
                onConfirm={deleteSelected}
                busy={busy}
            />
        </div>
    );
}
