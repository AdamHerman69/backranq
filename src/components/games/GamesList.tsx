'use client';

import styles from '@/app/games/page.module.css';
import Link from 'next/link';
import { GameCard, type GameCardData } from './GameCard';

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
            <div className={styles.panel}>
                <div className={styles.muted}>No games match your filters.</div>
            </div>
        );
    }

    return (
        <div className={styles.panel}>
            <div className={styles.muted}>
                Showing page {page} of {totalPages} • {total} total
            </div>
            <div className={styles.cards}>
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

            <div className={styles.pagination}>
                {page <= 1 ? (
                    <button className={styles.secondaryButton} disabled>
                        Prev
                    </button>
                ) : (
                    <Link className={styles.secondaryButton} href={pageHref(page - 1)}>
                        Prev
                    </Link>
                )}
                <div className={styles.muted}>
                    Page {page} / {totalPages}
                </div>
                {page >= totalPages ? (
                    <button className={styles.secondaryButton} disabled>
                        Next
                    </button>
                ) : (
                    <Link className={styles.secondaryButton} href={pageHref(page + 1)}>
                        Next
                    </Link>
                )}
            </div>
        </div>
    );
}


