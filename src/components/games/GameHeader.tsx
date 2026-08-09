import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getUserGameOutcome } from '@/lib/games/outcome';
import type { GameSource, GameUserSide } from '@prisma/client';

export type GameHeaderData = {
    provider: GameSource;
    userSide: GameUserSide;
    url: string | null;
    playedAt: string; // ISO
    timeClass: 'BULLET' | 'BLITZ' | 'RAPID' | 'CLASSICAL' | 'UNKNOWN';
    rated: boolean | null;
    result: string | null;
    termination: string | null;
    whiteName: string;
    whiteRating: number | null;
    blackName: string;
    blackRating: number | null;
    openingEco: string | null;
    openingName: string | null;
    openingVariation: string | null;
    analyzedAt: string | null;
    accuracy?: { white?: number; black?: number };
};

function timeLabel(tc: GameHeaderData['timeClass']) {
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

function providerLabel(p: GameHeaderData['provider']) {
    return p === 'LICHESS'
        ? 'Lichess'
        : p === 'CHESSCOM'
          ? 'Chess.com'
          : p === 'MANUAL_PGN'
            ? 'Manual PGN'
            : 'Backranq Coach';
}

export function GameHeader({ game }: { game: GameHeaderData }) {
    const played = new Date(game.playedAt).toLocaleString();
    const playedDate = new Date(game.playedAt).toLocaleDateString();
    const openingName = game.openingName
        ? `${game.openingName}${game.openingVariation ? ` — ${game.openingVariation}` : ''}`
        : game.openingVariation;
    const opening = [game.openingEco, openingName]
        .filter((value): value is string => Boolean(value))
        .join(' · ');

    const outcome = getUserGameOutcome({
        result: game.result,
        userSide: game.userSide,
    });
    const outcomeLabel =
        outcome === 'W'
            ? 'You won'
            : outcome === 'L'
              ? 'You lost'
              : outcome === 'D'
                ? 'Draw'
                : game.result ?? 'Result pending';

    return (
        <section
            className="overflow-hidden rounded-lg border border-foreground/10 bg-card/70 shadow-card"
            aria-label="Game summary"
        >
            <div className="flex items-center justify-between gap-2 border-b bg-muted/35 px-3 py-2 text-xs text-muted-foreground sm:px-5 sm:py-2.5">
                <div className="flex min-w-0 items-center gap-x-1.5 sm:hidden">
                    <span className="truncate">{providerLabel(game.provider)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{timeLabel(game.timeClass)}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{playedDate}</span>
                </div>
                <div className="hidden flex-wrap items-center gap-x-2 gap-y-1 sm:flex">
                    <span>{providerLabel(game.provider)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{timeLabel(game.timeClass)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{played}</span>
                    {game.rated != null ? (
                        <>
                            <span aria-hidden="true">·</span>
                            <span>{game.rated ? 'Rated' : 'Casual'}</span>
                        </>
                    ) : null}
                </div>
                <div className="flex items-center gap-2">
                    <Badge variant={outcome === 'W' ? 'default' : 'secondary'}>
                        {outcomeLabel}
                    </Badge>
                    {game.url ? (
                        <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 sm:h-8 sm:w-8"
                        >
                            <Link
                                href={game.url}
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Open original game"
                            >
                                <ExternalLink aria-hidden="true" />
                            </Link>
                        </Button>
                    ) : null}
                </div>
            </div>

            <div className="grid gap-0.5 p-2 sm:grid-cols-2 sm:gap-0 sm:divide-x sm:p-2">
                <PlayerRow
                    color="white"
                    name={game.whiteName}
                    rating={game.whiteRating}
                    accuracy={game.accuracy?.white}
                    isYou={game.userSide === 'WHITE'}
                />
                <PlayerRow
                    color="black"
                    name={game.blackName}
                    rating={game.blackRating}
                    accuracy={game.accuracy?.black}
                    isYou={game.userSide === 'BLACK'}
                />
            </div>

            {opening ? (
                <div className="hidden border-t px-4 py-2.5 text-xs text-muted-foreground sm:block sm:px-5">
                    {opening}
                </div>
            ) : null}
        </section>
    );
}

function PlayerRow({
    color,
    name,
    rating,
    accuracy,
    isYou,
}: {
    color: 'white' | 'black';
    name: string;
    rating: number | null;
    accuracy?: number;
    isYou: boolean;
}) {
    return (
        <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/45 sm:gap-3 sm:px-4 sm:py-2">
            <span
                className={
                    color === 'white'
                        ? 'h-8 w-8 shrink-0 rounded-full border bg-white shadow-inner sm:h-9 sm:w-9'
                        : 'h-8 w-8 shrink-0 rounded-full border border-foreground/20 bg-foreground shadow-inner sm:h-9 sm:w-9'
                }
                aria-label={`${color} pieces`}
            />
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold sm:text-base">
                        {name}
                    </span>
                    {isYou ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
                            You
                        </span>
                    ) : null}
                </div>
                {rating != null ? (
                    <span className="text-xs text-muted-foreground">{rating}</span>
                ) : null}
            </div>
            {accuracy != null ? (
                <div className="text-right">
                    <div className="text-sm font-semibold tabular-nums">
                        {accuracy.toFixed(1)}%
                    </div>
                    <div className="hidden text-[10px] uppercase tracking-[0.12em] text-muted-foreground sm:block">
                        accuracy
                    </div>
                </div>
            ) : null}
        </div>
    );
}
