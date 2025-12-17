'use client';

import Link from 'next/link';
import { GameCard, type GameCardData } from './GameCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export function GamesList({
    games,
    total,
    page,
    totalPages,
    baseQueryString,
    userNameByProvider,
}: {
    games: GameCardData[];
    total: number;
    page: number;
    totalPages: number;
    baseQueryString: string;
    userNameByProvider: { lichess: string; chesscom: string };
}) {
    function pageHref(nextPage: number) {
        const qs = baseQueryString ? `${baseQueryString}&page=${nextPage}` : `page=${nextPage}`;
        return `/games?${qs}`;
    }

    if (games.length === 0) {
        return (
            <Card>
                <CardContent className="py-6 text-sm text-muted-foreground">
                    No games match your filters.
                </CardContent>
            </Card>
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
                        userNameForProvider={
                            g.provider === 'LICHESS'
                                ? userNameByProvider.lichess
                                : userNameByProvider.chesscom
                        }
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


