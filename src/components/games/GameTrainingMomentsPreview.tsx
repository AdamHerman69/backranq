import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { GameTrainingMomentMarker } from '@/lib/games/trainingMomentMarkers';

export type GameTrainingMomentRow = GameTrainingMomentMarker;

export function GameTrainingMomentsPreview({
    trainingMoments,
}: {
    trainingMoments: GameTrainingMomentRow[];
}) {
    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                        Training moments from this game
                        <span className="ml-2 text-sm font-normal text-muted-foreground">
                            ({trainingMoments.length})
                        </span>
                    </CardTitle>
                    {trainingMoments.length > 0 ? (
                        <Button asChild variant="outline" size="sm">
                            <Link href="/training">Train</Link>
                        </Button>
                    ) : null}
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {trainingMoments.length === 0 ? (
                    <div className="text-sm text-muted-foreground">
                        No active training moments for this game yet.
                    </div>
                ) : (
                    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                        {trainingMoments.map((moment) => (
                            <Card key={moment.id} className="shadow-none">
                                <CardContent className="pt-6">
                                    <div className="flex items-center justify-between gap-2">
                                        <Badge variant="secondary">
                                            Personal decision
                                        </Badge>
                                        <span className="text-sm text-muted-foreground">
                                            Move{' '}
                                            {Math.floor(
                                                moment.decisionPly / 2
                                            ) + 1}
                                        </span>
                                    </div>
                                    <div className="mt-3">
                                        <Button
                                            asChild
                                            variant="outline"
                                            size="sm"
                                        >
                                            <Link
                                                href={`/training?momentId=${encodeURIComponent(moment.id)}`}
                                            >
                                                Train
                                            </Link>
                                        </Button>
                                    </div>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
