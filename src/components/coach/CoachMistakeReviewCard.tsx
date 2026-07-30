import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { uciLineToSan } from '@/lib/chess/utils';
import {
    coachInterventionLabel,
    formatCoachImpact,
} from '@/lib/coach';
import type { CoachMistake } from '@/lib/coach/types';

export function CoachMistakeReviewCard({
    mistake,
    onRetry,
    onContinue,
}: {
    mistake: CoachMistake;
    onRetry: () => void;
    onContinue: () => void;
}) {
    const continuation = uciLineToSan(
        mistake.decisionFen,
        mistake.bestLineUci,
        8
    );
    const bestMove =
        continuation[0] ??
        mistake.bestMoveUci.toLowerCase() ??
        '—';

    return (
        <Card role="region" aria-label="Coach mistake review">
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base">Coach review</CardTitle>
                    <Badge variant="destructive">
                        {coachInterventionLabel(
                            mistake.assessment.severity
                        )}
                    </Badge>
                </div>
                <CardDescription>
                    Inspect the confirmed engine evidence and strongest
                    continuation from the decision position.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
                <dl className="grid gap-3 sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Your move</dt>
                        <dd className="mt-1 font-medium">
                            {mistake.moveSan}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Better first move
                        </dt>
                        <dd className="mt-1 font-medium">{bestMove}</dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Impact</dt>
                        <dd className="mt-1 font-medium">
                            {formatCoachImpact(mistake.assessment)}
                        </dd>
                    </div>
                </dl>
                {continuation.length > 0 ? (
                    <div className="rounded-lg border bg-muted/30 p-3">
                        <div className="text-xs text-muted-foreground">
                            Best continuation
                        </div>
                        <p className="mt-1 font-mono font-medium">
                            {continuation.join(' ')}
                        </p>
                    </div>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                    <Button type="button" onClick={onRetry}>
                        Try the position again
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={onContinue}
                    >
                        Keep move and continue
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
