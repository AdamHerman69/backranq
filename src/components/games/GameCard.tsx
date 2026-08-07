'use client';

import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { getUserGameOutcome } from '@/lib/games/outcome';
import { cn } from '@/lib/utils';
import type { GameSource, GameUserSide } from '@prisma/client';

export type GameCardData = {
    id: string;
    provider: GameSource;
    sourceUsername: string;
    userSide: GameUserSide;
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
    trainingMoments?: { id: string; decisionPly: number }[];
};

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
    selectable = false,
    selected = false,
    selectionDisabled = false,
    onSelectedChange,
}: {
    game: GameCardData;
    selectable?: boolean;
    selected?: boolean;
    selectionDisabled?: boolean;
    onSelectedChange?: (selected: boolean) => void;
}) {
    const userIsWhite = game.userSide === 'WHITE';
    const userIsBlack = game.userSide === 'BLACK';

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

    const badge = getUserGameOutcome({
        result: game.result,
        userSide: game.userSide,
    });
    const played = new Date(game.playedAt).toLocaleDateString();
    const providerLabel =
        game.provider === 'LICHESS'
            ? 'Lichess'
            : game.provider === 'CHESSCOM'
              ? 'Chess.com'
              : game.provider === 'MANUAL_PGN'
                ? 'Manual PGN'
                : 'Backranq Coach';

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

    const trainingMoments = Array.isArray(game.trainingMoments)
        ? game.trainingMoments
        : [];

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
                                        ? `${userIsWhite ? '♔' : userIsBlack ? '♚' : 'Acc'} ${accuracy.toFixed(1)}%`
                                        : 'Analyzed'}
                                </Badge>
                            ) : (
                                <Badge variant="outline">Not analyzed</Badge>
                            )}
                        </div>

                        {trainingMoments.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5 pt-1">
                                {trainingMoments.map((moment) => (
                                    <Link
                                        key={moment.id}
                                        href={`/practice?momentId=${encodeURIComponent(moment.id)}`}
                                        title={`Personal practice position at move ${Math.floor(moment.decisionPly / 2) + 1}`}
                                    >
                                        <Badge variant="outline" className="cursor-pointer">
                                            Practice move{' '}
                                            {Math.floor(
                                                moment.decisionPly / 2
                                            ) + 1}
                                        </Badge>
                                    </Link>
                                ))}
                            </div>
                        ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-2 self-start">
                        {selectable ? (
                            <input
                                type="checkbox"
                                className="h-4 w-4 accent-foreground"
                                checked={!!selected}
                                disabled={selectionDisabled || !onSelectedChange}
                                onChange={(e) => onSelectedChange?.(e.target.checked)}
                                aria-label="Select game"
                            />
                        ) : null}
                        <Button asChild size="sm" variant="outline">
                            <Link href={`/games/${game.id}`}>View</Link>
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
