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
import { Card, CardContent } from '@/components/ui/card';
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
                    <GamesSelectionToolbar
                        selectedCount={selectedCount}
                        busy={busy}
                        hasGames={games.length > 0}
                        onSelectAll={selectAll}
                        onDeselectAll={deselectAll}
                        onReevaluate={() => setReviewAction('reanalyze')}
                        onDelete={() => setReviewAction('delete')}
                    />

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
