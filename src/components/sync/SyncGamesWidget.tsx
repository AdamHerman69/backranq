'use client';

import {
    useCallback,
    useEffect,
    useRef,
    useState,
    type MouseEvent,
} from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
    AlertCircle,
    CheckCircle2,
    Clock3,
    Cloud,
    RefreshCw,
} from 'lucide-react';

import {
    automationBlockAction,
    formatSyncTime,
    humanizeAutomationBlockReason,
    isCreditOrCapBlockReason,
    mostRecentProviderActivity,
    requestIncrementalSync,
    waitForIncrementalSyncJobs,
    type IncrementalSyncResult,
} from '@/components/sync/syncClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { publishLibraryChanged } from '@/lib/analysis/analysisCompletion';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
    type OwnerEpoch,
    type OwnerRunToken,
} from '@/lib/auth/ownerRun';
import {
    getSyncStatus,
    primeSyncStatusSnapshot,
    type SyncStatus,
} from '@/lib/services/gameSync';

const AnalyzeGamesModal = dynamic(
    () =>
        import('@/components/analysis/AnalyzeGamesModal').then(
            (module) => module.AnalyzeGamesModal
        ),
    { ssr: false }
);
const SyncGamesModal = dynamic(
    () =>
        import('@/components/sync/SyncGamesModal').then(
            (module) => module.SyncGamesModal
        ),
    { ssr: false }
);

type SyncActionState = 'idle' | 'syncing' | 'success' | 'error';
type SyncFeedback = {
    ownerId: string | null;
    action: SyncActionState;
    message: string;
};

function friendlySyncError(message?: string | null) {
    const normalized = message?.toLowerCase() ?? '';
    if (normalized.includes('404') || normalized.includes('not found')) {
        return 'A linked profile could not be reached. Check its username in Settings.';
    }
    if (normalized.includes('429') || normalized.includes('rate')) {
        return 'The chess provider is busy. Your library is safe; try again shortly.';
    }
    if (
        normalized.includes('network') ||
        normalized.includes('fetch') ||
        normalized.includes('unavailable')
    ) {
        return 'The chess provider is temporarily unavailable. Your existing games are unchanged.';
    }
    return 'The latest update did not finish. Your existing games are unchanged.';
}

type ExtendedSyncStatus = SyncStatus & {
    automation?: {
        policy?: {
            enabled: boolean;
        };
        backlog?: {
            eligible: number;
            eligibleAtLeast?: number;
            waitingForCredits: number;
            waitingForCreditsAtLeast?: number;
            blockedReason: string | null;
            queued: number;
            running: number;
            terminalFailed: number;
            countsExact?: boolean;
            scannedCandidates?: number;
            scanLimit?: number;
        };
        capacity?: {
            reservableCredits: number;
            reservableGames: number;
            creditsPerGame: number;
            currentBalance: number;
            creditReserve: number;
            dailyRemaining: number | null;
            monthlyRemaining: number | null;
            planMonthlyRemaining: number;
            blockingReason: string | null;
        };
    };
};

function enabledLinkedProviders(status: SyncStatus) {
    const providers: Array<'lichess' | 'chesscom'> = [];
    const providerEnabled = (provider: 'lichess' | 'chesscom') =>
        status.gameAutomation?.paused !== true &&
        Object.values(status.gameAutomation?.rules[provider] ?? {}).some(
            (mode) => mode !== 'IGNORE'
        );
    if (
        status.linked.lichessUsername &&
        providerEnabled('lichess')
    ) {
        providers.push('lichess');
    }
    if (
        status.linked.chesscomUsername &&
        providerEnabled('chesscom')
    ) {
        providers.push('chesscom');
    }
    return providers;
}

function allLinkedProviders(status: SyncStatus) {
    const providers: Array<'lichess' | 'chesscom'> = [];
    if (status.linked.lichessUsername) providers.push('lichess');
    if (status.linked.chesscomUsername) providers.push('chesscom');
    return providers;
}

