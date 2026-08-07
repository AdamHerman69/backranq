import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import type { GameSource } from '@prisma/client';

export type GameHeaderData = {
    provider: GameSource;
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
    const opening =
        game.openingName ??
        (game.openingEco ? `${game.openingEco}${game.openingVariation ? ` — ${game.openingVariation}` : ''}` : null);

    return (
        <TooltipProvider>
            <Card>
                <CardContent className="pt-6">
                    <div className="flex flex-col gap-2">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="truncate text-sm font-semibold">
                                    {game.whiteName}
                                    {typeof game.whiteRating === 'number'
                                        ? ` (${game.whiteRating})`
                                        : ''}{' '}
                                    vs {game.blackName}
                                    {typeof game.blackRating === 'number'
                                        ? ` (${game.blackRating})`
                                        : ''}
                                </div>
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {providerLabel(game.provider)} •{' '}
                                    {timeLabel(game.timeClass)} • {played}
                                    {game.rated == null
                                        ? ''
                                        : game.rated
                                          ? ' • Rated'
                                          : ' • Casual'}
                                    {game.result ? ` • ${game.result}` : ''}
                                    {game.termination ? ` • ${game.termination}` : ''}
                                </div>
                                {opening ? (
                                    <div className="mt-1 text-xs text-muted-foreground">
                                        📘 {opening}
                                    </div>
                                ) : null}
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                {game.analyzedAt &&
                                (game.accuracy?.white != null ||
                                    game.accuracy?.black != null) ? (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <div className="flex items-center gap-2">
                                                <Badge variant="outline">
                                                    ♔ {game.accuracy?.white?.toFixed(1) ?? '—'}%
                                                </Badge>
                                                <Badge variant="outline">
                                                    ♚ {game.accuracy?.black?.toFixed(1) ?? '—'}%
                                                </Badge>
                                            </div>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Overall accuracy (0–100) computed from engine eval changes during analysis.
                                        </TooltipContent>
                                    </Tooltip>
                                ) : null}

                                {game.url ? (
                                    <Button asChild variant="outline" size="sm">
                                        <Link
                                            href={game.url}
                                            target="_blank"
                                            rel="noreferrer"
                                        >
                                            Open original
                                        </Link>
                                    </Button>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </TooltipProvider>
    );
}

