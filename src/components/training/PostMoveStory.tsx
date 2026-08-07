import { ExternalLink } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TrainingReviewDto } from '@/lib/training/api';
import {
    formatOutcomeDifference,
    formatScoreForTrainingSide,
    formatSignedOutcomeDifference,
    lessonLabel,
    moveLabel,
    moveLineLabels,
    sourceLabel,
    themeLabel,
} from '@/lib/training/presentation';

function safeSourceUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.toString() : null;
    } catch {
        return null;
    }
}

export function PostMoveStory({
    review,
    rootFen,
    grade,
    showGameMove = true,
    sourceUrl,
    sourceNotice,
    compact = false,
    bestMoveShown = false,
    onShowAttempt,
    onShowBest,
}: {
    review: TrainingReviewDto;
    rootFen: string;
    grade: string | null;
    showGameMove?: boolean;
    sourceUrl?: string | null;
    sourceNotice?: string | null;
    compact?: boolean;
    bestMoveShown?: boolean;
    onShowAttempt?: () => void;
    onShowBest?: () => void;
}) {
    const playedAt = new Date(review.source.playedAt);
    const sourceDate = Number.isNaN(playedAt.getTime())
        ? review.source.playedAt
        : playedAt.toLocaleDateString();
    const acceptedAlternatives = Array.from(
        new Set([
            ...review.acceptedMovesUci,
            ...(grade === 'BEST' || grade === 'STRONG' || grade === 'GOOD'
                ? [review.submittedMoveUci]
                : []),
        ])
    ).filter(
        (move): move is string =>
            Boolean(move) &&
            move?.trim().toLowerCase() !==
                review.bestMoveUci.trim().toLowerCase()
    );
    const bestLine = moveLineLabels(rootFen, review.bestLineUci);
    const publicSourceUrl = safeSourceUrl(sourceUrl);

    return (
        <Card role="region" aria-label="Position review">
            <CardHeader className="pb-3">
                <CardTitle className="text-base">Position review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 text-sm">
                <dl
                    className={
                        compact
                            ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3'
                            : 'grid gap-3 sm:grid-cols-2'
                    }
                >
                    <div>
                        <dt className="text-muted-foreground">Your move</dt>
                        <dd className="mt-1 font-medium">
                            {moveLabel(rootFen, review.submittedMoveUci)}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Best move</dt>
                        <dd className="mt-1 font-medium">
                            {moveLabel(rootFen, review.bestMoveUci)}
                        </dd>
                    </div>
                    {showGameMove ? (
                        <div>
                            <dt className="text-muted-foreground">
                                Move played in the game
                            </dt>
                            <dd className="mt-1 font-medium">
                                {moveLabel(rootFen, review.originalMoveUci)}
                            </dd>
                        </div>
                    ) : null}
                    {!compact ? (
                        <div>
                            <dt className="text-muted-foreground">
                                Position before the decision
                            </dt>
                            <dd className="mt-1 font-medium">
                                {formatScoreForTrainingSide(
                                    review.scoreAtStart,
                                    review.trainingSide
                                )}
                            </dd>
                        </div>
                    ) : null}
                </dl>

                {onShowBest ? (
                    <div
                        className="hidden flex-wrap items-center gap-2 rounded-lg border bg-muted/20 p-2 md:flex"
                        role="group"
                        aria-label="Compare positions on the board"
                    >
                        {review.submittedMoveUci && onShowAttempt ? (
                            <Button
                                type="button"
                                size="sm"
                                variant={
                                    bestMoveShown ? 'outline' : 'secondary'
                                }
                                onClick={onShowAttempt}
                                aria-pressed={!bestMoveShown}
                            >
                                Your move
                            </Button>
                        ) : null}
                        <Button
                            type="button"
                            size="sm"
                            variant={bestMoveShown ? 'secondary' : 'outline'}
                            onClick={onShowBest}
                            aria-pressed={bestMoveShown}
                        >
                            Show best
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            The best-move arrow appears only when you request it.
                        </span>
                    </div>
                ) : null}

                {acceptedAlternatives.length > 0 ||
                !review.acceptedMovesComplete ? (
                    <div>
                        <div className="text-muted-foreground">
                            {review.acceptedMovesComplete
                                ? 'Other good moves'
                                : 'Known good alternatives'}
                        </div>
                        {acceptedAlternatives.length > 0 ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                                {acceptedAlternatives.map((move) => (
                                    <Badge key={move} variant="secondary">
                                        {moveLabel(rootFen, move)}
                                    </Badge>
                                ))}
                            </div>
                        ) : null}
                        {!review.acceptedMovesComplete ? (
                            <p className="mt-2 text-xs text-muted-foreground">
                                This is not an exhaustive list. Other legal moves
                                are evaluated when you play them.
                            </p>
                        ) : null}
                    </div>
                ) : null}

                <div>
                    <div className="text-muted-foreground">
                        Best continuation
                    </div>
                    <p className="mt-1 font-medium">
                        {bestLine.join(' ') || 'No continuation needed.'}
                    </p>
                </div>

                {!compact && review.comparison ? (
                    <dl className="grid gap-3 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
                        <div>
                            <dt className="text-muted-foreground">
                                Distance from the best move
                            </dt>
                            <dd className="mt-1 font-medium">
                                {formatOutcomeDifference({
                                    winChance:
                                        review.comparison.bestGapWinChance,
                                    cp: review.comparison.bestGapCp,
                                })}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-muted-foreground">
                                Change versus your game
                            </dt>
                            <dd className="mt-1 font-medium">
                                {formatSignedOutcomeDifference({
                                    winChance:
                                        review.comparison.recoveredWinChance,
                                    cp: review.comparison.recoveredCp,
                                })}
                            </dd>
                        </div>
                    </dl>
                ) : null}

                <div className={compact ? undefined : 'border-t pt-4'}>
                    <div className="flex flex-wrap gap-2">
                        {review.sourceKinds.map((value) => (
                            <Badge key={`source:${value}`} variant="secondary">
                                {sourceLabel(value)}
                            </Badge>
                        ))}
                        {review.lessonKinds.map((value) => (
                            <Badge key={`lesson:${value}`} variant="outline">
                                {lessonLabel(value)}
                            </Badge>
                        ))}
                        {review.themes.map((value) => (
                            <Badge key={`theme:${value}`} variant="outline">
                                {themeLabel(value)}
                            </Badge>
                        ))}
                    </div>
                    {!compact ? (
                        <p className="mt-3 text-xs text-muted-foreground">
                            {review.source.provider === 'lichess'
                                ? 'Lichess'
                                : 'Chess.com'}{' '}
                            game · {sourceDate} · move{' '}
                            {Math.floor(review.source.decisionPly / 2) + 1}
                        </p>
                    ) : null}
                </div>

                {publicSourceUrl ? (
                    <a
                        href={publicSourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                    >
                        Open the public source game
                        <ExternalLink
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                        />
                    </a>
                ) : sourceNotice ? (
                    <p className="text-xs text-muted-foreground">
                        {sourceNotice}
                    </p>
                ) : null}
            </CardContent>
        </Card>
    );
}
