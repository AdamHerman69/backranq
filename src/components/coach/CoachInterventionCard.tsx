'use client';

import { Brain, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {
    formatEngineScoreForWhite,
    formatEngineWdlForWhite,
} from '@/lib/analysis/evaluation';
import {
    coachInterventionLabel,
    firstEvaluation,
    formatCoachImpact,
} from '@/lib/coach';
import type { CoachMistake } from '@/lib/coach/types';

type CoachInterventionCardProps = {
    mistake: CoachMistake;
    thresholdCp: number;
    onAnalyze: () => void;
    onContinue: () => void;
    onRetry: () => void;
};

export function CoachInterventionCard({
    mistake,
    thresholdCp,
    onAnalyze,
    onContinue,
    onRetry,
}: CoachInterventionCardProps) {
    const before = firstEvaluation(mistake.beforeAnalysis);

    return (
        <Card
            className="border-red-500/35"
            role="region"
            aria-label="Coach intervention"
        >
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                        Evaluation threshold crossed
                    </CardTitle>
                    <Badge variant="destructive">
                        {coachInterventionLabel(
                            mistake.assessment.severity
                        )}
                    </Badge>
                </div>
                <CardDescription>
                    Stockfish confirmed this decision beyond your{' '}
                    {thresholdCp} cp threshold. The opponent has not moved yet.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-lg border bg-muted/25 p-3 text-center">
                    <div>
                        <div className="text-xs text-muted-foreground">
                            Before {mistake.moveSan}
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold">
                            {formatEngineScoreForWhite(
                                before.score,
                                mistake.decisionFen
                            )}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                            {formatEngineWdlForWhite(
                                before.wdl,
                                mistake.decisionFen
                            ) ?? 'WDL unavailable'}
                        </div>
                    </div>
                    <span
                        className="text-muted-foreground"
                        aria-hidden="true"
                    >
                        →
                    </span>
                    <div>
                        <div className="text-xs text-muted-foreground">
                            After your move
                        </div>
                        <div className="mt-1 font-mono text-xl font-semibold text-red-700 dark:text-red-300">
                            {formatEngineScoreForWhite(
                                mistake.afterEvaluation.score,
                                mistake.fenAfterMove
                            )}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                            {formatEngineWdlForWhite(
                                mistake.afterEvaluation.wdl,
                                mistake.fenAfterMove
                            ) ?? 'WDL unavailable'}
                        </div>
                    </div>
                </div>
                <p className="text-sm">
                    White evaluation changed from the left value to the right.
                    That cost{' '}
                    <span className="font-medium">
                        {formatCoachImpact(mistake.assessment)}
                    </span>
                    .
                </p>
                <p className="text-xs text-muted-foreground">
                    W/D/L is Stockfish’s White-outcome model. Expected score is
                    W + ½D. The stop itself is based only on the confirmed
                    centipawn loss.
                </p>
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
                    <Button type="button" onClick={onRetry}>
                        <RotateCcw
                            className="mr-2 h-4 w-4"
                            aria-hidden="true"
                        />
                        Try again
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={onAnalyze}
                    >
                        <Brain
                            className="mr-2 h-4 w-4"
                            aria-hidden="true"
                        />
                        Analyze
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onContinue}
                    >
                        Continue
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
