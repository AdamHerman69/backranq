'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
    BrainCircuit,
    CloudCog,
    Download,
    MoreHorizontal,
    Target,
    Trash2,
} from 'lucide-react';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import { StockfishClient } from '@/lib/analysis/stockfishClient';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { LichessTablebaseClient } from '@/lib/analysis/tablebase';
import { AnalysisProgress, type AnalysisProgressState } from '@/components/analysis/AnalysisProgress';
import { Button } from '@/components/ui/button';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ManualServerAnalysisCapacity } from '@/lib/games/serverAnalysisCapacity';
import {
    acceptedServerAnalysisCount,
    queueServerAnalysisBatch,
    useHasConfirmingServerAnalysisRequest,
} from '@/lib/analysis/serverAnalysisCoordinator';
import {
    analysisDefaultsToExtractOptions,
    defaultPreferences,
    pickAnalysisDefaults,
    type PreferencesSchema,
} from '@/lib/preferences';
import { resolveGameAnalysisProvenance } from '@/lib/games/analysisProvenance';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import { resolveSessionOwnerId } from '@/lib/auth/ownerRun';
import {
    cleanupBrowserGameAnalysisRun,
    isBrowserGameAnalysisRunCurrent,
    type BrowserGameAnalysisRun,
} from '@/lib/analysis/browserGameAnalysisRun';

type ActiveBrowserAnalysisRun = BrowserGameAnalysisRun<StockfishClient> & {
    toastId: ReturnType<typeof toast.loading>;
};

