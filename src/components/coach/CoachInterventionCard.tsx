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
import { cn } from '@/lib/utils';

type CoachInterventionCardProps = {
    mistake: CoachMistake;
    thresholdCp: number;
    onAnalyze: () => void;
    onContinue: () => void;
    onRetry: () => void;
    className?: string;
    showActions?: boolean;
};

export function CoachInterventionCard({
    mistake,
    thresholdCp,
    onAnalyze,
    onContinue,
    onRetry,
    className,
    showActions = true,
}: CoachInterventionCardProps) {
    const before = firstEvaluation(mistake.beforeAnalysis);

    return (
        <Card
            className={cn(
                'overflow-hidden border-red-500/35 bg-gradient-to-br from-red-500/[0.07] via-background to-background shadow-lg shadow-red-950/[0.04]',
                className
            )}
            role="region"
            aria-label="Coach intervention"
        >
            <CardHeader className="border-b border-red-500/15 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">
                        Coach paused here
                    </CardTitle>
                    <Badge variant="destructive">
                        {coachInterventionLabel(
                            mistake.assessment.severity
                        )}
                    </Badge>
                </div>
                <CardDescription>
                    Your opponent has not moved. Choose whether to retry this
                    decision, inspect it, or keep playing.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
                <p className="text-sm leading-6">
                    <span className="font-medium">{mistake.moveSan}</span>{' '}
                    crossed your {thresholdCp} cp coaching threshold and cost{' '}
                    <span className="font-medium">
                        {formatCoachImpact(mistake.assessment)}
                    </span>
                    .
                </p>
                {showActions ? (
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
                ) : null}
                <details className="group rounded-lg border bg-background/70">
                    <summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                        <span className="flex items-center justify-between gap-2">
                            Engine evidence
                            <span
                                className="text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                                aria-hidden="true"
                            >
                                ↓
                            </span>
                        </span>
                    </summary>
                    <div className="space-y-3 border-t p-3">
                        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 text-center">
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
                        <p className="text-xs text-muted-foreground">
                            W/D/L is Stockfish’s White-outcome model. The pause
                            itself is based only on the confirmed centipawn loss.
                        </p>
                    </div>
                </details>
            </CardContent>
        </Card>
    );
}
