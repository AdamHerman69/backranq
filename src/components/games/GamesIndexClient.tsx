'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';
import type { GameCardData } from '@/components/games/GameCard';
import { GamesFilter, type GamesFilters } from '@/components/games/GamesFilter';
import { GamesList } from '@/components/games/GamesList';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function GamesIndexClient({
    games,
    total,
    page,
    totalPages,
    baseQueryString,
    userNameByProvider,
    initialFilters,
}: {
    games: GameCardData[];
    total: number;
    page: number;
    totalPages: number;
    baseQueryString: string;
    userNameByProvider: { lichess: string; chesscom: string };
    initialFilters: GamesFilters;
}) {
    const router = useRouter();
    const [selected, setSelected] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState(false);

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

    function reevaluateSelected() {
        if (selectedIds.length === 0) return;
        backgroundAnalysis.enqueueGameDbIds(selectedIds);
        toast.message(`Queued ${selectedIds.length} game${selectedIds.length === 1 ? '' : 's'} for re-analysis.`);
    }

    async function deleteSelected() {
        if (selectedIds.length === 0) return;
        const ok = window.confirm(
            `Delete ${selectedIds.length} game${selectedIds.length === 1 ? '' : 's'}? This cannot be undone.`
        );
        if (!ok) return;

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
                                    onClick={reevaluateSelected}
                                    disabled={busy || selectedCount === 0}
                                >
                                    Reevaluate
                                </Button>
                                <Button
                                    type="button"
                                    variant="destructive"
                                    onClick={() => void deleteSelected()}
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
        </div>
    );
}

