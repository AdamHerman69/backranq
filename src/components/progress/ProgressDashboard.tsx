import { ArrowRight, CircleAlert, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/app/PageHeader';
import {
    ProgressViewTracker,
    TrackedProgressLink,
    type ProgressAnalyticsContext,
} from '@/components/progress/ProgressAnalytics';
import {
    breakdownLabel,
    confidenceLabel,
    deriveProgressNextAction,
    formatProgressRate,
    formatTrend,
    positionActionLabel,
    practiceHref,
    sampleStateLabel,
    sortBreakdownRows,
} from '@/components/progress/model';
import { ProgressScopeForm } from '@/components/progress/ProgressScopeForm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import type {
    ProgressBreakdownRow,
    ProgressPositionAction,
    ProgressRate,
    ProgressSnapshot,
} from '@/lib/progress/contracts';

function number(value: number) {
    return value.toLocaleString();
}

function generatedAtLabel(value: string) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(date);
}

function RateMeter({ rate, label }: { rate: ProgressRate; label: string }) {
    if (rate.rate == null) return null;
    const percent = Math.round(rate.rate * 100);
    return (
        <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${formatProgressRate(rate)}. ${sampleStateLabel(
                rate.sampleState
            )}.`}
        >
            <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${percent}%` }}
            />
        </div>
    );
}

function RateCard({
    label,
    description,
    rate,
}: {
    label: string;
    description: string;
    rate: ProgressRate;
}) {
    const confidence = confidenceLabel(rate);
    return (
        <Card className="shadow-none">
            <CardHeader className="pb-3">
                <CardTitle className="text-base">{label}</CardTitle>
                <CardDescription>{description}</CardDescription>
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-semibold tabular-nums">
                    {formatProgressRate(rate)}
                </div>
                <RateMeter rate={rate} label={label} />
                <p className="mt-3 text-xs text-muted-foreground">
                    {sampleStateLabel(rate.sampleState)}
                    {confidence ? ` · ${confidence}` : ''}
                </p>
            </CardContent>
        </Card>
    );
}

function SectionHeading({
    id,
    title,
    description,
}: {
    id: string;
    title: string;
    description: string;
}) {
    return (
        <div className="space-y-1">
            <h2 id={id} className="text-xl font-semibold tracking-tight">
                {title}
            </h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
                {description}
            </p>
        </div>
    );
}

function EmptySection({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <Card className="shadow-none">
            <CardContent className="py-6">
                <div className="font-medium">{title}</div>
                <p className="mt-1 text-sm text-muted-foreground">
                    {description}
                </p>
            </CardContent>
        </Card>
    );
}

function coverageNotices(snapshot: ProgressSnapshot) {
    const states = snapshot.coverage.analysisStates;
    const notices: string[] = [];
    if (
        snapshot.availability.providers.filter(
            (option) => option.sourceGames > 0
        ).length > 1 &&
        snapshot.filters.providers.length === 0
    ) {
        notices.push(
            'This view combines multiple game sources. Use Source filters before comparing one source.'
        );
    }
    if (states.stale > 0) {
        notices.push(
            `${number(states.stale)} stale ${
                states.stale === 1 ? 'game is' : 'games are'
            } excluded from current analysis coverage.`
        );
    }
    if (states.running > 0 || states.queued > 0) {
        notices.push(
            `${number(states.running)} analyzing and ${number(
                states.queued
            )} queued. Results can change as those games finish.`
        );
    }
    if (states.waiting > 0) {
        notices.push(
            `${number(states.waiting)} ${
                states.waiting === 1 ? 'game is' : 'games are'
            } waiting${
                snapshot.operational.waitingForCredits > 0
                    ? ' for server credits'
                    : ' for analysis'
            }. Imported games remain safe.`
        );
    }
    if (states.failed > 0) {
        notices.push(
            `${number(states.failed)} ${
                states.failed === 1 ? 'analysis failed' : 'analyses failed'
            } and are not treated as completed data.`
        );
    }
    if (
        snapshot.coverage.analyzedRate.n > 0 &&
        snapshot.coverage.analyzedRate.x <
            snapshot.coverage.analyzedRate.n
    ) {
        notices.push(
            `Coverage is partial: ${formatProgressRate(
                snapshot.coverage.analyzedRate
            )} source games currently have valid analysis.`
        );
    }
    return notices;
}

