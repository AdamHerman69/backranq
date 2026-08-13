import Link from 'next/link';
import { ArrowRight, Target } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { GameTrainingMomentMarker } from '@/lib/games/trainingMomentMarkers';

export type GameTrainingMomentRow = GameTrainingMomentMarker;

export function GameTrainingMomentsPreview({
    trainingMoments,
    gameId,
}: {
    trainingMoments: GameTrainingMomentRow[];
    gameId: string;
}) {
    return (
        <section className="space-y-4 rounded-[1.25rem] border bg-card/70 p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        Train what mattered
                    </p>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight">
                        {trainingMoments.length > 0
                            ? `${trainingMoments.length} practice ${trainingMoments.length === 1 ? 'position' : 'positions'}`
                            : 'No practice positions yet'}
                    </h2>
                </div>
                {trainingMoments.length > 0 ? (
                    <Button asChild size="sm">
                        <Link href={`/practice?gameId=${encodeURIComponent(gameId)}`}>
                            <Target aria-hidden="true" />
                            Start practice
                        </Link>
                    </Button>
                ) : null}
            </div>

            {trainingMoments.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                    Analysis did not save a stable personal decision from this game.
                </p>
            ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {trainingMoments.map((moment) => (
                        <Link
                            key={moment.id}
                            href={`/practice?momentId=${encodeURIComponent(moment.id)}`}
                            className="group flex min-h-14 items-center justify-between gap-3 rounded-xl border bg-background/70 px-3 py-2.5 text-sm transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                            <span>
                                <span className="block font-semibold">
                                    Move {Math.floor(moment.decisionPly / 2) + 1}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    Personal decision
                                </span>
                            </span>
                            <ArrowRight
                                className="h-4 w-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5"
                                aria-hidden="true"
                            />
                        </Link>
                    ))}
                </div>
            )}
        </section>
    );
}
