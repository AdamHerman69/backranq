'use client';

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

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
    openingVariation?: string | null;
    analyzedAt: string | null;
    analysis: { whiteAccuracy?: number; blackAccuracy?: number } | null;
    puzzles?: { id: string; sourcePly: number; type: 'AVOID_BLUNDER' | 'PUNISH_BLUNDER' }[];
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

function outcomeBadgeClass(letter: 'W' | 'L' | 'D' | '?') {
    if (letter === 'W') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300';
    if (letter === 'L') return 'bg-red-500/15 text-red-700 dark:text-red-300';
    if (letter === 'D') return 'bg-amber-500/20 text-amber-700 dark:text-amber-300';
    return 'bg-muted text-muted-foreground';
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

    const opening = game.openingName
        ? `${game.openingEco ? `${game.openingEco} ` : ''}${game.openingName}${game.openingVariation ? ` — ${game.openingVariation}` : ''}`.trim()
        : game.openingEco
          ? `${game.openingEco}`
          : null;

    const accuracy =
        userIsWhite
            ? game.analysis?.whiteAccuracy
            : userIsBlack
              ? game.analysis?.blackAccuracy
              : null;

    const puzzles = Array.isArray(game.puzzles) ? game.puzzles : [];

    return (
        <Card>
            <CardContent className="py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate text-sm font-semibold">
                                {opponentName}
                                {typeof opponentRating === 'number'
                                    ? ` (${opponentRating})`
                                    : ''}
                            </div>
                            <Badge className={cn('border-transparent', outcomeBadgeClass(badge))}>
                                {badge}
                            </Badge>
                        </div>

                        <div className="text-xs text-muted-foreground">
                            {providerLabel} • {timeLabel(game.timeClass)} • {played}
                            {userIsWhite
                                ? ' • You: White'
                                : userIsBlack
                                  ? ' • You: Black'
                                  : ''}
                        </div>

                        <div className="flex flex-wrap gap-2 pt-0.5">
                            <Badge variant="secondary">
                                {opening ? opening : 'Opening: —'}
                            </Badge>
                            {game.analyzedAt ? (
                                <Badge variant="secondary">
                                    {typeof accuracy === 'number'
                                        ? `${accuracy.toFixed(1)}%`
                                        : 'Analyzed'}
                                </Badge>
                            ) : (
                                <Badge variant="outline">Not analyzed</Badge>
                            )}
                        </div>

                        {puzzles.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                                {puzzles.map((p) => (
                                    <Link
                                        key={p.id}
                                        href={`/puzzles?puzzleId=${encodeURIComponent(p.id)}`}
                                        title={`${p.type} • ply ${p.sourcePly + 1}`}
                                    >
                                        <Badge variant="outline" className="cursor-pointer">
                                            Ply {p.sourcePly + 1}
                                        </Badge>
                                    </Link>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2 self-start">
                        <Button asChild size="sm" variant="outline">
                            <Link href={`/games/${game.id}`}>View</Link>
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}


