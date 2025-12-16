'use client';

import styles from '@/app/games/page.module.css';
import Link from 'next/link';

export type GameCardData = {
    id: string;
    provider: 'LICHESS' | 'CHESSCOM';
    playedAt: string; // ISO
    timeClass: 'BULLET' | 'BLITZ' | 'RAPID' | 'CLASSICAL' | 'UNKNOWN';
    rated: boolean | null;
    result: string | null; // PGN: 1-0, 0-1, 1/2-1/2
    termination: string | null;
    whiteName: string;
    whiteRating: number | null;
    blackName: string;
    blackRating: number | null;
    openingName: string | null;
    openingEco: string | null;
    analyzedAt: string | null;
    analysis: { whiteAccuracy?: number; blackAccuracy?: number } | null;
    puzzlesCount?: number; // future
};

function normalizeName(s: string) {
    return (s ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .replace(/^@/, '');
}

function outcomeLetter(result: string | null): 'W' | 'L' | 'D' | '?' {
    if (result === '1-0') return 'W';
    if (result === '0-1') return 'L';
    if (result === '1/2-1/2') return 'D';
    return '?';
}

function outcomeClass(letter: 'W' | 'L' | 'D' | '?') {
    if (letter === 'W') return styles.badgeWin;
    if (letter === 'L') return styles.badgeLoss;
    if (letter === 'D') return styles.badgeDraw;
    return styles.badgeUnknown;
}

function timeLabel(tc: GameCardData['timeClass']) {
    return tc === 'BULLET'
        ? 'Bullet'
        : tc === 'BLITZ'
          ? 'Blitz'
          : tc === 'RAPID'
            ? 'Rapid'
            : tc === 'CLASSICAL'
              ? 'Classical'
              : 'Unknown';
}

export function GameCard({
    game,
    userNameForProvider,
}: {
    game: GameCardData;
    userNameForProvider: string;
}) {
    const user = normalizeName(userNameForProvider);
    const w = normalizeName(game.whiteName);
    const b = normalizeName(game.blackName);
    const userIsWhite = user && user === w;
    const userIsBlack = user && user === b;

    const opponentName = userIsWhite
        ? game.blackName
        : userIsBlack
          ? game.whiteName
          : `${game.whiteName} vs ${game.blackName}`;
    const opponentRating = userIsWhite
        ? game.blackRating
        : userIsBlack
          ? game.whiteRating
          : null;

    const badge = outcomeLetter(game.result);
    const played = new Date(game.playedAt).toLocaleDateString();
    const providerLabel = game.provider === 'LICHESS' ? 'Lichess' : 'Chess.com';

    const opening =
        game.openingName ??
        (game.openingEco ? `${game.openingEco}` : null);

    const accuracy =
        userIsWhite
            ? game.analysis?.whiteAccuracy
            : userIsBlack
              ? game.analysis?.blackAccuracy
              : null;

    return (
        <div className={styles.card}>
            <div className={styles.cardTop}>
                <div className={styles.cardTitle}>
                    <div className={styles.cardTitleStrong}>
                        {opponentName}
                        {typeof opponentRating === 'number'
                            ? ` (${opponentRating})`
                            : ''}
                    </div>
                    <div className={styles.cardTitleSub}>
                        {providerLabel} • {timeLabel(game.timeClass)} • {played}
                        {userIsWhite ? ' • You: White' : userIsBlack ? ' • You: Black' : ''}
                    </div>
                </div>

                <span className={`${styles.badge} ${outcomeClass(badge)}`}>
                    {badge}
                </span>
            </div>

            <div className={styles.chipRow}>
                <span className={styles.chip}>
                    {game.rated == null ? 'Rated: ?' : game.rated ? 'Rated' : 'Casual'}
                </span>
                {opening ? <span className={styles.chip}>📘 {opening}</span> : null}
                {game.analyzedAt ? (
                    <span className={styles.chip}>
                        🧠 {typeof accuracy === 'number' ? `${accuracy.toFixed(1)}%` : 'Analyzed'}
                    </span>
                ) : (
                    <span className={styles.chip}>Not analyzed</span>
                )}
                {typeof game.puzzlesCount === 'number' ? (
                    <span className={styles.chip}>🧩 {game.puzzlesCount}</span>
                ) : null}
            </div>

            <div className={styles.actions}>
                <Link className={styles.secondaryButton} href={`/games/${game.id}`}>
                    View
                </Link>
            </div>
        </div>
    );
}