export function GameActions({
    ownerId,
    dbGameId,
    normalizedGame,
    hasAnalysis,
    trainingMomentCount,
    serverAnalysisCapacity,
    onAnalysisSaved,
}: {
    ownerId: string;
    dbGameId: string;
    normalizedGame: NormalizedGame;
    hasAnalysis: boolean;
    trainingMomentCount: number;
    serverAnalysisCapacity: ManualServerAnalysisCapacity;
    onAnalysisSaved?: (analysis: GameAnalysis) => void;
}) {
    const router = useRouter();
    const { data: session, status: sessionStatus } = useSession();
    const activeOwnerId = resolveSessionOwnerId({
        sessionStatus,
        liveOwnerId: session?.user?.id ?? null,
        initialOwnerId: ownerId,
    });
    const ownerReady = activeOwnerId === ownerId;
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<AnalysisProgressState | null>(null);
    const [browserReviewOpen, setBrowserReviewOpen] = useState(false);
    const [serverReviewOpen, setServerReviewOpen] = useState(false);
    const [deleteReviewOpen, setDeleteReviewOpen] = useState(false);
    const activeBrowserRunRef = useRef<ActiveBrowserAnalysisRun | null>(null);
    const browserRunGenerationRef = useRef(0);
    const actionLabel = hasAnalysis ? 'Re-analyze' : 'Analyze';
    const hasConfirmingServerRequest =
        useHasConfirmingServerAnalysisRequest(ownerId);

    const canAnalyze = useMemo(
        () => resolveGameAnalysisProvenance(normalizedGame) !== null,
        [normalizedGame]
    );

    function detachBrowserRun(
        run: ActiveBrowserAnalysisRun | null,
        dismissToast = false
    ) {
        if (!run) return;
        if (activeBrowserRunRef.current === run) {
            activeBrowserRunRef.current = null;
        }
        cleanupBrowserGameAnalysisRun(run);
        if (dismissToast) toast.dismiss(run.toastId);
    }

    function cancel() {
        const run = activeBrowserRunRef.current;
        if (!run) return;
        browserRunGenerationRef.current += 1;
        detachBrowserRun(run, true);
        setBusy(false);
        setProgress(null);
        toast.message('Cancelled analysis');
    }

    useEffect(() => {
        if (ownerReady) return;
        setBrowserReviewOpen(false);
        setServerReviewOpen(false);
        setDeleteReviewOpen(false);
        const run = activeBrowserRunRef.current;
        if (run) {
            browserRunGenerationRef.current += 1;
            detachBrowserRun(run, true);
        }
        setBusy(false);
        setProgress(null);
    }, [ownerReady]);

    useEffect(() => {
        return () => {
            browserRunGenerationRef.current += 1;
            detachBrowserRun(activeBrowserRunRef.current, true);
        };
    }, []);

    async function analyze(mode: 'analyze' | 'reanalyze') {
        if (busy) {
            toast.message('Analysis is already in progress.');
            return;
        }
        if (!ownerReady) {
            toast.error(
                'Your signed-in account changed. Reload the game before analyzing it.'
            );
            return;
        }
        if (!canAnalyze) {
            toast.error(
                'This game has invalid or missing frozen player provenance.'
            );
            return;
        }

        const id = toast.loading(
            mode === 'reanalyze' ? 'Re-analyzing game…' : 'Analyzing game…'
        );
        const engine = new StockfishClient();
        const run: ActiveBrowserAnalysisRun = {
            ownerId,
            generation: browserRunGenerationRef.current + 1,
            controller: new AbortController(),
            engine,
            cleaned: false,
            toastId: id,
        };
        browserRunGenerationRef.current = run.generation;
        activeBrowserRunRef.current = run;
        const isCurrent = () =>
            isBrowserGameAnalysisRunCurrent({
                run,
                activeRun: activeBrowserRunRef.current,
                activeOwnerId,
                currentGeneration: browserRunGenerationRef.current,
            });
        setBrowserReviewOpen(false);
        setBusy(true);
        try {
            let analysisDefaults = pickAnalysisDefaults(defaultPreferences());
            const preferencesResponse = await fetch('/api/user/preferences', {
                cache: 'no-store',
                headers: { [EXPECTED_OWNER_HEADER]: run.ownerId },
                signal: run.controller.signal,
            });
            if (!isCurrent()) return;
            if (preferencesResponse.ok) {
                const preferencesJson = (await preferencesResponse
                    .json()
                    .catch(() => null)) as {
                    ownerId?: string;
                    preferences?: PreferencesSchema;
                } | null;
                if (!isCurrent()) return;
                if (preferencesJson?.ownerId !== run.ownerId) {
                    throw new Error(
                        'The server returned analysis settings for a different account.'
                    );
                }
                if (preferencesJson?.preferences) {
                    analysisDefaults = pickAnalysisDefaults(
                        preferencesJson.preferences
                    );
                }
            }

            const res = await extractTrainingMomentsFromGames({
                games: [normalizedGame],
                selectedGameIds: new Set([normalizedGame.id]),
                engine,
                tablebase: new LichessTablebaseClient(),
                canonicalSourceGameIdByGameId: {
                    [normalizedGame.id]: dbGameId,
                },
                onProgress: (p) => {
                    if (!isCurrent()) return;
                    const percent =
                        p.plyCount > 0 ? ((p.ply + 1) / p.plyCount) * 100 : 0;
                    setProgress({
                        label: `Ply ${p.ply + 1}/${p.plyCount}`,
                        percent,
                        phase: p.phase,
                    });
                },
                options: analysisDefaultsToExtractOptions(analysisDefaults, {
                    returnAnalysis: true,
                }),
            });
            if (!isCurrent()) return;

            const analysis = res.analysis?.get(normalizedGame.id);
            if (!analysis) throw new Error('Analysis produced no result');
            const extractionManifest = res.manifests.find(
                (manifest) => manifest.sourceGameId === dbGameId
            );
            if (!extractionManifest?.complete) {
                throw new Error('Practice position extraction did not complete');
            }
            const engineIdentity = await engine.getIdentity();
            if (!isCurrent()) return;

            const saveRes = await fetch(`/api/games/${dbGameId}/analysis`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    [EXPECTED_OWNER_HEADER]: run.ownerId,
                },
                signal: run.controller.signal,
                body: JSON.stringify({
                    analysis,
                    trainingMoments: res.moments.filter(
                        (moment) => moment.sourceGameId === dbGameId
                    ),
                    extractionManifest,
                    configSnapshot: res.configSnapshot,
                    configHash: res.configHash,
                    analysisQuality: analysisDefaults.analysisQuality,
                    engine: engineIdentity,
                }),
            });
            const saveJson = (await saveRes.json().catch(() => ({}))) as {
                ownerId?: string;
                error?: string;
            };
            if (!isCurrent()) return;
            if (!saveRes.ok) throw new Error(saveJson.error ?? 'Failed to save');
            if (saveJson.ownerId !== run.ownerId) {
                throw new Error(
                    'The server saved analysis for a different account.'
                );
            }

            toast.success('Analysis saved', { id });
            onAnalysisSaved?.(analysis);
            router.refresh();
        } catch (e) {
            if (
                run.controller.signal.aborted ||
                (e instanceof Error && e.name === 'AbortError') ||
                !isCurrent()
            ) {
                toast.dismiss(id);
                return;
            }
            toast.error(e instanceof Error ? e.message : 'Analysis failed', { id });
        } finally {
            const wasCurrent = activeBrowserRunRef.current === run;
            detachBrowserRun(run);
            if (wasCurrent) {
                setBusy(false);
                setProgress(null);
            }
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
            const result = await queueServerAnalysisBatch({
                ownerId,
                gameIds: [dbGameId],
                force,
            });
            if (result.state === 'confirming') {
                toast.message(
                    'The server is still confirming this request. Backranq will keep checking it in the background.',
                    { id }
                );
                setServerReviewOpen(false);
            } else if (acceptedServerAnalysisCount(result.batch) > 0) {
                toast.success('Server analysis queued', { id });
                setServerReviewOpen(false);
            } else if (result.batch.failed > 0) {
                toast.warning('Server analysis could not be queued', { id });
            } else if (result.batch.skipped > 0) {
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

            <div className="flex flex-wrap items-center gap-2 rounded-2xl border bg-card/75 p-2.5 shadow-[0_16px_50px_-48px_rgba(15,23,42,0.65)]">
                {trainingMomentCount > 0 ? (
                    <Button asChild title="Practice positions from this game">
                        <Link href={`/practice?gameId=${encodeURIComponent(dbGameId)}`}>
                            <Target aria-hidden="true" />
                            Practice {trainingMomentCount}{' '}
                            {trainingMomentCount === 1 ? 'position' : 'positions'}
                        </Link>
                    </Button>
                ) : null}

                {!hasAnalysis ? (
                    <Button
                        type="button"
                        variant={trainingMomentCount > 0 ? 'outline' : 'default'}
                        disabled={busy || !ownerReady}
                        onClick={() => setBrowserReviewOpen(true)}
                    >
                        <BrainCircuit aria-hidden="true" />
                        Analyze free in browser
                    </Button>
                ) : null}

                {!hasAnalysis && serverAnalysisCapacity.reservableGames > 0 ? (
                    <Button
                        type="button"
                        variant="ghost"
                        disabled={busy || !ownerReady}
                        onClick={() => setServerReviewOpen(true)}
                    >
                        <CloudCog aria-hidden="true" />
                        Analyze in background
                    </Button>
                ) : null}

                <div className="ml-auto">
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label="More game actions"
                            >
                                <MoreHorizontal aria-hidden="true" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-60">
                            <DropdownMenuLabel>Game actions</DropdownMenuLabel>
                            <DropdownMenuItem
                                disabled={
                                    busy ||
                                    !ownerReady ||
                                    (hasAnalysis && hasConfirmingServerRequest)
                                }
                                onSelect={() => setBrowserReviewOpen(true)}
                            >
                                <BrainCircuit className="mr-2" aria-hidden="true" />
                                {actionLabel} in browser
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                disabled={busy || !ownerReady}
                                onSelect={() => setServerReviewOpen(true)}
                            >
                                <CloudCog className="mr-2" aria-hidden="true" />
                                {actionLabel} in background
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void exportPgn()}>
                                <Download className="mr-2" aria-hidden="true" />
                                Export PGN
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                disabled={busy || !ownerReady}
                                className="text-destructive focus:text-destructive"
                                onSelect={() => setDeleteReviewOpen(true)}
                            >
                                <Trash2 className="mr-2" aria-hidden="true" />
                                Delete game
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            {!canAnalyze ? (
                <div className="px-1 text-xs text-muted-foreground">
                    This game cannot be analyzed because its frozen player
                    perspective is invalid.
                </div>
            ) : (
                <div className="px-1 text-xs text-muted-foreground">
                    Analysis uses{' '}
                    {serverAnalysisCapacity.analysisQuality === 'THOROUGH'
                        ? 'Thorough'
                        : 'Standard'}{' '}
                    quality. Browser analysis is free; background analysis costs{' '}
                    {serverAnalysisCapacity.creditsPerGame} credits per game.{' '}
                    <Link href="/settings#analysis-defaults" className="underline">
                        Change quality
                    </Link>
                    .
                </div>
            )}

            <ActionConfirmDialog
                open={browserReviewOpen}
                onOpenChange={setBrowserReviewOpen}
                title={`${hasAnalysis ? 'Re-analyze' : 'Analyze'} this game in the browser?`}
                description="This tab must remain open until analysis and position extraction finish."
                confirmLabel={`Start free ${hasAnalysis ? 're-analysis' : 'analysis'}`}
                onConfirm={() => analyze(hasAnalysis ? 'reanalyze' : 'analyze')}
                busy={busy}
                confirmDisabled={!ownerReady || !canAnalyze}
            >
                <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Credit cost</dt>
                        <dd className="font-semibold">0 credits</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">Quality</dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.analysisQuality === 'THOROUGH'
                                ? 'Thorough'
                                : 'Standard'}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">
                            Your positions
                        </dt>
                        <dd className="font-semibold">
                            {trainingMomentCount} active practice{' '}
                            {trainingMomentCount === 1 ? 'position' : 'positions'}
                        </dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Effect on your positions</dt>
                        <dd>
                            Matching positions receive a new immutable solution
                            revision. Stale positions are archived and newly found
                            decisions are added.
                        </dd>
                    </div>
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Attempt history</dt>
                        <dd>
                            Existing attempts stay attached to the exact solution
                            revision that was graded.
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
                allowCloseWhileBusy
                confirmDisabled={
                    !ownerReady ||
                    !canAnalyze ||
                    (hasAnalysis && hasConfirmingServerRequest)
                }
            >
                <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">Credit cost</dt>
                        <dd className="font-semibold">
                            {serverAnalysisCapacity.creditsPerGame} credits ·{' '}
                            {serverAnalysisCapacity.analysisQuality === 'THOROUGH'
                                ? 'Thorough'
                                : 'Standard'}
                        </dd>
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
                            {serverAnalysisCapacity.reservableGames}{' '}
                            {serverAnalysisCapacity.reservableGames === 1
                                ? 'game'
                                : 'games'}
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
                                evaluation. Of {trainingMomentCount} currently active{' '}
                                {trainingMomentCount === 1
                                    ? 'practice position'
                                    : 'practice positions'}
                                , matching positions receive new revisions, stale
                                positions are archived, and new positions are added. Attempt
                                history is preserved.
                            </dd>
                        </div>
                    ) : null}
                    <div className="sm:col-span-2">
                        <dt className="text-muted-foreground">Capacity note</dt>
                        <dd>{serverAnalysisCapacity.limitingReason}</dd>
                    </div>
                    {serverAnalysisCapacity.reservableGames < 1 ? (
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
                confirmDisabled={!ownerReady}
            >
                <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                    Deleting this game also permanently removes every associated
                    practice position, including archived positions, and their attempt
                    history.
                </div>
            </ActionConfirmDialog>
        </div>
    );
}
