'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import {
    AlertCircle,
    ArrowRight,
    CheckCircle2,
    Clock3,
    LineChart,
    RefreshCw,
    Shuffle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/loading-patterns';
import { SyncGamesWidget } from '@/components/sync/SyncGamesWidget';
import {
    automationBlockAction,
    humanizeAutomationBlockReason,
    isCreditOrCapBlockReason,
} from '@/components/sync/syncClient';
import {
    ANALYSIS_COMPLETION_EVENT,
    LIBRARY_CHANGED_EVENT,
    readLastAnalysisCompletion,
    type AnalysisCompletionSummary,
} from '@/lib/analysis/analysisCompletion';
import {
    backgroundAnalysis,
    type BackgroundAnalysisSnapshot,
} from '@/lib/analysis/backgroundAnalysisManager';
import { getSyncStatus, type SyncStatus } from '@/lib/services/gameSync';
import {
    deriveHomeProductState,
    type HomeProductState,
} from '@/lib/product/homeState';

type HomeSyncStatus = SyncStatus & {
    automation?: {
        policy?: {
            enabled: boolean;
        };
        backlog?: {
            waitingForCredits: number;
            blockedReason: string | null;
            queued: number;
            running: number;
            terminalFailed: number;
        };
        capacity?: {
            blockingReason: string | null;
        };
    };
};

