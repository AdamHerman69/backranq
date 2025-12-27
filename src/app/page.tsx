'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { ArrowRight, Zap, Target, TrendingUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SignInButton } from '@/components/auth/SignInButton';
import { SyncGamesModal } from '@/components/sync/SyncGamesModal';
import { SyncGamesWidget } from '@/components/sync/SyncGamesWidget';
import { PuzzleTrainerV2 } from '@/components/puzzles/PuzzleTrainerV2';
import { PuzzlesList, type PuzzleListItem } from '@/components/puzzles/PuzzlesList';
import PuzzlesFilter, { type PuzzlesFilters } from '@/components/puzzles/PuzzlesFilter';
import { usePuzzles } from '@/lib/api/usePuzzles';
import { aggregatePuzzleStats } from '@/lib/api/puzzles';

function stripLegacyPseudoTags(tags: string[]): string[] {
    return tags.filter((t) => {
        if (!t) return false;
        if (t === 'avoidBlunder' || t === 'punishBlunder') return false;
        if (t.startsWith('kind:')) return false;
        if (t.startsWith('eco:')) return false;
        if (t.startsWith('opening:')) return false;
        if (t.startsWith('openingVar:')) return false;
        return true;
    });
}

export default function Home() {
    const { data: session, status: sessionStatus } = useSession();
    const router = useRouter();
    const isLoggedIn = !!session?.user?.id;
    const isLoading = sessionStatus === 'loading';

    // Guest mode username inputs
    const [lichessUsername, setLichessUsername] = useState('');
    const [chesscomUsername, setChesscomUsername] = useState('');
    const [showSyncModal, setShowSyncModal] = useState(false);

    // Stats for logged-in users
    const [puzzleCount, setPuzzleCount] = useState<number | null>(null);
    const [gameCount, setGameCount] = useState<number | null>(null);

    // Fetch puzzle count for logged-in users
    useEffect(() => {
        if (!isLoggedIn) return;
        let cancelled = false;

        async function fetchCounts() {
            try {
                const [puzzleRes, gameRes] = await Promise.all([
                    fetch('/api/puzzles?limit=1'),
                    fetch('/api/games?limit=1'),
                ]);
                const puzzleJson = await puzzleRes.json().catch(() => ({})) as { total?: number };
                const gameJson = await gameRes.json().catch(() => ({})) as { total?: number };
                if (cancelled) return;
                setPuzzleCount(typeof puzzleJson.total === 'number' ? puzzleJson.total : 0);
                setGameCount(typeof gameJson.total === 'number' ? gameJson.total : 0);
            } catch {
                if (!cancelled) {
                    setPuzzleCount(0);
                    setGameCount(0);
                }
            }
        }
        fetchCounts();
        return () => { cancelled = true; };
    }, [isLoggedIn]);

    const hasPuzzles = puzzleCount !== null && puzzleCount > 0;
    const hasGames = gameCount !== null && gameCount > 0;

    // Puzzles list for logged-in users
    const { puzzles, total: puzzleTotal, page, totalPages, loading: puzzlesLoading } = usePuzzles({
        limit: 10,
        page: 1,
    });

    const puzzleListItems: PuzzleListItem[] = useMemo(() => {
        return puzzles.map((p) => {
            const stats = p.attemptStats ?? { attempted: 0, correct: 0, solved: false, failed: false };
            const status: PuzzleListItem['status'] = 
                stats.attempted === 0 ? 'new' : 
                stats.solved ? 'solved' : 
                stats.failed ? 'failed' : 'attempted';
            const title = `${p.opening?.eco ? `${p.opening.eco} ` : ''}${p.opening?.name ?? 'Puzzle'}`.trim();
            const modeText = p.mode === 'punishBlunder' ? 'Punish blunder' : 'Avoid blunder';
            const kindText = p.type === 'missedWin' ? 'Missed win' : p.type === 'missedTactic' ? 'Missed tactic' : 'Blunder';
            const phaseText = p.phase === 'opening' ? 'Opening' : p.phase === 'middlegame' ? 'Middlegame' : p.phase === 'endgame' ? 'Endgame' : '';
            const subtitle = `${modeText} • ${kindText}${phaseText ? ` • ${phaseText}` : ''} • ply ${p.sourcePly + 1}`;
            return {
                id: p.id,
                title,
                subtitle,
                status,
                tags: stripLegacyPseudoTags(p.tags ?? []).slice(0, 12),
            };
        });
    }, [puzzles]);

    const handleTryNow = () => {
        if (!lichessUsername.trim() && !chesscomUsername.trim()) return;
        // For now, redirect to login with a message that they need to sign in
        // In the future, we could implement guest syncing
        router.push('/login?callbackUrl=/games');
    };

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
                        <Badge variant="secondary" className="mb-6 text-xs font-medium tracking-wide uppercase">
                            Chess Improvement Tool
                        </Badge>
                        
                        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">
                            Turn your mistakes into
                            <span className="block text-transparent bg-clip-text bg-gradient-to-r from-zinc-600 to-zinc-900 dark:from-zinc-200 dark:to-zinc-400">
                                training puzzles
                            </span>
                        </h1>
                        
                        <p className="mt-6 text-lg text-muted-foreground max-w-xl mx-auto">
                            Import your games from Lichess and Chess.com, 
                            analyze them with Stockfish, and practice the positions where you went wrong.
                        </p>

                        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
                            <SignInButton
                                className="h-12 px-8 text-base font-semibold"
                            >
                                Get Started
                                <ArrowRight className="ml-2 h-4 w-4" />
                            </SignInButton>
                            
                            <Button variant="outline" asChild className="h-12 px-8 text-base">
                                <Link href="/login">Sign In</Link>
                            </Button>
                        </div>
                    </div>
                </section>

                {/* Features */}
                <section className="mx-auto max-w-5xl px-4">
                    <div className="grid gap-6 md:grid-cols-3">
                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <Zap className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Instant Analysis</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Stockfish runs in your browser. No servers, no waiting, no limits.
                                </p>
                            </CardContent>
                        </Card>

                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <Target className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Your Weaknesses</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    Practice the exact positions where you blundered or missed wins.
                                </p>
                            </CardContent>
                        </Card>

                        <Card className="border-0 bg-zinc-50 dark:bg-zinc-900/50">
                            <CardContent className="pt-6">
                                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-zinc-200 dark:bg-zinc-800">
                                    <TrendingUp className="h-5 w-5" />
                                </div>
                                <h3 className="font-semibold">Track Progress</h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                    See your improvement over time with detailed attempt statistics.
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
                                Run Stockfish analysis to find blunders, missed wins, and tactical opportunities.
                            </p>
                        </div>
                        <div>
                            <div className="mb-3 inline-flex h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-sm font-bold dark:bg-zinc-800">
                                3
                            </div>
                            <h3 className="font-medium">Train</h3>
                            <p className="mt-1 text-sm text-muted-foreground">
                                Practice those positions as puzzles until you master them.
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
                            <SignInButton
                                className="mt-6 h-11 px-8"
                            >
                                Sign In with Google
                            </SignInButton>
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
                        {hasPuzzles
                            ? `You have ${puzzleCount} puzzles from ${gameCount} games.`
                            : hasGames
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
                    <SyncGamesWidget context="games" enableAnalyze variant="banner" />
                </CardContent>
            </Card>

            {/* Main content: Trainer or Empty State */}
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
                            <PuzzleTrainerV2 initialViewMode="solve" />
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
            ) : hasGames ? (
                <Card>
                    <CardContent className="py-12 text-center">
                        <div className="mx-auto max-w-md">
                            <h2 className="text-xl font-semibold">Analyze your games</h2>
                            <p className="mt-2 text-muted-foreground">
                                You have {gameCount} games imported. Click "Analyze games" above to generate puzzles from your mistakes.
                            </p>
                            <Button className="mt-6" asChild>
                                <Link href="/games">Go to Games</Link>
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            ) : (
                <Card>
                    <CardContent className="py-12 text-center">
                        <div className="mx-auto max-w-md">
                            <h2 className="text-xl font-semibold">Get started</h2>
                            <p className="mt-2 text-muted-foreground">
                                Sync your games from Lichess or Chess.com, then analyze them to create personalized training puzzles.
                            </p>
                            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-center">
                                <Button asChild>
                                    <Link href="/settings">Link Accounts</Link>
                                </Button>
                            </div>
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    );
}
