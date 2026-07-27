'use client';

import {
    useCallback,
    useEffect,
    useMemo,
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
    Laptop,
    LineChart,
    RefreshCw,
    Shuffle,
    SlidersHorizontal,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SignInButton } from '@/components/auth/SignInButton';
import { SyncGamesWidget } from '@/components/sync/SyncGamesWidget';
import { PuzzleTrainer } from '@/components/puzzles/PuzzleTrainer';
import { PuzzlesList, type PuzzleListItem } from '@/components/puzzles/PuzzlesList';
import { usePuzzles } from '@/lib/api/usePuzzles';
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

export default function Home() {
    const { data: session, status: sessionStatus } = useSession();
    const ownerId = session?.user?.id ?? null;
    const isLoggedIn = !!ownerId;
    const isLoading = sessionStatus === 'loading';

    const [dashboard, setDashboard] = useState<{
        ownerId: string | null;
        status: 'idle' | 'loading' | 'ready' | 'error';
        puzzleCount: number;
        gameCount: number;
        unanalyzedGameCount: number;
        syncStatus: SyncStatus | null;
        error: string | null;
    }>({
        ownerId: null,
        status: 'idle',
        puzzleCount: 0,
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
            const [puzzleRes, gameRes, unanalyzedRes, syncStatus] =
                await Promise.all([
                    fetch('/api/puzzles?limit=1', { cache: 'no-store' }),
                    fetch('/api/games?limit=1', { cache: 'no-store' }),
                    fetch('/api/games?hasAnalysis=false&limit=1', {
                        cache: 'no-store',
                    }),
                    getSyncStatus(),
                ]);
            if (!puzzleRes.ok || !gameRes.ok || !unanalyzedRes.ok) {
                throw new Error('Could not load your training overview.');
            }
            const [puzzleJson, gameJson, unanalyzedJson] = (await Promise.all([
                puzzleRes.json(),
                gameRes.json(),
                unanalyzedRes.json(),
            ])) as Array<{ total?: number }>;
            if (requestId !== dashboardRequestId.current) return;
            setDashboard({
                ownerId,
                status: 'ready',
                puzzleCount:
                    typeof puzzleJson.total === 'number' ? puzzleJson.total : 0,
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
                        : 'Could not load your training overview.',
            }));
        }
    }, [ownerId]);

    useEffect(() => {
        backgroundAnalysis.setOwner(ownerId);
        dashboardRequestId.current += 1;
        setDashboard({
            ownerId,
            status: 'idle',
            puzzleCount: 0,
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
    const puzzleCount = dashboardMatchesOwner ? dashboard.puzzleCount : 0;
    const gameCount = dashboardMatchesOwner ? dashboard.gameCount : 0;
    const unanalyzedGameCount = dashboardMatchesOwner
        ? dashboard.unanalyzedGameCount
        : 0;
    const dashboardSyncStatus = dashboardMatchesOwner
        ? dashboard.syncStatus
        : null;
    const hasPuzzles = puzzleCount > 0;

    // Puzzles list for logged-in users
    const {
        puzzles,
        total: puzzleTotal,
        page,
        totalPages,
        loading: puzzlesLoading,
        error: puzzlesError,
        refetch: refetchPuzzles,
    } = usePuzzles({
        limit: 10,
        page: 1,
        enabled: isLoggedIn,
        scopeKey: ownerId ?? 'guest',
    });

    const puzzleListItems: PuzzleListItem[] = useMemo(() => {
        return puzzles.map((p) => {
            const stats = p.attemptStats ?? { attempted: 0, correct: 0, solved: false, failed: false };
            const status: PuzzleListItem['status'] = 
                stats.attempted === 0 ? 'new' : 
                stats.solved ? 'solved' : 
                stats.failed ? 'failed' : 'attempted';
            return {
                id: p.id,
                title: 'Personal puzzle',
                subtitle: 'Find the best move',
                status,
                tags: [],
            };
        });
    }, [puzzles]);

    const hasLinkedAccount =
        !!dashboardSyncStatus?.linked.lichessUsername ||
        !!dashboardSyncStatus?.linked.chesscomUsername;
    const productState: HomeProductState = deriveHomeProductState({
        loading:
            dashboardStatus === 'idle' || dashboardStatus === 'loading',
        error: dashboardMatchesOwner ? dashboard.error : null,
        hasLinkedAccount,
        gameCount,
        unanalyzedGameCount,
        puzzleCount,
        browserAnalysisRunning:
            analysisSnapshot.ownerId === ownerId &&
            analysisSnapshot.state === 'running',
        serverQueued: dashboardSyncStatus?.analysisJobs?.queued ?? 0,
        serverRunning: dashboardSyncStatus?.analysisJobs?.running ?? 0,
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

    // Guest view - Hero with CTA
    if (!isLoggedIn) {
        return (
            <div className="space-y-16 pb-16">
                {/* Hero Section */}
                <section className="relative overflow-hidden">
                    <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-zinc-200/50 via-transparent to-transparent dark:from-zinc-800/30" />
                    
                    <div className="mx-auto max-w-3xl px-4 pt-16 pb-12 text-center sm:pt-24">
                        {/* <Badge variant="secondary" className="mb-6 text-xs font-medium tracking-wide uppercase">
                            Chess Improvement Tool
                        </Badge> */}
                        
                        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                            Puzzles from your 
                            <span className="block text-transparent bg-clip-text bg-gradient-to-r from-zinc-600 to-zinc-900 dark:from-zinc-200 dark:to-zinc-400">
                              blunders and missed wins
                            </span>
                        </h1>
                        
                        <p className="mt-6 text-lg text-muted-foreground max-w-xl mx-auto">
                            Import your games, fine-tune extraction to focus on what matters, 
                            and analyze everything locally in your browser—completely free.
                        </p>

                        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:flex-wrap sm:justify-center">
                            <SignInButton
                                className="h-12 px-8 text-base font-semibold"
                            >
                                Sign in with Google
                            </SignInButton>
                            <SignInButton
                                provider="lichess"
                                variant="outline"
                                className="h-12 px-8 text-base font-semibold"
                            >
                                Sign in with Lichess
                            </SignInButton>
                            <SignInButton
                                provider="github"
                                variant="outline"
                                className="h-12 px-8 text-base font-semibold"
                            >
                                Sign in with GitHub
                            </SignInButton>
                        </div>
                    </div>
                </section>

                {/* Features */}
                <section className="mx-auto max-w-5xl px-4">
                    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <SlidersHorizontal className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Your Games, Your Rules</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Fine-tune what positions to include by tweaking the extraction parameters.
                                </p>
                            </CardContent>
                        </Card>

                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <Laptop className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Run Locally</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Analysis runs in your browser—no server costs means no subscription fees.
                                </p>
                            </CardContent>
                        </Card>

                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <LineChart className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Analyze</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Explore positions with analysis tools on par with Chess.com or Lichess.
                                </p>
                            </CardContent>
                        </Card>

                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <Shuffle className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Multi solution puzzles</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Not all puzzles have to be super tactical. Mix in positions where you blundered even though there were multiple correct moves. No more puzzle vision.
                                </p>
                            </CardContent>
                        </Card>
                    </div>
                </section>

                {/* How it works */}
                <section className="mx-auto max-w-3xl px-4 text-center">
                    <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
                    <div className="mt-8 grid gap-8 text-left sm:grid-cols-3">
                        <div>
                            <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-sm font-bold dark:bg-zinc-800">
                                1
                            </div>
                            <h3 className="font-medium">Import Games</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Connect your Lichess or Chess.com account and sync your recent games.
                            </p>
                        </div>
                        <div>
                            <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-sm font-bold dark:bg-zinc-800">
                                2
                            </div>
                            <h3 className="font-medium">Analyze</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Run local stockfish analysis to extract puzzles from blunders and missed wins.
                            </p>
                        </div>
                        <div>
                            <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-sm font-bold dark:bg-zinc-800">
                                3
                            </div>
                            <h3 className="font-medium">Train</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Practice as you would with any puzzle set, analyze, improve.
                            </p>
                        </div>
                    </div>
                </section>

                {/* CTA */}
                <section className="mx-auto max-w-xl px-4 text-center">
                    <Card>
                        <CardContent className="py-8">
                            <h2 className="text-xl font-semibold">Ready to improve?</h2>
                            <p className="mt-2 text-muted-foreground">
                                Sign in to start analyzing your games and generating personalized puzzles.
                            </p>
                            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
                                <SignInButton className="h-11 px-6">
                                    Sign in with Google
                                </SignInButton>
                                <SignInButton provider="lichess" variant="outline" className="h-11 px-6">
                                    Sign in with Lichess
                                </SignInButton>
                                <SignInButton provider="github" variant="outline" className="h-11 px-6">
                                    Sign in with GitHub
                                </SignInButton>
                            </div>
                        </CardContent>
                    </Card>
                </section>
            </div>
        );
    }

    // Logged-in view
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
                            ? 'Loading your training overview…'
                            : dashboardStatus === 'error'
                              ? 'Your library is still here, but its latest status could not be loaded.'
                              : hasPuzzles
                            ? `You have ${puzzleCount} puzzles from ${gameCount} games.`
                            : gameCount > 0
                                ? `You have ${gameCount} games. Analyze them to generate puzzles.`
                                : 'Sync your first games to get started.'}
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" asChild>
                        <Link href="/games">View Games</Link>
                    </Button>
                    {hasPuzzles && (
                        <Button variant="outline" asChild>
                            <Link href="/puzzles/library">All Puzzles</Link>
                        </Button>
                    )}
                </div>
            </div>

            {/* Sync widget */}
            <Card>
                <CardContent className="p-4">
                    <SyncGamesWidget context="home" enableAnalyze variant="banner" />
                </CardContent>
            </Card>

            <HomeStateCard
                state={productState}
                gameCount={gameCount}
                unanalyzedGameCount={unanalyzedGameCount}
                puzzleCount={puzzleCount}
                error={dashboardMatchesOwner ? dashboard.error : null}
                onRetry={() => void fetchDashboard()}
            />

            {hasPuzzles ? (
                <>
                    {/* Puzzle Trainer */}
                    <Card>
                        <CardContent className="p-4 sm:p-6">
                            <div className="mb-4 flex items-center justify-between">
                                <h2 className="text-lg font-semibold">Train</h2>
                                <Button variant="ghost" size="sm" asChild>
                                    <Link href="/puzzles">Open Trainer</Link>
                                </Button>
                            </div>
                            <PuzzleTrainer initialViewMode="solve" />
                        </CardContent>
                    </Card>

                    {/* Puzzles List */}
                    <Card>
                        <CardContent className="pt-6">
                            <div className="mb-4 flex items-center justify-between">
                                <h2 className="text-lg font-semibold">Recent Puzzles</h2>
                                <Button variant="ghost" size="sm" asChild>
                                    <Link href="/puzzles/library">View All</Link>
                                </Button>
                            </div>
                            {puzzlesLoading ? (
                                <div className="text-sm text-muted-foreground">Loading puzzles…</div>
                            ) : puzzlesError ? (
                                <div
                                    className="flex flex-wrap items-center justify-between gap-3 text-sm"
                                    role="alert"
                                >
                                    <span className="text-muted-foreground">
                                        Could not load recent puzzles: {puzzlesError}
                                    </span>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => void refetchPuzzles()}
                                    >
                                        Try again
                                    </Button>
                                </div>
                            ) : puzzleListItems.length === 0 ? (
                                <div className="text-sm text-muted-foreground">No puzzles yet.</div>
                            ) : (
                                <PuzzlesList
                                    puzzles={puzzleListItems}
                                    total={puzzleTotal}
                                    page={page}
                                    totalPages={totalPages}
                                    baseQueryString=""
                                />
                            )}
                        </CardContent>
                    </Card>
                </>
            ) : null}
        </div>
    );
}

function HomeStateCard({
    state,
    gameCount,
    unanalyzedGameCount,
    puzzleCount,
    error,
    onRetry,
}: {
    state: HomeProductState;
    gameCount: number;
    unanalyzedGameCount: number;
    puzzleCount: number;
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
                            Checking games, analysis and puzzle progress…
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
                                {error ?? 'We could not load the latest library status.'}
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

    if (state === 'no-games') {
        return (
            <NextActionCard
                icon={<Shuffle className="h-5 w-5" aria-hidden="true" />}
                title="Sync your first games"
                description="Your account is linked. Use Sync games above to import recent games and start building your training set."
                actionLabel="Review linked accounts"
                href="/settings"
            />
        );
    }

    if (state === 'analysis-in-progress') {
        return (
            <NextActionCard
                icon={<Clock3 className="h-5 w-5" aria-hidden="true" />}
                title="Analysis is in progress"
                description={`${Math.max(0, gameCount - unanalyzedGameCount)} of ${gameCount} games are analyzed. You can leave server analysis running or keep this tab open for browser analysis.`}
                actionLabel={puzzleCount > 0 ? 'Train available puzzles' : 'View games'}
                href={puzzleCount > 0 ? '/puzzles' : '/games'}
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

    if (state === 'unanalyzed') {
        return (
            <NextActionCard
                icon={<LineChart className="h-5 w-5" aria-hidden="true" />}
                title="Analyze your imported games"
                description={`${unanalyzedGameCount} of ${gameCount} game${gameCount === 1 ? '' : 's'} still need analysis before they can produce puzzles.`}
                actionLabel="Choose analysis"
                href="/games"
            />
        );
    }

    if (state === 'analyzed-no-candidates') {
        return (
            <NextActionCard
                icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
                title="Analysis complete — no puzzle candidates"
                description={`All ${gameCount} games were analyzed successfully. None matched your current extraction settings; this is different from an analysis error.`}
                actionLabel="Review extraction settings"
                href="/settings"
            />
        );
    }

    return (
        <NextActionCard
            icon={<CheckCircle2 className="h-5 w-5" aria-hidden="true" />}
            title="Your training set is ready"
            description={`${puzzleCount} personal puzzle${puzzleCount === 1 ? '' : 's'} are ready. The next best step is a short focused session.`}
            actionLabel="Start training"
            href="/puzzles"
        />
    );
}

function NextActionCard({
    icon,
    title,
    description,
    actionLabel,
    href,
}: {
    icon: ReactNode;
    title: string;
    description: string;
    actionLabel: string;
    href: string;
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
                <Button asChild>
                    <Link href={href}>{actionLabel}</Link>
                </Button>
            </CardContent>
        </Card>
    );
}