export function SyncGamesWidget({
    context,
    enableAnalyze = true,
    variant: _variant = 'button',
    syncIsPrimary = false,
    initialOwnerId,
    initialStatus,
}: {
    context: 'home' | 'games';
    enableAnalyze?: boolean;
    variant?: 'button' | 'banner';
    syncIsPrimary?: boolean;
    initialOwnerId?: string;
    initialStatus?: ExtendedSyncStatus | null;
}) {
    const { data: session, status: sessionState } = useSession();
    const ownerId =
        sessionState === 'unauthenticated'
            ? null
            : (session?.user?.id ?? initialOwnerId ?? null);
    const hasServerInitial = initialOwnerId !== undefined;
    const router = useRouter();
    const [historyOpen, setHistoryOpen] = useState(false);
    const [analyzeOpen, setAnalyzeOpen] = useState(false);
    const [analyzeReturnFocus, setAnalyzeReturnFocus] =
        useState<HTMLElement | null>(null);
    const [status, setStatus] = useState<ExtendedSyncStatus | null>(
        initialStatus ?? null
    );
    const [statusOwnerId, setStatusOwnerId] = useState<string | null>(
        initialOwnerId ?? initialStatus?.ownerId ?? null
    );
    const [statusState, setStatusState] = useState<
        'loading' | 'ready' | 'error'
    >(hasServerInitial ? (initialStatus ? 'ready' : 'error') : 'loading');
    const [syncFeedback, setSyncFeedback] = useState<SyncFeedback>({
        ownerId: null,
        action: 'idle',
        message: '',
    });
    const openAnalyze = useCallback(
        (event: MouseEvent<HTMLButtonElement>) => {
            setAnalyzeReturnFocus(event.currentTarget);
            setAnalyzeOpen(true);
        },
        []
    );
    const appOpenAttemptedFor = useRef<string | null>(null);
    const completionControllerRef = useRef<AbortController | null>(null);
    const statusControllerRef = useRef<AbortController | null>(null);
    const syncRequestControllerRef = useRef<AbortController | null>(null);
    const statusGenerationRef = useRef(0);
    const ownerEpochRef = useRef<OwnerEpoch>({
        ownerId: null,
        generation: 0,
    });
    ownerEpochRef.current = advanceOwnerEpoch(
        ownerEpochRef.current,
        ownerId
    );

    const refreshStatus = useCallback(async () => {
        if (!ownerId) return;
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run) return;
        statusControllerRef.current?.abort();
        const controller = new AbortController();
        statusControllerRef.current = controller;
        const generation = statusGenerationRef.current + 1;
        statusGenerationRef.current = generation;
        const isCurrent = () =>
            !controller.signal.aborted &&
            generation === statusGenerationRef.current &&
            isOwnerRunCurrent(run, ownerEpochRef.current);
        try {
            const next = (await getSyncStatus({
                ownerId: run.ownerId,
                signal: controller.signal,
            })) as ExtendedSyncStatus;
            if (!isCurrent()) return;
            setStatus(next);
            setStatusOwnerId(run.ownerId);
            setStatusState('ready');
        } catch {
            if (!isCurrent()) return;
            setStatusOwnerId(run.ownerId);
            setStatusState('error');
        } finally {
            if (statusControllerRef.current === controller) {
                statusControllerRef.current = null;
            }
        }
    }, [ownerId]);

    const monitorSyncCompletion = useCallback(
        async (
            result: IncrementalSyncResult,
            run: OwnerRunToken,
            options?: { silent?: boolean }
        ) => {
            if (!isOwnerRunCurrent(run, ownerEpochRef.current)) return;
            const jobIds = result.providers.flatMap((provider) =>
                provider.jobId ? [provider.jobId] : []
            );
            if (jobIds.length === 0) return;

            completionControllerRef.current?.abort();
            const controller = new AbortController();
            completionControllerRef.current = controller;
            try {
                const completion = await waitForIncrementalSyncJobs({
                    ownerId: run.ownerId,
                    jobIds,
                    initialActivity: result.activity,
                    signal: controller.signal,
                });
                if (
                    controller.signal.aborted ||
                    !isOwnerRunCurrent(run, ownerEpochRef.current)
                ) {
                    return;
                }

                if (completion.timedOut) {
                    const awaitingWorker = result.providers.some(
                        (provider) => provider.state === 'awaiting-worker'
                    );
                    setSyncFeedback({
                        ownerId: run.ownerId,
                        action: awaitingWorker ? 'error' : 'success',
                        message: awaitingWorker
                            ? 'Sync is queued, but the background worker could not be notified yet. Retry Sync now.'
                            : 'Sync is still running in the background. You can keep using Backranq.',
                    });
                    await refreshStatus();
                    return;
                }

                const imported = completion.createdCount;
                const providerStartFailures = result.providers.filter(
                    (provider) => provider.state === 'failed'
                ).length;
                if (
                    providerStartFailures > 0 ||
                    completion.failed > 0 ||
                    completion.cancelled > 0
                ) {
                    setSyncFeedback({
                        ownerId: run.ownerId,
                        action: 'error',
                        message:
                            imported > 0
                            ? `Sync imported ${imported} new game${imported === 1 ? '' : 's'}, but one source needs attention.`
                            : 'Sync finished, but one source needs attention.',
                    });
                } else if (!options?.silent || imported > 0) {
                    setSyncFeedback({
                        ownerId: run.ownerId,
                        action: 'success',
                        message:
                            imported > 0
                            ? `Sync complete — ${imported} new game${imported === 1 ? '' : 's'} imported.`
                            : 'Sync complete — your library is up to date.',
                    });
                } else {
                    setSyncFeedback({
                        ownerId: run.ownerId,
                        action: 'idle',
                        message: '',
                    });
                }

                publishLibraryChanged(run.ownerId, {
                    invalidateCompletion: imported > 0,
                });
                await refreshStatus();
                if (isOwnerRunCurrent(run, ownerEpochRef.current)) {
                    router.refresh();
                }
            } catch (error) {
                if (
                    controller.signal.aborted ||
                    !isOwnerRunCurrent(run, ownerEpochRef.current)
                ) {
                    return;
                }
                setSyncFeedback({
                    ownerId: run.ownerId,
                    action: 'error',
                    message:
                        friendlySyncError(
                            error instanceof Error ? error.message : null
                        ),
                });
            } finally {
                if (completionControllerRef.current === controller) {
                    completionControllerRef.current = null;
                }
            }
        },
        [refreshStatus, router]
    );

    useEffect(() => {
        return () => {
            completionControllerRef.current?.abort();
            statusControllerRef.current?.abort();
            syncRequestControllerRef.current?.abort();
        };
    }, [ownerId]);

    useEffect(() => {
        if (initialOwnerId === undefined) return;
        if (initialStatus) primeSyncStatusSnapshot(initialStatus);
        setStatus(initialStatus ?? null);
        setStatusOwnerId(initialOwnerId);
        setStatusState(initialStatus ? 'ready' : 'error');
    }, [initialOwnerId, initialStatus]);

    useEffect(() => {
        if (!ownerId) return;
        if (initialOwnerId === ownerId) return;
        void refreshStatus();
        return () => {
            statusGenerationRef.current += 1;
            statusControllerRef.current?.abort();
        };
    }, [initialOwnerId, ownerId, refreshStatus]);

    const currentStatus = statusOwnerId === ownerId ? status : null;
    const currentStatusState =
        statusOwnerId === ownerId ? statusState : 'loading';
    const hasLinked =
        !!currentStatus?.linked.lichessUsername ||
        !!currentStatus?.linked.chesscomUsername;
    const syncAction =
        syncFeedback.ownerId === ownerId ? syncFeedback.action : 'idle';
    const syncMessage =
        syncFeedback.ownerId === ownerId ? syncFeedback.message : '';

    useEffect(() => {
        if (
            !ownerId ||
            !currentStatus ||
            !hasLinked ||
            currentStatus.gameAutomation?.paused === true ||
            appOpenAttemptedFor.current === ownerId
        ) {
            return;
        }
        const providers = enabledLinkedProviders(currentStatus);
        if (providers.length === 0) return;
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run) return;
        const controller = new AbortController();
        appOpenAttemptedFor.current = ownerId;
        const key = `backranq.app-open-sync:${encodeURIComponent(ownerId)}`;
        try {
            const lastAttempt = Number(sessionStorage.getItem(key) ?? 0);
            if (
                Number.isFinite(lastAttempt) &&
                Date.now() - lastAttempt < 60 * 60 * 1000
            ) {
                return;
            }
            sessionStorage.setItem(key, String(Date.now()));
        } catch {
            // The endpoint is idempotent and enforces staleness even when
            // sessionStorage is unavailable.
        }

        void requestIncrementalSync({
            ownerId: run.ownerId,
            providers,
            onlyIfStaleMinutes: 60,
            signal: controller.signal,
        })
            // App-open sync is a fire-and-forget background hint. Foreground
            // job polling is reserved for an explicit Sync now action.
            .catch(() => {
                // App-open sync is deliberately silent. Manual Sync now
                // remains available and reports errors.
            });
        return () => {
            controller.abort();
        };
    }, [
        currentStatus,
        hasLinked,
        ownerId,
    ]);

    async function syncNow() {
        if (!currentStatus || syncAction === 'syncing') return;
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run) return;
        syncRequestControllerRef.current?.abort();
        const controller = new AbortController();
        syncRequestControllerRef.current = controller;
        setSyncFeedback({
            ownerId: run.ownerId,
            action: 'syncing',
            message: 'Checking linked sources for new games…',
        });
        try {
            const result = await requestIncrementalSync({
                ownerId: run.ownerId,
                providers: allLinkedProviders(currentStatus),
                signal: controller.signal,
            });
            if (!isOwnerRunCurrent(run, ownerEpochRef.current)) return;
            setSyncFeedback({
                ownerId: run.ownerId,
                action:
                    result.state === 'failed' ||
                    result.state === 'partial' ||
                    result.state === 'awaiting-worker'
                    ? 'error'
                    : result.providers.some((provider) => provider.jobId)
                      ? 'syncing'
                      : 'success',
                message: result.message,
            });
            if (result.providers.some((provider) => provider.jobId)) {
                if (!isOwnerRunCurrent(run, ownerEpochRef.current)) return;
                void monitorSyncCompletion(result, run);
            } else {
                await refreshStatus();
                if (isOwnerRunCurrent(run, ownerEpochRef.current)) {
                    router.refresh();
                }
            }
        } catch (error) {
            if (
                controller.signal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return;
            }
            if (!isOwnerRunCurrent(run, ownerEpochRef.current)) return;
            setSyncFeedback({
                ownerId: run.ownerId,
                action: 'error',
                message:
                        friendlySyncError(
                            error instanceof Error ? error.message : null
                        ),
            });
        } finally {
            if (syncRequestControllerRef.current === controller) {
                syncRequestControllerRef.current = null;
            }
        }
    }

    if (currentStatusState === 'loading') {
        return (
            <div className="text-sm text-muted-foreground" role="status">
                Checking linked chess accounts…
            </div>
        );
    }

    if (currentStatusState === 'error') {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                    Could not load source sync status.
                </div>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                        setStatusState('loading');
                        void refreshStatus();
                    }}
                >
                    Try again
                </Button>
            </div>
        );
    }

    if (!currentStatus || !hasLinked) {
        return (
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 text-sm text-muted-foreground">
                    Link Lichess or Chess.com to keep your game library up to
                    date.
                </div>
                <Button asChild size="sm" variant="outline">
                    <Link href="/settings" prefetch={false}>Connect account</Link>
                </Button>
            </div>
        );
    }

    const providerStates = currentStatus.gameAutomation?.states;
    const latestActivity = mostRecentProviderActivity([
        providerStates?.lichess?.lastSuccessAt,
        providerStates?.chesscom?.lastSuccessAt,
    ]);
    const providerError =
        providerStates?.lichess?.lastError ??
        providerStates?.chesscom?.lastError ??
        null;
    const inventoryCounts = {
        total: currentStatus.inventory.totalImported,
        unanalyzed: currentStatus.inventory.unanalyzed,
    };
    const backlog = currentStatus.automation?.backlog;
    const queued =
        backlog?.queued ?? currentStatus.analysisJobs?.queued ?? 0;
    const analyzing =
        backlog?.running ?? currentStatus.analysisJobs?.running ?? 0;
    const failed =
        backlog?.terminalFailed ?? currentStatus.analysisJobs?.failed ?? 0;
    const ready = currentStatus.inventory.analyzed;
    const rawBlockedReason =
        backlog?.blockedReason ??
        currentStatus.automation?.capacity?.blockingReason ??
        null;
    const blockedReason =
        humanizeAutomationBlockReason(rawBlockedReason) ??
        currentStatus.billing?.limitingReason ??
        null;
    const blockedAction = automationBlockAction(rawBlockedReason);
    const automationDisabled =
        rawBlockedReason === 'disabled' ||
        currentStatus.automation?.policy?.enabled === false;
    const waitingForCredits =
        (backlog?.countsExact === false
            ? backlog.waitingForCreditsAtLeast
            : backlog?.waitingForCredits) ?? 0;
    const isAnalysisBlocked =
        !automationDisabled &&
        ((waitingForCredits > 0 &&
            isCreditOrCapBlockReason(rawBlockedReason)) ||
        ((inventoryCounts?.unanalyzed ?? 0) > 0 &&
            (currentStatus.automation?.capacity?.reservableGames ??
                currentStatus.billing?.reservableGames) === 0));
    const waitingForCreditsIsExact =
        backlog?.countsExact !== false;

    return (
        <>
            <section
                className="min-w-0 space-y-3"
                aria-label="Game sources and analysis status"
                data-variant={_variant}
            >
                <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                        <Cloud
                            className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                                {currentStatus.linked.lichessUsername ? (
                                    <Badge variant="secondary">Lichess</Badge>
                                ) : null}
                                {currentStatus.linked.chesscomUsername ? (
                                    <Badge variant="secondary">Chess.com</Badge>
                                ) : null}
                                <span className="text-xs text-muted-foreground">
                                    {currentStatus.gameAutomation?.paused === true
                                        ? 'Automatic updates off'
                                        : formatSyncTime(latestActivity)}
                                </span>
                            </div>
                            {providerError ? (
                                <p className="mt-1 break-words text-xs text-destructive">
                                    {friendlySyncError(providerError)}
                                </p>
                            ) : null}
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                            type="button"
                            size="sm"
                            variant={syncIsPrimary ? 'default' : 'outline'}
                            disabled={syncAction === 'syncing'}
                            onClick={() => void syncNow()}
                        >
                            <RefreshCw
                                className={`mr-1.5 h-3.5 w-3.5 ${
                                    syncAction === 'syncing'
                                        ? 'animate-spin'
                                        : ''
                                }`}
                                aria-hidden="true"
                            />
                            Sync now
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setHistoryOpen(true)}
                        >
                            Import older games
                        </Button>
                    </div>
                </div>

                <div
                    className="sr-only"
                    role={syncAction === 'error' ? 'alert' : 'status'}
                    aria-live="polite"
                >
                    {syncMessage}
                </div>
                {syncAction !== 'idle' && syncMessage ? (
                    <div
                        className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                            syncAction === 'error'
                                ? 'border-destructive/40 text-destructive'
                                : 'text-muted-foreground'
                        }`}
                    >
                        {syncAction === 'syncing' ? (
                            <Clock3
                                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                aria-hidden="true"
                            />
                        ) : syncAction === 'error' ? (
                            <AlertCircle
                                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                aria-hidden="true"
                            />
                        ) : (
                            <CheckCircle2
                                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                                aria-hidden="true"
                            />
                        )}
                        <span>{syncMessage}</span>
                    </div>
                ) : null}

                {context === 'games' ? (
                    <div className="space-y-2 border-t pt-3">
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                                <span>
                                    Imported{' '}
                                    <strong className="text-foreground">
                                        {inventoryCounts?.total ?? '—'}
                                    </strong>
                                </span>
                                <span>
                                    Ready{' '}
                                    <strong className="text-foreground">
                                        {ready ?? '—'}
                                    </strong>
                                </span>
                                <span>
                                    Queued{' '}
                                    <strong className="text-foreground">
                                        {queued}
                                    </strong>
                                </span>
                                {waitingForCredits > 0 ? (
                                    <span>
                                        Waiting for credits{' '}
                                        <strong className="text-foreground">
                                            {waitingForCredits}
                                            {waitingForCreditsIsExact
                                                ? ''
                                                : '+'}
                                        </strong>
                                    </span>
                                ) : null}
                                <span>
                                    Analyzing{' '}
                                    <strong className="text-foreground">
                                        {analyzing}
                                    </strong>
                                </span>
                                <span>
                                    Failed{' '}
                                    <strong
                                        className={
                                            failed > 0
                                                ? 'text-destructive'
                                                : 'text-foreground'
                                        }
                                    >
                                        {failed}
                                    </strong>
                                </span>
                        </div>

                        {isAnalysisBlocked ? (
                            <div className="flex flex-col gap-2 rounded-md bg-muted/60 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <div className="font-medium">
                                        Automatic analysis is paused
                                    </div>
                                    <div className="break-words text-xs text-muted-foreground">
                                        {blockedReason ??
                                            'No server credits are currently available.'}
                                        {' '}Imported games are safe and sync will
                                        continue.
                                    </div>
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-1.5">
                                    {enableAnalyze ? (
                                        <Button
                                            type="button"
                                            size="sm"
                                            variant="secondary"
                                            onClick={openAnalyze}
                                        >
                                            Analyze free in browser
                                        </Button>
                                    ) : null}
                                    <Button asChild size="sm" variant="outline">
                                        <Link href={blockedAction.href} prefetch={false}>
                                            {blockedAction.label}
                                        </Link>
                                    </Button>
                                </div>
                            </div>
                        ) : inventoryCounts &&
                          inventoryCounts.unanalyzed > 0 &&
                          enableAnalyze ? (
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                    {inventoryCounts.unanalyzed} imported game
                                    {inventoryCounts.unanalyzed === 1 ? '' : 's'}{' '}
                                    still need analysis.
                                    {automationDisabled
                                        ? ' Automatic server analysis is off.'
                                        : ''}
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        onClick={openAnalyze}
                                    >
                                        Analyze free in browser
                                    </Button>
                                    {automationDisabled ? (
                                        <Button
                                            asChild
                                            size="sm"
                                            variant="outline"
                                        >
                                            <Link href="/settings#game-automation" prefetch={false}>
                                                Manage automation
                                            </Link>
                                        </Button>
                                    ) : null}
                                </div>
                            </div>
                        ) : null}
                    </div>
                ) : null}
            </section>

            {historyOpen ? (
                <SyncGamesModal
                    open
                    onClose={() => setHistoryOpen(false)}
                    context={context}
                    enableAnalyze={enableAnalyze}
                    onFinished={() => {
                        router.refresh();
                        void refreshStatus();
                    }}
                />
            ) : null}

            {analyzeOpen ? (
                <AnalyzeGamesModal
                    open
                    onClose={() => setAnalyzeOpen(false)}
                    title="Analyze imported games"
                    returnFocusElement={analyzeReturnFocus}
                />
            ) : null}
        </>
    );
}
