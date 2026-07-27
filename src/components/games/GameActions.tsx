'use client';

import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { extractPuzzlesFromGames } from '@/lib/analysis/extractPuzzles';
import { AnalysisProgress, type AnalysisProgressState } from '@/components/analysis/AnalysisProgress';
import { Button } from '@/components/ui/button';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import type { ManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import { registerServerAnalysisEnqueue } from '@/lib/games/serverAnalysisTracking';
import type { EnqueueServerAnalysisJobsResult } from '@/lib/services/gameSync';

export function GameActions({
    ownerId,
    dbGameId,
    normalizedGame,
    usernameByProvider,
    hasAnalysis,
    puzzleCount,
    serverAnalysisCapacity,
    onAnalysisSaved,
}: {
    ownerId: string;
    dbGameId: string;
    normalizedGame: NormalizedGame;
    usernameByProvider: { lichess?: string; chesscom?: string };
    hasAnalysis: boolean;
    puzzleCount: number;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
    onAnalysisSaved?: (analysis: GameAnalysis) => void;
}) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<AnalysisProgressState | null>(null);
    const [browserReviewOpen, setBrowserReviewOpen] = useState(false);
    const [serverReviewOpen, setServerReviewOpen] = useState(false);
    const [deleteReviewOpen, setDeleteReviewOpen] = useState(false);
    const engineRef = useRef<StockfishClient | null>(null);
    const actionLabel = hasAnalysis ? 'Re-analyze' : 'Analyze';

    const providerKey = normalizedGame.provider;
    const linkedUserName =
        providerKey === 'lichess'
            ? usernameByProvider.lichess
            : usernameByProvider.chesscom;

    const canAnalyze = useMemo(() => {
        return !!linkedUserName?.trim();
    }, [linkedUserName]);

    function cancel() {
        engineRef.current?.cancelAll();
        engineRef.current?.terminate();
        engineRef.current = null;
        setBusy(false);
        setProgress(null);
        toast.message('Cancelled analysis');
    }

    async function analyze(mode: 'analyze' | 'reanalyze') {
        if (busy) {
            toast.message('Analysis is already in progress.');
            return;
        }
        if (!canAnalyze) {
            toast.error(
                `To analyze, first link your ${normalizedGame.provider} username in Settings.`
            );
            return;
        }

        if (mode === 'reanalyze') setBrowserReviewOpen(false);
        setBusy(true);
        const id = toast.loading(
            mode === 'reanalyze' ? 'Re-analyzing game…' : 'Analyzing game…'
        );
        try {
            const engine = engineRef.current ?? new StockfishClient();
            engineRef.current = engine;

            const res = await extractPuzzlesFromGames({
                games: [normalizedGame],
                selectedGameIds: new Set([normalizedGame.id]),
                engine,
                usernameByProvider,
                onProgress: (p) => {
                    const percent =
                        p.plyCount > 0 ? ((p.ply + 1) / p.plyCount) * 100 : 0;
                    setProgress({
                        label: `Ply ${p.ply + 1}/${p.plyCount}`,
                        percent,
                        phase: p.phase,
                    });
                },
                options: {
                    movetimeMs: 200,
                    returnAnalysis: true,
                    // Generate puzzles too (unlimited for analyzed games).
                    maxPuzzlesPerGame: null,
                    puzzleMode: 'both',
                },
            });

            const analysis = res.analysis?.get(normalizedGame.id);
            if (!analysis) throw new Error('Analysis produced no result');

            const saveRes = await fetch(`/api/games/${dbGameId}/analysis`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    analysis,
                    puzzles: (res.puzzles ?? []).filter(
                        (p) => p.sourceGameId === normalizedGame.id
                    ),
                }),
            });
            const saveJson = (await saveRes.json().catch(() => ({}))) as {
                error?: string;
            };
            if (!saveRes.ok) throw new Error(saveJson.error ?? 'Failed to save');

            toast.success('Analysis saved', { id });
            onAnalysisSaved?.(analysis);
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Analysis failed', { id });
        } finally {
            setBusy(false);
            setProgress(null);
        }
    }

    async function queueServerAnalysis() {
        if (busy) {
            toast.message('Analysis is already in progress.');
            return;
        }
        if (!canAnalyze) {
            toast.error(
                `To analyze, first link your ${normalizedGame.provider} username in Settings.`
            );
            return;
        }

        const force = hasAnalysis;

        setBusy(true);
        const id = toast.loading(
            force ? 'Queueing server re-analysis…' : 'Queueing server analysis…'
        );
        try {
            const res = await fetch('/api/analysis/jobs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gameIds: [dbGameId], force }),
            });
            const json = (await res.json().catch(() => ({}))) as
                Partial<EnqueueServerAnalysisJobsResult> & {
                error?: string;
            };
            if (!res.ok) throw new Error(json.error ?? 'Failed to queue analysis');

            if ((json.queued ?? 0) > 0) {
                registerServerAnalysisEnqueue({
                    ownerId,
                    result: {
                        queued: json.queued ?? 0,
                        skipped: json.skipped ?? 0,
                        jobs: json.jobs,
                        errors: json.errors,
                    },
                });
                toast.success('Server analysis queued', { id });
                setServerReviewOpen(false);
            } else if ((json.errors?.length ?? 0) > 0) {
                toast.warning(json.errors?.[0]?.error ?? 'Server analysis was not queued', { id });
            } else if ((json.skipped ?? 0) > 0) {
                toast.message('Server analysis was already queued or complete', { id });
                setServerReviewOpen(false);
            } else {
                toast.message('Server analysis was not queued', { id });
            }
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Failed to queue analysis', { id });
        } finally {
            setBusy(false);
        }
    }

    async function exportPgn() {
        try {
            const blob = new Blob([normalizedGame.pgn], {
                type: 'application/x-chess-pgn',
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${normalizedGame.provider}-${normalizedGame.id}.pgn`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch {
            toast.error('Failed to export PGN');
        }
    }

    async function deleteGame() {
        setBusy(true);
        const id = toast.loading('Deleting game…');
        try {
            const res = await fetch(`/api/games/${dbGameId}`, { method: 'DELETE' });
            const json = (await res.json().catch(() => ({}))) as { error?: string };
            if (!res.ok) throw new Error(json.error ?? 'Delete failed');
            toast.success('Game deleted', { id });
            setDeleteReviewOpen(false);
            router.push('/games');
            router.refresh();
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Delete failed', { id });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="space-y-4">
            {progress ? <AnalysisProgress state={progress} onCancel={cancel} /> : null}

            <div className="flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                        if (hasAnalysis) {
                            setBrowserReviewOpen(true);
                        } else {
                            void analyze('analyze');
                        }
                    }}
                >
                    {actionLabel} in browser
                </Button>

                <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setServerReviewOpen(true)}
                >
                    {actionLabel} on server
                </Button>

                <Button asChild variant="ghost" title="Browse your puzzle library">
                    <Link href="/puzzles/library">Open puzzle library →</Link>
                </Button>

                <Button type="button" variant="outline" onClick={exportPgn}>
                    Export PGN
                </Button>

                <Button
                    type="button"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => setDeleteReviewOpen(true)}
                >
                    Delete
                </Button>
            </div>

            {!canAnalyze ? (
                <div className="text-sm text-muted-foreground">
                    Link your {normalizedGame.provider} username in{' '}
                    <Link href="/settings">Settings</Link> to enable analysis.
                </div>
            ) : (
                <div className="text-sm text-muted-foreground">
                    Browser analysis is free and this tab must stay open. Server analysis
                    uses 1 credit and continues in the background.
                </div>
            )}

            <ActionConfirmDialog
                open={browserReviewOpen}
                onOpenChange={setBrowserReviewOpen}
                title="Re-analyze this game in the browser?"
                description="This tab must remain open until analysis and puzzle extraction finish."
                confirmLabel="Start free re-analysis"
                onConfirm={() => analyze('reanalyze')}
                busy={busy}
            >
                <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Credit cost</dt>
                        <dd className="font-semibold">0 credits</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Current training set
                        </dt>
                        <dd className="font-semibold">
                            {puzzleCount} active{' '}
                            {puzzleCount === 1 ? 'puzzle' : 'puzzles'}
                        </dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Puzzle impact</dt>
                        <dd>
                            Matching puzzles are updated in place. Active puzzles
                            that are no longer generated are archived, and newly
                            found puzzles are added.
                        </dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Attempt history</dt>
                        <dd>
                            Existing attempts are preserved. They remain attached to
                            matching or archived puzzles.
                        </dd>
                    </div>
                </dl>
            </ActionConfirmDialog>

            <ActionConfirmDialog
                open={serverReviewOpen}
                onOpenChange={setServerReviewOpen}
                title={`${hasAnalysis ? 'Re-analyze' : 'Analyze'} this game on the server?`}
                description="The analysis runs in the background, so you can leave this page after it is queued."
                confirmLabel={`Queue server ${hasAnalysis ? 're-analysis' : 'analysis'}`}
                onConfirm={queueServerAnalysis}
                busy={busy}
                confirmDisabled={serverAnalysisCapacity.reservableCredits < 1}
            >
                <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Credit cost</dt>
                        <dd className="font-semibold">1 credit</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Current credit balance
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.currentBalance}{' '}
                            {serverAnalysisCapacity.currentBalance === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Currently reservable
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.reservableCredits}{' '}
                            {serverAnalysisCapacity.reservableCredits === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Outstanding reservations
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.outstandingReservations}{' '}
                            {serverAnalysisCapacity.outstandingReservations === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Monthly capacity after reservations
                        </dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.monthlyRemaining}{' '}
                            {serverAnalysisCapacity.monthlyRemaining === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Safety floor</dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.stopThreshold}{' '}
                            {serverAnalysisCapacity.stopThreshold === 1
                                ? 'credit'
                                : 'credits'}
                        </dd>
                    </div>
                    {hasAnalysis ? (
                        <div className="sm:col-span-2">
                            <dt className="text-muted-foreground">Impact</dt>
                            <dd>
                                The completed re-analysis replaces the current
                                evaluation. Of {puzzleCount} currently active{' '}
                                {puzzleCount === 1 ? 'puzzle' : 'puzzles'}, matching
                                puzzles are updated, stale puzzles are archived, and
                                new puzzles are added. Attempt history is preserved.
                            </dd>
                        </div>
                    ) : null}
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Capacity note</dt>
                        <dd>{serverAnalysisCapacity.limitingReason}</dd>
                    </div>
                    {serverAnalysisCapacity.reservableCredits < 1 ? (
                        <div className="sm:col-span-2">
                            <dt className="font-medium text-amber-700 dark:text-amber-300">
                                Server analysis unavailable
                            </dt>
                            <dd>
                                Review your{' '}
                                <Link href="/settings" className="underline">
                                    billing and safety limits
                                </Link>{' '}
                                before queueing this analysis.
                            </dd>
                        </div>
                    ) : null}
                </dl>
            </ActionConfirmDialog>

            <ActionConfirmDialog
                open={deleteReviewOpen}
                onOpenChange={setDeleteReviewOpen}
                title="Permanently delete this game?"
                description="This cannot be undone."
                confirmLabel="Delete game"
                onConfirm={deleteGame}
                variant="destructive"
                busy={busy}
            >
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                    Deleting this game also permanently removes every associated
                    puzzle, including archived puzzles, and all of their attempt
                    history.
                </div>
            </ActionConfirmDialog>
        </div>
    );
}