export function HomeDashboard() {
    const { data: session, status: sessionStatus } = useSession();
    const ownerId = session?.user?.id ?? null;
    const isLoading = sessionStatus === 'loading';

    const [dashboard, setDashboard] = useState<{
        ownerId: string | null;
        status: 'idle' | 'loading' | 'ready' | 'error';
        trainingMomentCount: number;
        trainingMomentCountIsExact: boolean;
        duePracticeCount: number;
        duePracticeCountIsExact: boolean;
        gameCount: number;
        unanalyzedGameCount: number;
        syncStatus: SyncStatus | null;
        error: string | null;
    }>({
        ownerId: null,
        status: 'idle',
        trainingMomentCount: 0,
        trainingMomentCountIsExact: true,
        duePracticeCount: 0,
        duePracticeCountIsExact: true,
        gameCount: 0,
        unanalyzedGameCount: 0,
        syncStatus: null,
        error: null,
    });
    const [analysisSnapshot, setAnalysisSnapshot] =
        useState<BackgroundAnalysisSnapshot>(() => backgroundAnalysis.snapshot());
    const [lastCompletion, setLastCompletion] =
        useState<AnalysisCompletionSummary | null>(null);
    const dashboardRequestId = useRef(0);

    const fetchDashboard = useCallback(async () => {
        if (!ownerId) return;
        const requestId = ++dashboardRequestId.current;
        setDashboard((current) => ({
            ...current,
            ownerId,
            status: current.status === 'ready' ? 'ready' : 'loading',
            error: null,
        }));
        try {
            const [practiceRes, gameRes, unanalyzedRes, syncStatus] =
                await Promise.all([
                    fetch('/api/training/due', {
                        cache: 'no-store',
                    }),
                    fetch('/api/games?limit=1', { cache: 'no-store' }),
                    fetch('/api/games?hasAnalysis=false&limit=1', {
                        cache: 'no-store',
                    }),
                    // Sync/provider health must never suppress core Home data.
                    // Its own compact status UI remains independently retryable.
                    getSyncStatus().catch(() => null),
                ]);
            if (!practiceRes.ok || !gameRes.ok || !unanalyzedRes.ok) {
                throw new Error('Could not load your practice overview.');
            }
            const [practiceJson, gameJson, unanalyzedJson] =
                (await Promise.all([
                    practiceRes.json(),
                    gameRes.json(),
                    unanalyzedRes.json(),
                ])) as [
                    {
                        availableCount?: number;
                        availableCountIsExact?: boolean;
                        dueCount?: number;
                        dueCountIsExact?: boolean;
                    },
                    { total?: number },
                    { total?: number },
                ];
            if (requestId !== dashboardRequestId.current) return;
            setDashboard({
                ownerId,
                status: 'ready',
                trainingMomentCount:
                    typeof practiceJson.availableCount === 'number'
                        ? practiceJson.availableCount
                        : 0,
                trainingMomentCountIsExact:
                    practiceJson.availableCountIsExact !== false,
                duePracticeCount:
                    typeof practiceJson.dueCount === 'number'
                        ? practiceJson.dueCount
                        : 0,
                duePracticeCountIsExact:
                    practiceJson.dueCountIsExact !== false,
                gameCount:
                    typeof gameJson.total === 'number' ? gameJson.total : 0,
                unanalyzedGameCount:
                    typeof unanalyzedJson.total === 'number'
                        ? unanalyzedJson.total
                        : 0,
                syncStatus,
                error: null,
            });
        } catch (error) {
            if (requestId !== dashboardRequestId.current) return;
            setDashboard((current) => ({
                ...current,
                ownerId,
                status: 'error',
                error:
                    error instanceof Error
                        ? error.message
                        : 'Could not load your practice overview.',
            }));
        }
    }, [ownerId]);

    useEffect(() => {
        backgroundAnalysis.setOwner(ownerId);
        dashboardRequestId.current += 1;
        setDashboard({
            ownerId,
            status: 'idle',
            trainingMomentCount: 0,
            trainingMomentCountIsExact: true,
            duePracticeCount: 0,
            duePracticeCountIsExact: true,
            gameCount: 0,
            unanalyzedGameCount: 0,
            syncStatus: null,
            error: null,
        });
        setLastCompletion(
            ownerId ? readLastAnalysisCompletion(ownerId) : null
        );
        setAnalysisSnapshot(backgroundAnalysis.snapshot());
        if (!ownerId) return;
        const unsubscribe = backgroundAnalysis.subscribe((next) => {
            if (next.ownerId === ownerId) setAnalysisSnapshot(next);
        });
        void fetchDashboard();
        const onCompletion = (event: Event) => {
            const summary = (
                event as CustomEvent<AnalysisCompletionSummary>
            ).detail;
            if (summary?.ownerId === ownerId) setLastCompletion(summary);
        };
        const refresh = (event: Event) => {
            const eventOwner = (
                event as CustomEvent<{
                    ownerId?: string;
                    invalidateCompletion?: boolean;
                }>
            ).detail?.ownerId;
            const invalidateCompletion = (
                event as CustomEvent<{
                    ownerId?: string;
                    invalidateCompletion?: boolean;
                }>
            ).detail?.invalidateCompletion;
            if (
                invalidateCompletion &&
                (!eventOwner || eventOwner === ownerId)
            ) {
                setLastCompletion(null);
            }
            if (!eventOwner || eventOwner === ownerId) void fetchDashboard();
        };
        window.addEventListener(ANALYSIS_COMPLETION_EVENT, onCompletion);
        window.addEventListener(LIBRARY_CHANGED_EVENT, refresh);
        window.addEventListener('focus', refresh);
        return () => {
            dashboardRequestId.current += 1;
            unsubscribe();
            window.removeEventListener(
                ANALYSIS_COMPLETION_EVENT,
                onCompletion
            );
            window.removeEventListener(LIBRARY_CHANGED_EVENT, refresh);
            window.removeEventListener('focus', refresh);
        };
    }, [fetchDashboard, ownerId]);

    const dashboardMatchesOwner = dashboard.ownerId === ownerId;
    const dashboardStatus = dashboardMatchesOwner
        ? dashboard.status
        : 'idle';
    const trainingMomentCount = dashboardMatchesOwner
        ? dashboard.trainingMomentCount
        : 0;
    const gameCount = dashboardMatchesOwner ? dashboard.gameCount : 0;
    const duePracticeCount = dashboardMatchesOwner
        ? dashboard.duePracticeCount
        : 0;
    const trainingMomentCountIsExact = dashboardMatchesOwner
        ? dashboard.trainingMomentCountIsExact
        : true;
    const duePracticeCountIsExact = dashboardMatchesOwner
        ? dashboard.duePracticeCountIsExact
        : true;
    const unanalyzedGameCount = dashboardMatchesOwner
        ? dashboard.unanalyzedGameCount
        : 0;
    const dashboardSyncStatus = dashboardMatchesOwner
        ? dashboard.syncStatus
        : null;
    const hasTrainingMoments = trainingMomentCount > 0;

    const hasLinkedAccount =
        !!dashboardSyncStatus?.linked.lichessUsername ||
        !!dashboardSyncStatus?.linked.chesscomUsername;
    const automationStatus = (dashboardSyncStatus as HomeSyncStatus | null)
        ?.automation;
    const rawAnalysisBlockedReason =
        automationStatus?.backlog?.blockedReason ??
        automationStatus?.capacity?.blockingReason ??
        null;
    const effectiveAnalysisBlockedReason =
        rawAnalysisBlockedReason ??
        ((!automationStatus || automationStatus.policy?.enabled === true) &&
        unanalyzedGameCount > 0 &&
        dashboardSyncStatus?.billing?.reservableGames === 0
            ? 'credits'
            : null);
    const productState: HomeProductState = deriveHomeProductState({
        loading:
            dashboardStatus === 'idle' || dashboardStatus === 'loading',
        error: dashboardMatchesOwner ? dashboard.error : null,
        linkedAccountKnown: dashboardSyncStatus !== null,
        hasLinkedAccount,
        gameCount,
        unanalyzedGameCount,
        trainingMomentCount,
        browserAnalysisRunning:
            analysisSnapshot.ownerId === ownerId &&
            analysisSnapshot.state === 'running',
        serverQueued:
            automationStatus?.backlog?.queued ??
            dashboardSyncStatus?.analysisJobs?.queued ??
            0,
        serverRunning:
            automationStatus?.backlog?.running ??
            dashboardSyncStatus?.analysisJobs?.running ??
            0,
        serverFailed:
            automationStatus?.backlog?.terminalFailed ??
            dashboardSyncStatus?.analysisJobs?.failed ??
            0,
        analysisBlockedReason:
            isCreditOrCapBlockReason(rawAnalysisBlockedReason)
                ? humanizeAutomationBlockReason(rawAnalysisBlockedReason)
                : (!automationStatus ||
                      automationStatus.policy?.enabled === true) &&
                    unanalyzedGameCount > 0 &&
                    dashboardSyncStatus?.billing?.reservableGames === 0
                  ? dashboardSyncStatus.billing.limitingReason ??
                    'No server credits are currently available.'
                  : null,
        lastCompletion,
    });

    // Loading state
    if (isLoading) {
        return (
            <PageSkeleton
                className="mx-auto max-w-6xl"
                label="Loading your home dashboard"
            />
        );
    }

    return (
        <div className="mx-auto max-w-6xl space-y-5 sm:space-y-7">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                        Your chess, distilled
                    </p>
                    <h1 className="text-3xl font-semibold tracking-[-0.035em] sm:text-4xl">
                        Welcome back{session?.user?.name ? `, ${session.user.name.split(' ')[0]}` : ''}
                    </h1>
                    <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                        {dashboardStatus === 'loading' || dashboardStatus === 'idle'
                            ? 'Loading your practice overview…'
                            : dashboardStatus === 'error'
                              ? 'Your games and positions are still here, but their latest status could not be loaded.'
                            : duePracticeCount > 0
                              ? `${duePracticeCount}${duePracticeCountIsExact ? '' : '+'} practice position${duePracticeCount === 1 && duePracticeCountIsExact ? ' is' : 's are'} due for review.`
                            : hasTrainingMoments
                            ? `${trainingMomentCount}${trainingMomentCountIsExact ? '' : '+'} practice position${trainingMomentCount === 1 && trainingMomentCountIsExact ? ' is' : 's are'} ready from ${gameCount} games.`
                            : !trainingMomentCountIsExact
                              ? 'Practice is still scanning a bounded part of your library. Open Practice to continue safely.'
                            : dashboardSyncStatus === null
                              ? 'Your library is available, but linked-account sync status is temporarily unavailable.'
                            : gameCount > 0
                                ? `You have ${gameCount} games. Analyze them to find personal practice positions.`
                                : 'Sync your first games to get started.'}
                    </p>
                </div>
                <div className="hidden items-center gap-2 sm:flex">
                    <Button variant="ghost" asChild>
                        <Link href="/games">
                            Games
                            <ArrowRight aria-hidden="true" />
                        </Link>
                    </Button>
                </div>
            </div>

            {productState === 'no-games' ? (
                <div className="rounded-lg border px-4 py-3">
                    <SyncGamesWidget
                        context="home"
                        enableAnalyze
                        variant="banner"
                        syncIsPrimary
                    />
                </div>
            ) : null}

            <HomeStateCard
                state={productState}
                gameCount={gameCount}
                unanalyzedGameCount={unanalyzedGameCount}
                trainingMomentCount={trainingMomentCount}
                trainingMomentCountIsExact={trainingMomentCountIsExact}
                duePracticeCount={duePracticeCount}
                duePracticeCountIsExact={duePracticeCountIsExact}
                analysisBlockedReason={effectiveAnalysisBlockedReason}
                error={dashboardMatchesOwner ? dashboard.error : null}
                onRetry={() => void fetchDashboard()}
            />

            {dashboardStatus === 'ready' &&
            productState !== 'no-linked-account' &&
            productState !== 'no-games' ? (
                <HomeSummary
                    gameCount={gameCount}
                    trainingMomentCount={trainingMomentCount}
                    duePracticeCount={duePracticeCount}
                />
            ) : null}

            {productState !== 'no-games' &&
            productState !== 'no-linked-account' ? (
                <div className="rounded-lg border px-4 py-3">
                    <SyncGamesWidget
                        context="home"
                        enableAnalyze
                        variant="banner"
                    />
                </div>
            ) : null}
        </div>
    );
}

