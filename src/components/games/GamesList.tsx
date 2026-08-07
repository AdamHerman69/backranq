'use client';

import Link from 'next/link';
import { GameCard, type GameCardData } from './GameCard';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/async-state';

export function GamesList({
    games,
    total,
    page,
    totalPages,
    baseQueryString,
    selected,
    onSelectedChange,
    selectionDisabled,
}: {
    games: GameCardData[];
    total: number;
    page: number;
    totalPages: number;
    baseQueryString: string;
    selected?: Record<string, boolean>;
    onSelectedChange?: (id: string, selected: boolean) => void;
    selectionDisabled?: boolean;
}) {
    function pageHref(nextPage: number) {
        const qs = baseQueryString ? `${baseQueryString}&page=${nextPage}` : `page=${nextPage}`;
        return `/games?${qs}`;
    }

    if (games.length === 0) {
        return (
            <EmptyState
                title="No games in this view"
                description="Try another filter, or sync your latest games above."
                action={
                    <Button asChild variant="outline">
                        <Link href="/games">Show all games</Link>
                    </Button>
                }
            />
        );
    }

    return (
        <div className="space-y-4">
            <div className="text-sm text-muted-foreground">
                Showing page {page} of {totalPages} • {total} total
            </div>
            <div className="space-y-2">
                {games.map((g) => (
                    <GameCard
                        key={g.id}
                        game={g}
                        selectable={!!onSelectedChange}
                        selected={!!selected?.[g.id]}
                        selectionDisabled={selectionDisabled}
                        onSelectedChange={(v) => onSelectedChange?.(g.id, v)}
                    />
                ))}
            </div>

            <div className="flex items-center justify-between gap-3">
                {page <= 1 ? (
                    <Button variant="outline" disabled>
                        Prev
                    </Button>
                ) : (
                    <Button asChild variant="outline">
                        <Link href={pageHref(page - 1)}>Prev</Link>
                    </Button>
                )}
                <div className="text-sm text-muted-foreground">
                    Page {page} / {totalPages}
                </div>
                {page >= totalPages ? (
                    <Button variant="outline" disabled>
                        Next
                    </Button>
                ) : (
                    <Button asChild variant="outline">
                        <Link href={pageHref(page + 1)}>Next</Link>
                    </Button>
                )}
            </div>
        </div>
    );
}
