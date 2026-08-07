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
    CheckCircle2,
    Clock3,
    LineChart,
    RefreshCw,
    Shuffle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
        duePracticeCount: number;
        gameCount: number;
        unanalyzedGameCount: number;
        syncStatus: SyncStatus | null;
        error: string | null;
    }>({
        ownerId: null,
        status: 'idle',
        trainingMomentCount: 0,
        duePracticeCount: 0,
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
                    { totalEligibleCount?: number; dueCount?: number },
                    { total?: number },
                    { total?: number },
                ];
            if (requestId !== dashboardRequestId.current) return;
            setDashboard({
                ownerId,
                status: 'ready',
                trainingMomentCount:
                    typeof practiceJson.totalEligibleCount === 'number'
                        ? practiceJson.totalEligibleCount
                        : 0,
                duePracticeCount:
                    typeof practiceJson.dueCount === 'number'
                        ? practiceJson.dueCount
                        : 0,
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
            duePracticeCount: 0,
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
            <div className="flex min-h-[60vh] items-center justify-center">
                <div className="text-muted-foreground">Loading…</div>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            {/* Welcome header */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div className="space-y-1">
                    <h1 className="text-2xl font-semibold tracking-tight">
                        Welcome back{session?.user?.name ? `, ${session.user.name.split(' ')[0]}` : ''}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                        {dashboardStatus === 'loading' || dashboardStatus === 'idle'
                            ? 'Loading your practice overview…'
                            : dashboardStatus === 'error'
                              ? 'Your games and positions are still here, but their latest status could not be loaded.'
                            : duePracticeCount > 0
                              ? `${duePracticeCount} practice position${duePracticeCount === 1 ? ' is' : 's are'} due for review.`
                            : hasTrainingMoments
                            ? `Your next practice position is ready from ${gameCount} games.`
                            : dashboardSyncStatus === null
                              ? 'Your library is available, but linked-account sync status is temporarily unavailable.'
                            : gameCount > 0
                                ? `You have ${gameCount} games. Analyze them to find personal practice positions.`
                                : 'Sync your first games to get started.'}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" asChild>
                        <Link href="/games">View Games</Link>
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
                duePracticeCount={duePracticeCount}
                analysisBlockedReason={effectiveAnalysisBlockedReason}
                error={dashboardMatchesOwner ? dashboard.error : null}
                onRetry={() => void fetchDashboard()}
            />

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
    duePracticeCount,
    analysisBlockedReason,
    error,
    onRetry,
}: {
    state: HomeProductState;
    gameCount: number;
    unanalyzedGameCount: number;
    trainingMomentCount: number;
    duePracticeCount: number;
    analysisBlockedReason: string | null;
    error: string | null;
    onRetry: () => void;
}) {
    if (state === 'loading') {
        return (
            <Card aria-live="polite">
                <CardContent className="flex items-center gap-3 py-6">
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
                    ? `${duePracticeCount} review${duePracticeCount === 1 ? '' : 's'} due`
                    : 'Your positions are ready'
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
        <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 py-6">
                <div className="flex max-w-2xl items-start gap-3">
                    <div className="mt-0.5 text-muted-foreground">{icon}</div>
                    <div>
                        <div className="font-medium">{title}</div>
                        <div className="mt-1 text-sm text-muted-foreground">
                            {description}
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap gap-2">
                    {actionLabel && href ? (
                        <Button asChild>
                            <Link href={href}>{actionLabel}</Link>
                        </Button>
                    ) : null}
                    {secondaryAction ? (
                        <Button asChild variant="outline">
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