function HomeStateCard({
    state,
    gameCount,
    unanalyzedGameCount,
    trainingMomentCount,
    trainingMomentCountIsExact,
    duePracticeCount,
    duePracticeCountIsExact,
    analysisBlockedReason,
    error,
    onRetry,
}: {
    state: HomeProductState;
    gameCount: number;
    unanalyzedGameCount: number;
    trainingMomentCount: number;
    trainingMomentCountIsExact: boolean;
    duePracticeCount: number;
    duePracticeCountIsExact: boolean;
    analysisBlockedReason: string | null;
    error: string | null;
    onRetry: () => void;
}) {
    if (state === 'loading') {
        return (
            <Card variant="subtle" aria-live="polite">
                <CardContent className="flex items-center gap-3 py-8">
                    <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
                    <div>
                        <div className="font-medium">Loading your next step</div>
                        <div className="text-sm text-muted-foreground">
                            Checking games, analysis and practice progress…
                        </div>
                    </div>
                </CardContent>
            </Card>
        );
    }

    if (state === 'error') {
        return (
            <Card aria-live="polite">
                <CardContent className="flex flex-wrap items-center justify-between gap-4 py-6">
                    <div className="flex items-start gap-3">
                        <AlertCircle className="mt-0.5 h-5 w-5 text-destructive" aria-hidden="true" />
                        <div>
                            <div className="font-medium">Overview unavailable</div>
                            <div className="text-sm text-muted-foreground">
                                {error ?? 'We could not load your latest status.'}
                            </div>
                        </div>
                    </div>
                    <Button type="button" variant="outline" onClick={onRetry}>
                        Try again
                    </Button>
                </CardContent>
            </Card>
        );
    }

    if (state === 'no-linked-account') {
        return (
            <NextActionCard
                icon={<AlertCircle className="h-5 w-5" aria-hidden="true" />}
                title="Link a chess account"
                description="Connect Lichess or Chess.com first. Then Backranq can import games without asking for files."
                actionLabel="Open settings"
                href="/settings"
            />
        );
    }

    if (state === 'sync-status-unavailable') {
        return (
            <NextActionCard
                icon={
                    <AlertCircle
                        className="h-5 w-5"
                        aria-hidden="true"
                    />
                }
                title="Game source status unavailable"
                description="We could not check your linked chess accounts. Your existing library is unchanged; retry the source status below."
            />
        );
    }

    if (state === 'no-games') {
        return (
            <NextActionCard
                icon={<Shuffle className="h-5 w-5" aria-hidden="true" />}
                title="Sync your first games"
                description="Your account is linked. Use the Sync now button above to import recent games and find your first positions."
            />
        );
    }

    if (state === 'analysis-in-progress') {
        return (
            <NextActionCard
                icon={<Clock3 className="h-5 w-5" aria-hidden="true" />}
                title="Analysis is in progress"
                description={`${Math.max(0, gameCount - unanalyzedGameCount)} of ${gameCount} games are analyzed. You can leave server analysis running or keep this tab open for browser analysis.`}
                actionLabel={trainingMomentCount > 0 ? 'Practice available positions' : 'View games'}
                href={trainingMomentCount > 0 ? '/practice' : '/games'}
            />
        );
    }

    if (state === 'failed') {
        return (
            <NextActionCard
                icon={<AlertCircle className="h-5 w-5 text-destructive" aria-hidden="true" />}
                title="Some games still need analysis"
                description={`${unanalyzedGameCount} game${unanalyzedGameCount === 1 ? '' : 's'} remain. Review the analysis bar for the error and retry only the unfinished games.`}
                actionLabel="Review games"
                href="/games"
            />
        );
    }

    if (state === 'analysis-blocked') {
        const blockedAction = automationBlockAction(analysisBlockedReason);
        const blockedDescription =
            analysisBlockedReason === 'credits'
                ? 'automatic server analysis has no credits available right now'
                : analysisBlockedReason === 'plan-cap'
                  ? 'your plan’s monthly analysis limit has been reached'
                  : 'automatic analysis is paused by your reserve or personal caps';
        return (
            <NextActionCard
                icon={<AlertCircle className="h-5 w-5" aria-hidden="true" />}
                title="Your games are imported"
                description={`${unanalyzedGameCount} game${unanalyzedGameCount === 1 ? ' is' : 's are'} waiting because ${blockedDescription}. Sync will continue and your imported games are safe.`}
                actionLabel="Analyze free in browser"
                href="/games"
                secondaryAction={{
                    label: blockedAction.label,
                    href: blockedAction.href,
                }}
            />
        );
    }

    if (state === 'unanalyzed') {
        return (
            <NextActionCard
                icon={<LineChart className="h-5 w-5" aria-hidden="true" />}
                title="Analyze your imported games"
                description={`${unanalyzedGameCount} of ${gameCount} game${gameCount === 1 ? '' : 's'} still need analysis before they can produce practice positions.`}
                actionLabel="Choose analysis"
                href="/games"
            />
        );
    }

    if (state === 'analyzed-no-candidates') {
        if (!trainingMomentCountIsExact) {
            return (
                <NextActionCard
                    icon={<Clock3 className="h-5 w-5" aria-hidden="true" />}
                    title="Practice scan can continue"
                    description="The bounded Home check found no ready position in its first slices. Open Practice to continue from the safe cursor; future-scheduled reviews are not counted as ready."
                    actionLabel="Check Practice"
                    href="/practice"
                />
            );
        }
        return (
            <NextActionCard
                icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
                title="Analysis complete — no practice positions"
                description={`All ${gameCount} games were analyzed successfully. None matched your current extraction settings; this is different from an analysis error.`}
                actionLabel="Review position settings"
                href="/settings"
            />
        );
    }

    return (
        <NextActionCard
            icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
            title={
                duePracticeCount > 0
                    ? `${duePracticeCount}${duePracticeCountIsExact ? '' : '+'} review${duePracticeCount === 1 && duePracticeCountIsExact ? '' : 's'} due`
                    : `${trainingMomentCount}${trainingMomentCountIsExact ? '' : '+'} practice position${trainingMomentCount === 1 && trainingMomentCountIsExact ? '' : 's'} ready`
            }
            description={
                duePracticeCount > 0
                    ? 'Open the Review queue to revisit the positions scheduled for today.'
                    : 'Open Practice and work through your personal positions for as long as you like.'
            }
            actionLabel={
                duePracticeCount > 0
                    ? 'Review due positions'
                    : 'Practice now'
            }
            href={
                duePracticeCount > 0
                    ? '/practice?mode=review'
                    : '/practice'
            }
        />
    );
}

