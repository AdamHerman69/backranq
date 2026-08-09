'use client';

import Link from 'next/link';
import { ArrowRight, CircleDot, Target } from 'lucide-react';

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

function outcomeLabel(letter: 'W' | 'L' | 'D' | '?') {
    return letter === 'W'
        ? 'Won'
        : letter === 'L'
          ? 'Lost'
          : letter === 'D'
            ? 'Draw'
            : 'Unknown';
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
        <Card variant="plain" className="group overflow-hidden rounded-none border-b border-foreground/10 transition-colors duration-200 hover:bg-card/55">
            <CardContent className="px-0 py-4 sm:px-2 sm:py-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                        <div
                            className={cn(
                                'mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                                outcomeBadgeClass(badge)
                            )}
                            aria-label={outcomeLabel(badge)}
                        >
                            {badge}
                        </div>
                        <div className="min-w-0 space-y-1.5">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <div className="truncate text-base font-semibold">
                                {opponentName}
                                {typeof opponentRating === 'number'
                                    ? ` (${opponentRating})`
                                    : ''}
                            </div>
                            <Badge className={cn('border-transparent', outcomeBadgeClass(badge))}>
                                {outcomeLabel(badge)}
                            </Badge>
                        </div>

                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                            {providerLabel} • {timeLabel(game.timeClass)} • {played}
                            {userIsWhite
                                ? ' • You: White'
                                : userIsBlack
                                  ? ' • You: Black'
                                  : ''}
                        </div>

                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                            {opening ? (
                                <span className="max-w-full truncate text-xs text-muted-foreground">
                                    {opening}
                                </span>
                            ) : null}
                            {game.analyzedAt ? (
                                <Badge variant="outline">
                                    {typeof accuracy === 'number'
                                        ? `${accuracy.toFixed(1)}% accuracy`
                                        : 'Analyzed'}
                                </Badge>
                            ) : (
                                <Badge variant="outline">
                                    <CircleDot className="mr-1 h-3 w-3" aria-hidden="true" />
                                    Needs analysis
                                </Badge>
                            )}
                        </div>
                        </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                        {selectable ? (
                            <input
                                type="checkbox"
                                className="h-5 w-5 accent-primary"
                                checked={!!selected}
                                disabled={selectionDisabled || !onSelectedChange}
                                onChange={(e) => onSelectedChange?.(e.target.checked)}
                                aria-label="Select game"
                            />
                        ) : null}
                        {trainingMoments.length > 0 ? (
                            <Button asChild size="sm" variant="secondary">
                                <Link
                                    href={`/practice?momentId=${encodeURIComponent(trainingMoments[0]!.id)}`}
                                >
                                    <Target aria-hidden="true" />
                                    {trainingMoments.length}{' '}
                                    {trainingMoments.length === 1
                                        ? 'position'
                                        : 'positions'}
                                </Link>
                            </Button>
                        ) : null}
                        <Button asChild size="sm" variant="outline">
                            <Link href={`/games/${game.id}`}>
                                Review
                                <ArrowRight
                                    className="transition-transform duration-150 group-hover:translate-x-0.5"
                                    aria-hidden="true"
                                />
                            </Link>
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}