function CoverageStrip({ snapshot }: { snapshot: ProgressSnapshot }) {
    const notices = coverageNotices(snapshot);
    return (
        <Card
            role="region"
            aria-labelledby="progress-coverage-title"
            className="shadow-none"
        >
            <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <CardTitle
                            id="progress-coverage-title"
                            className="flex items-center gap-2 text-base"
                        >
                            <ShieldCheck
                                className="h-4 w-4"
                                aria-hidden="true"
                            />
                            Data coverage
                        </CardTitle>
                        <CardDescription className="mt-1">
                            What this Progress view can honestly support.
                        </CardDescription>
                    </div>
                    <Badge variant="outline">
                        Updated {generatedAtLabel(snapshot.generatedAt)}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className="space-y-4">
                <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <div className="rounded-lg bg-muted/50 p-3">
                        <dt className="text-xs text-muted-foreground">
                            Source games
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">
                            {number(snapshot.coverage.analyzedRate.n)}
                        </dd>
                    </div>
                    <div className="rounded-lg bg-muted/50 p-3">
                        <dt className="text-xs text-muted-foreground">
                            Current analysis
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">
                            {snapshot.coverage.analyzedRate.x} of{' '}
                            {snapshot.coverage.analyzedRate.n}
                        </dd>
                    </div>
                    <div className="rounded-lg bg-muted/50 p-3">
                        <dt className="text-xs text-muted-foreground">
                            Eligible Positions
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">
                            {number(snapshot.coverage.eligiblePositions)}
                        </dd>
                    </div>
                    <div className="rounded-lg bg-muted/50 p-3">
                        <dt className="text-xs text-muted-foreground">
                            Positions with assessed outcome
                        </dt>
                        <dd className="mt-1 text-xl font-semibold tabular-nums">
                            {number(
                                snapshot.firstRecordedTerminalOutcome.positions
                            )}
                        </dd>
                    </div>
                </dl>

                {snapshot.coverage.analyzedRate.n === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No source games fall in the selected game-time view.
                        Practice evidence can still appear below when attempts
                        on older Positions finished in this window.
                    </p>
                ) : notices.length > 0 ? (
                    <ul className="space-y-2" aria-label="Coverage limitations">
                        {notices.map((notice) => (
                            <li
                                key={notice}
                                className="flex items-start gap-2 text-sm text-muted-foreground"
                            >
                                <CircleAlert
                                    className="mt-0.5 h-4 w-4 shrink-0"
                                    aria-hidden="true"
                                />
                                <span>{notice}</span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        All source games in this view have current, succeeded
                        analysis.
                    </p>
                )}

                <p className="border-t pt-3 text-xs text-muted-foreground">
                    Source-game metrics use game played time. Practice metrics
                    use terminal attempt time. Pending, skipped and unresolved
                    attempts are not counted as wrong.
                </p>
            </CardContent>
        </Card>
    );
}

function NextAction({ snapshot }: { snapshot: ProgressSnapshot }) {
    const action = deriveProgressNextAction(snapshot);
    const analyticsContext = progressAnalyticsContext(snapshot);
    return (
        <Card className="border-primary/30">
            <CardContent className="flex flex-col gap-4 py-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="max-w-2xl">
                    <div className="font-semibold">{action.title}</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {action.description}
                    </p>
                </div>
                <Button asChild className="min-h-11 shrink-0">
                    <TrackedProgressLink
                        href={action.href}
                        analyticsContext={analyticsContext}
                        actionKey="primary-next-action"
                        recommendationKey={action.recommendationKey}
                    >
                        {action.label}
                        <ArrowRight aria-hidden="true" />
                    </TrackedProgressLink>
                </Button>
            </CardContent>
        </Card>
    );
}

function DistributionRows({
    rows,
    denominator,
}: {
    rows: { key: string; label: string; value: number }[];
    denominator: number;
}) {
    return (
        <ul className="space-y-3">
            {rows.map((row) => {
                const rate =
                    denominator > 0 ? row.value / denominator : null;
                return (
                    <li key={row.key}>
                        <div className="flex items-baseline justify-between gap-4 text-sm">
                            <span className="font-medium">{row.label}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                                {number(row.value)} of {number(denominator)}
                            </span>
                        </div>
                        {rate == null ? null : (
                            <div
                                className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
                                role="meter"
                                aria-label={`${row.label}: ${row.value} of ${denominator}`}
                                aria-valuemin={0}
                                aria-valuemax={denominator}
                                aria-valuenow={row.value}
                            >
                                <div
                                    className="h-full rounded-full bg-primary"
                                    style={{
                                        width: `${Math.round(rate * 100)}%`,
                                    }}
                                />
                            </div>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

function FromGames({ snapshot }: { snapshot: ProgressSnapshot }) {
    const positionCount = snapshot.coverage.eligiblePositions;
    const impactRows = [
        {
            key: 'major',
            label: 'Major impact',
            value:
                snapshot.impact.winningChance.major +
                snapshot.impact.centipawnFallback.major,
        },
        {
            key: 'meaningful',
            label: 'Meaningful impact',
            value:
                snapshot.impact.winningChance.meaningful +
                snapshot.impact.centipawnFallback.meaningful,
        },
        {
            key: 'low',
            label: 'Lower impact',
            value:
                snapshot.impact.winningChance.low +
                snapshot.impact.centipawnFallback.low,
        },
        {
            key: 'unknown',
            label: 'Impact unavailable',
            value: snapshot.impact.unknown,
        },
    ];

    return (
        <section className="space-y-4" aria-labelledby="from-games-title">
            <SectionHeading
                id="from-games-title"
                title="From your games"
                description="Where current analysis found eligible personal decisions. These are library observations, not a score."
            />
            {positionCount === 0 ? (
                <EmptySection
                    title="No eligible Positions in this view"
                    description="Games may still need analysis, may be stale, or may not match your current Position settings."
                />
            ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                    <Card className="shadow-none">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">
                                Position coverage
                            </CardTitle>
                            <CardDescription>
                                {number(positionCount)} Positions across{' '}
                                {number(
                                    snapshot.coverage
                                        .positionsPerAnalyzedGame.analyzedGames
                                )}{' '}
                                analyzed games.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <dl className="grid grid-cols-2 gap-3">
                                <div>
                                    <dt className="text-xs text-muted-foreground">
                                        Games with a Position
                                    </dt>
                                    <dd className="mt-1 font-semibold tabular-nums">
                                        {formatProgressRate(
                                            snapshot.coverage
                                                .gamesWithEligiblePosition
                                        )}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-xs text-muted-foreground">
                                        Positions per analyzed game
                                    </dt>
                                    <dd className="mt-1 font-semibold tabular-nums">
                                        {snapshot.coverage
                                            .positionsPerAnalyzedGame.average ==
                                        null
                                            ? 'Not available'
                                            : snapshot.coverage.positionsPerAnalyzedGame.average.toFixed(
                                                  1
                                              )}
                                    </dd>
                                </div>
                            </dl>
                        </CardContent>
                    </Card>
                    <Card className="shadow-none">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base">
                                Decision impact
                            </CardTitle>
                            <CardDescription>
                                Winning-chance impact is primary; centipawns are
                                used only when winning chance is unavailable.
                            </CardDescription>
                        </CardHeader>
                        <CardContent>
                            <DistributionRows
                                rows={impactRows}
                                denominator={positionCount}
                            />
                        </CardContent>
                    </Card>
                </div>
            )}
        </section>
    );
}

function FirstRecordedOutcome({
    snapshot,
}: {
    snapshot: ProgressSnapshot;
}) {
    const outcome = snapshot.firstRecordedTerminalOutcome;
    if (outcome.positions === 0) return null;
    const metObjective =
        outcome.gradeCounts.BEST +
        outcome.gradeCounts.STRONG +
        outcome.gradeCounts.GOOD;
    const counts = [
        {
            label: 'Met objective',
            value: metObjective,
            detail: 'Best, Strong, or Good',
        },
        {
            label: 'Improved',
            value: outcome.gradeCounts.IMPROVED,
            detail: 'Better, not yet solved',
        },
        {
            label: 'Original move repeated',
            value: outcome.gradeCounts.REPEATED_MISTAKE,
            detail: 'Same source-game move',
        },
        {
            label: 'Different mistake',
            value: outcome.gradeCounts.DIFFERENT_MISTAKE,
            detail: 'Original issue avoided',
        },
        {
            label: 'Revealed',
            value: outcome.revealed,
            detail: 'Not counted as solved',
        },
    ];
    return (
        <Card className="shadow-none">
            <CardHeader className="pb-3">
                <CardTitle className="text-base">
                    First recorded outcome
                </CardTitle>
                <CardDescription>
                    One mutually exclusive outcome per attempted Position. This
                    view is less influenced by repeating the same Position many
                    times.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <div>
                    <div className="text-2xl font-semibold tabular-nums">
                        {formatProgressRate(outcome.metObjective)}
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                        met the Practice objective on the first recorded
                        terminal outcome
                    </p>
                    <RateMeter
                        rate={outcome.metObjective}
                        label="First recorded outcomes that met the objective"
                    />
                    <p className="mt-3 text-xs text-muted-foreground">
                        {sampleStateLabel(
                            outcome.metObjective.sampleState
                        )}
                        {confidenceLabel(outcome.metObjective)
                            ? ` · ${confidenceLabel(outcome.metObjective)}`
                            : ''}
                    </p>
                </div>
                <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                    {counts.map((item) => (
                        <div
                            key={item.label}
                            className="rounded-lg bg-muted/50 p-3"
                        >
                            <dt className="text-xs text-muted-foreground">
                                {item.label}
                            </dt>
                            <dd className="mt-1 text-lg font-semibold tabular-nums">
                                {number(item.value)}
                            </dd>
                            <div className="mt-1 text-xs text-muted-foreground">
                                {item.detail}
                            </div>
                        </div>
                    ))}
                </dl>
            </CardContent>
        </Card>
    );
}

function InPractice({ snapshot }: { snapshot: ProgressSnapshot }) {
    const assessableAttempts =
        snapshot.practice.gradedAttempts +
        snapshot.practice.revealedAttempts;
    const terminalAttempts =
        assessableAttempts +
        snapshot.practice.unresolvedExcluded;
    return (
        <section className="space-y-4" aria-labelledby="in-practice-title">
            <SectionHeading
                id="in-practice-title"
                title="In Practice"
                description="How completed attempts went. Reveals and unresolved attempts are shown separately rather than treated as wrong."
            />
            {terminalAttempts === 0 ? (
                <EmptySection
                    title="No completed attempts yet"
                    description="Start a mixed Practice feed. The first useful signal appears as counts; percentages wait for at least 10 observations."
                />
            ) : (
                <>
                    <Card className="shadow-none">
                        <CardContent className="py-4">
                            <dl className="grid grid-cols-3 gap-3 text-sm">
                                <div>
                                    <dt className="text-muted-foreground">
                                        Graded
                                    </dt>
                                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                                        {number(
                                            snapshot.practice
                                                .gradedAttempts
                                        )}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-muted-foreground">
                                        Revealed
                                    </dt>
                                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                                        {number(
                                            snapshot.practice
                                                .revealedAttempts
                                        )}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="text-muted-foreground">
                                        Unresolved
                                    </dt>
                                    <dd className="mt-1 text-lg font-semibold tabular-nums">
                                        {number(
                                            snapshot.practice
                                                .unresolvedExcluded
                                        )}
                                    </dd>
                                </div>
                            </dl>
                        </CardContent>
                    </Card>
                    {assessableAttempts === 0 ? (
                        <EmptySection
                            title="No assessable outcomes yet"
                            description="Completed attempts are unresolved, so Backranq does not infer success or failure from them."
                        />
                    ) : (
                        <>
                            <FirstRecordedOutcome
                                snapshot={snapshot}
                            />
                            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                                <RateCard
                                    label="Full Position solved"
                                    description="Every required user decision in the Position met its objective."
                                    rate={
                                        snapshot.practice
                                            .fullPositionSolve
                                    }
                                />
                                <RateCard
                                    label="Root decision met"
                                    description="The first decision was Best or Good, including accepted alternatives."
                                    rate={
                                        snapshot.practice
                                            .rootDecisionSuccess
                                    }
                                />
                                <RateCard
                                    label="Original move repeated"
                                    description="The exact move from the source game was repeated. Lower is better; this is not every wrong move."
                                    rate={
                                        snapshot.practice
                                            .exactOriginalMoveRepeated
                                    }
                                />
                            </div>
                            <Card className="shadow-none">
                                <CardContent className="py-4 text-sm">
                                    <div className="font-medium">
                                        Compared with the previous
                                        period
                                    </div>
                                    <p className="mt-1 text-muted-foreground">
                                        {formatTrend(
                                            snapshot.practice
                                                .fullPositionSolveTrend
                                        )}
                                    </p>
                                </CardContent>
                            </Card>
                        </>
                    )}
                </>
            )}
        </section>
    );
}

function ReviewActionList({
    title,
    actions,
    analyticsContext,
}: {
    title: string;
    actions: ProgressPositionAction[];
    analyticsContext: ProgressAnalyticsContext;
}) {
    if (actions.length === 0) return null;
    return (
        <div>
            <h3 className="text-sm font-semibold">{title}</h3>
            <ul className="mt-2 divide-y rounded-lg border">
                {actions.slice(0, 5).map((action) => (
                    <li
                        key={`${title}:${action.positionId}`}
                        className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">
                                Previously attempted Position
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                                {positionActionLabel(action)} · reviewed{' '}
                                {action.daysSinceLatestTerminal === 0
                                    ? 'today'
                                    : `${action.daysSinceLatestTerminal} days ago`}
                            </p>
                        </div>
                        <Button
                            asChild
                            size="sm"
                            variant="outline"
                            className="min-h-11 shrink-0"
                        >
                            <TrackedProgressLink
                                href={practiceHref(action.positionId)}
                                analyticsContext={analyticsContext}
                                actionKey="practice-position"
                                recommendationKey="review-position"
                            >
                                Review Position
                            </TrackedProgressLink>
                        </Button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function ReviewRecurrence({ snapshot }: { snapshot: ProgressSnapshot }) {
    const analyticsContext = progressAnalyticsContext(snapshot);
    const hasAttemptHistory =
        snapshot.firstRecordedTerminalOutcome.positions > 0 ||
        snapshot.practice.gradedAttempts +
            snapshot.practice.revealedAttempts >
            0 ||
        snapshot.inventory.fresh <
            snapshot.inventory.eligiblePositions ||
        snapshot.delayedRecheck.eligibleBaselines > 0;
    const persistentIds = new Set(
        snapshot.actions.persistentOriginalMoveRepetition.map(
            (action) => action.positionId
        )
    );
    const otherNeedsAnotherLook =
        snapshot.actions.needsAnotherLook.filter(
            (action) => !persistentIds.has(action.positionId)
        );
    return (
        <section className="space-y-4" aria-labelledby="review-title">
            <SectionHeading
                id="review-title"
                title="Review and recurrence"
                description="What may deserve another look, and what is known about delayed review. Unobserved rechecks are never counted as failures."
            />
            {!hasAttemptHistory ? (
                <EmptySection
                    title="Review evidence starts after Practice"
                    description="Backranq needs a completed attempt before it can recommend an already-seen Position or observe a later recheck."
                />
            ) : (
                <>
                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        <Card className="shadow-none">
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">
                                    Current inventory
                                </CardTitle>
                                <CardDescription>
                                    Mutually useful next-state counts, not goals
                                    or a session score.
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <dl className="space-y-3 text-sm">
                                    <div className="flex justify-between gap-3">
                                        <dt>Fresh</dt>
                                        <dd className="font-semibold tabular-nums">
                                            {number(snapshot.inventory.fresh)}
                                        </dd>
                                    </div>
                                    <div className="flex justify-between gap-3">
                                        <dt>Needs another look</dt>
                                        <dd className="font-semibold tabular-nums">
                                            {number(
                                                snapshot.inventory
                                                    .needsAnotherLook
                                            )}
                                        </dd>
                                    </div>
                                    <div className="flex justify-between gap-3">
                                        <dt>Original move recurred</dt>
                                        <dd className="font-semibold tabular-nums">
                                            {number(
                                                snapshot.inventory
                                                    .persistentOriginalMoveRepetition
                                            )}
                                        </dd>
                                    </div>
                                </dl>
                            </CardContent>
                        </Card>
                        <RateCard
                            label="Delayed recheck observed"
                            description="Baselines with a first observed recheck 7–30 days later."
                            rate={
                                snapshot.delayedRecheck.observationCoverage
                            }
                        />
                        <RateCard
                            label="Solved on observed recheck"
                            description="Full solves among observed delayed rechecks only."
                            rate={snapshot.delayedRecheck.observedFullSolve}
                        />
                    </div>

                    {snapshot.actions.needsAnotherLook.length === 0 &&
                    snapshot.actions.persistentOriginalMoveRepetition.length ===
                        0 ? (
                        <EmptySection
                            title="You are caught up in this view"
                            description="No already-attempted Position currently meets the review or recurrence criteria."
                        />
                    ) : (
                        <Card className="shadow-none">
                            <CardHeader className="pb-3">
                                <CardTitle className="text-base">
                                    Already-seen Positions
                                </CardTitle>
                                <CardDescription>
                                    These links only open Positions already in
                                    your attempt history. Fresh themes remain
                                    hidden.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-5">
                                <ReviewActionList
                                    title="Needs another look"
                                    actions={otherNeedsAnotherLook}
                                    analyticsContext={analyticsContext}
                                />
                                <ReviewActionList
                                    title="Recurring original move"
                                    actions={
                                        snapshot.actions
                                            .persistentOriginalMoveRepetition
                                    }
                                    analyticsContext={analyticsContext}
                                />
                            </CardContent>
                        </Card>
                    )}
                </>
            )}
        </section>
    );
}

function BreakdownRow({
    row,
    kind,
}: {
    row: ProgressBreakdownRow;
    kind: string;
}) {
    const rate = row.fullPositionSolve;
    return (
        <li className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                <span className="font-medium">
                    {breakdownLabel(kind, row.key)}
                </span>
                <span className="text-sm tabular-nums text-muted-foreground">
                    {formatProgressRate(rate)} full solves
                </span>
            </div>
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3 sm:gap-3">
                <div>
                    <dt>Positions from games played in scope</dt>
                    <dd className="font-medium tabular-nums text-foreground">
                        {number(row.positions)}
                    </dd>
                </div>
                <div>
                    <dt>Source games played in scope</dt>
                    <dd className="font-medium tabular-nums text-foreground">
                        {number(row.sourceGames)}
                    </dd>
                </div>
                <div>
                    <dt>Graded attempts completed in scope</dt>
                    <dd className="font-medium tabular-nums text-foreground">
                        {number(row.gradedAttempts)}
                    </dd>
                </div>
            </dl>
            <RateMeter
                rate={rate}
                label={`${breakdownLabel(kind, row.key)} full Position solves`}
            />
        </li>
    );
}

function BreakdownCard({
    title,
    kind,
    rows,
    disclosure,
}: {
    title: string;
    kind: string;
    rows: ProgressBreakdownRow[];
    disclosure?: string;
}) {
    const visibleRows = sortBreakdownRows(rows);
    return (
        <Card className="shadow-none">
            <CardHeader className="pb-3">
                <CardTitle className="text-base">{title}</CardTitle>
                {disclosure ? (
                    <CardDescription>{disclosure}</CardDescription>
                ) : null}
            </CardHeader>
            <CardContent>
                {visibleRows.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                        No observations in this view.
                    </p>
                ) : (
                    <ul className="divide-y">
                        {visibleRows.map((row) => (
                            <BreakdownRow
                                key={`${kind}:${row.key}`}
                                row={row}
                                kind={kind}
                            />
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function Breakdowns({ snapshot }: { snapshot: ProgressSnapshot }) {
    return (
        <section className="space-y-4" aria-labelledby="breakdowns-title">
            <SectionHeading
                id="breakdowns-title"
                title="Breakdowns"
                description="Compare like with like. Every row keeps its own denominator and small-sample warning."
            />
            <Card role="note" className="shadow-none">
                <CardContent className="py-4">
                    <dl className="grid gap-3 text-sm sm:grid-cols-2">
                        <div>
                            <dt className="font-medium">
                                Position and source-game counts
                            </dt>
                            <dd className="mt-1 text-muted-foreground">
                                Count current-library Positions from source
                                games played in the selected scope.
                            </dd>
                        </div>
                        <div>
                            <dt className="font-medium">
                                Practice attempt counts
                            </dt>
                            <dd className="mt-1 text-muted-foreground">
                                Count terminal attempts completed in the
                                selected scope, using context frozen when each
                                attempt was recorded.
                            </dd>
                        </div>
                    </dl>
                </CardContent>
            </Card>
            <div className="grid gap-4 xl:grid-cols-2">
                <BreakdownCard
                    title="Game phase"
                    kind="phase"
                    rows={snapshot.breakdowns.phase}
                />
                <BreakdownCard
                    title="Decision impact"
                    kind="impact"
                    rows={snapshot.breakdowns.impact}
                    disclosure="Winning-chance impact is primary. Centipawn fallback is labeled separately when winning chance was unavailable."
                />
                <BreakdownCard
                    title="Game source"
                    kind="provider"
                    rows={snapshot.breakdowns.provider}
                />
                <BreakdownCard
                    title="Time control"
                    kind="timeClass"
                    rows={snapshot.breakdowns.timeClass}
                />
                <BreakdownCard
                    title="Decision source"
                    kind="source"
                    rows={snapshot.breakdowns.source}
                    disclosure="A Position can have more than one source label. These rows overlap and must not be added together."
                />
            </div>
        </section>
    );
}

function progressAnalyticsContext(
    snapshot: ProgressSnapshot
): ProgressAnalyticsContext {
    return {
        ...(snapshot.window.scope === 'all'
            ? {}
            : { windowDays: snapshot.window.scope }),
        ...(snapshot.filters.providers.length === 1
            ? { provider: snapshot.filters.providers[0] }
            : {}),
        ...(snapshot.filters.timeClasses.length === 1
            ? { timeClass: snapshot.filters.timeClasses[0] }
            : {}),
    };
}

export function ProgressDashboard({
    snapshot,
}: {
    snapshot: ProgressSnapshot;
}) {
    const analyticsContext = progressAnalyticsContext(snapshot);
    return (
        <div className="space-y-8">
            <ProgressViewTracker context={analyticsContext} />
            <PageHeader
                title="Progress"
                subtitle="Understand which decisions are changing and choose the next useful action."
            />

            <ProgressScopeForm
                scope={snapshot.window.scope}
                filters={snapshot.filters}
                availability={snapshot.availability}
            />

            <CoverageStrip snapshot={snapshot} />
            <NextAction snapshot={snapshot} />
            <FromGames snapshot={snapshot} />
            <InPractice snapshot={snapshot} />
            <ReviewRecurrence snapshot={snapshot} />
            <Breakdowns snapshot={snapshot} />
        </div>
    );
}