function NextActionCard({
    icon,
    title,
    description,
    actionLabel,
    href,
    secondaryAction,
}: {
    icon: ReactNode;
    title: string;
    description: string;
    actionLabel?: string;
    href?: string;
    secondaryAction?: { label: string; href: string };
}) {
    return (
        <Card
            variant="board"
            className="group relative isolate overflow-hidden border-primary/15 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.13),transparent_42%),linear-gradient(135deg,hsl(var(--card)),hsl(var(--surface-subtle)))]"
        >
            <div
                className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full border border-primary/10"
                aria-hidden="true"
            />
            <CardContent className="relative flex min-h-[220px] flex-col justify-between gap-8 p-5 sm:min-h-[248px] sm:p-8 lg:flex-row lg:items-end">
                <div className="flex max-w-2xl items-start gap-4">
                    <div className="mt-0.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-primary/15 bg-primary/10 text-primary shadow-control [&_svg]:h-5 [&_svg]:w-5">
                        {icon}
                    </div>
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                            Your next move
                        </p>
                        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] sm:text-3xl">
                            {title}
                        </h2>
                        <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                            {description}
                        </p>
                    </div>
                </div>
                <div className="flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
                    {actionLabel && href ? (
                        <Button asChild size="lg" className="w-full sm:w-auto">
                            <Link href={href}>
                                {actionLabel}
                                <ArrowRight aria-hidden="true" />
                            </Link>
                        </Button>
                    ) : null}
                    {secondaryAction ? (
                        <Button
                            asChild
                            variant="outline"
                            size="lg"
                            className="w-full sm:w-auto"
                        >
                            <Link href={secondaryAction.href}>
                                {secondaryAction.label}
                            </Link>
                        </Button>
                    ) : null}
                </div>
            </CardContent>
        </Card>
    );
}

function HomeSummary({
    gameCount,
    trainingMomentCount,
    duePracticeCount,
}: {
    gameCount: number;
    trainingMomentCount: number;
    duePracticeCount: number;
}) {
    const items = [
        { label: 'Games', value: gameCount, href: '/games' },
        {
            label: 'Ready to practice',
            value: trainingMomentCount,
            href: '/practice',
        },
        {
            label: 'Due today',
            value: duePracticeCount,
            href: '/practice?mode=review',
        },
    ];

    return (
        <section
            aria-label="Your library at a glance"
            className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border"
        >
            {items.map((item) => (
                <Link
                    key={item.label}
                    href={item.href}
                    className="group bg-card px-3 py-4 transition-colors duration-base hover:bg-surface-subtle sm:px-5"
                >
                    <span className="block text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">
                        {item.value}
                    </span>
                    <span className="mt-1 block text-[11px] font-medium leading-tight text-muted-foreground sm:text-xs">
                        {item.label}
                    </span>
                </Link>
            ))}
        </section>
    );
}
