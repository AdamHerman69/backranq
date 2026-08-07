'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';
import {
    enqueueServerAnalysisJobs,
    fetchHistoricalGames,
    getSyncStatus,
    saveHistoricalGamesToLibrary,
    unresolvedHistoryPageGameCount,
    type HistoryImportAllowance,
    type HistoryImportTruncatedReason,
    type HistoricalGameFilters,
    type SyncProvider,
    type SyncStatus,
} from '@/lib/services/gameSync';
import { parseExternalId } from '@/lib/api/games';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/multi-select';
import { ActionConfirmDialog } from '@/components/ui/ActionConfirmDialog';
import {
    createServerAnalysisBatch,
    clearLastAnalysisCompletion,
    mergeServerAnalysisBatches,
    publishLibraryChanged,
    readServerAnalysisBatch,
    writeServerAnalysisBatch,
} from '@/lib/analysis/analysisCompletion';
import {
    advanceOwnerEpoch,
    captureOwnerRun,
    isOwnerRunCurrent,
    type OwnerEpoch,
    type OwnerRunToken,
} from '@/lib/auth/ownerRun';

type Step = 'config' | 'review' | 'saving' | 'done';
type OperationPhase =
    | 'idle'
    | 'fetching'
    | 'preparing-save'
    | 'committing';

type FetchedRow = {
    game: NormalizedGame;
    ticket: string;
    provider: SyncProvider;
    externalId: string;
    isNew: boolean;
    selected: boolean;
};

type SyncRunSummary = {
    selected: number;
    imported: number;
    duplicates: number;
    failed: number;
    capRejected: number;
    browserRequested: number;
    serverQueued: number;
    serverSkipped: number;
    analysisError: string | null;
    providerErrors: Array<{ provider: SyncProvider; error: string }>;
};

export function SyncGamesModal({
    open,
    onClose,
    context = 'games',
    enableAnalyze = true,
    onFinished,
}: {
    open: boolean;
    onClose: () => void;
    context?: 'home' | 'games';
    enableAnalyze?: boolean;
    onFinished?: () => void;
}) {
    const { data: session } = useSession();
    const ownerId = session?.user?.id ?? null;
    const ownerEpochRef = useRef<OwnerEpoch>({
        ownerId: null,
        generation: 0,
    });
    ownerEpochRef.current = advanceOwnerEpoch(
        ownerEpochRef.current,
        ownerId
    );
    const [step, setStep] = useState<Step>('config');
    const [busy, setBusy] = useState(false);
    const [operationPhase, setOperationPhase] =
        useState<OperationPhase>('idle');
    const operationControllerRef = useRef<AbortController | null>(null);
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [statusOwnerId, setStatusOwnerId] = useState<string | null>(null);
    const [statusLoading, setStatusLoading] = useState(true);
    const [statusError, setStatusError] = useState<string | null>(null);

    const [providers, setProviders] = useState<{ lichess: boolean; chesscom: boolean }>(
        { lichess: true, chesscom: true }
    );
    const [filters, setFilters] = useState<HistoricalGameFilters>({
        timeClasses: [],
        rated: 'any',
        since: undefined,
        until: undefined,
    });
    const timeClassOptions: MultiSelectOption[] = useMemo(
        () => [
            { value: 'bullet', label: 'Bullet' },
            { value: 'blitz', label: 'Blitz' },
            { value: 'rapid', label: 'Rapid' },
            { value: 'classical', label: 'Classical' },
        ],
        []
    );
    const [allowances, setAllowances] = useState<
        Record<SyncProvider, HistoryImportAllowance | null>
    >({ lichess: null, chesscom: null });
    const [existingCounts, setExistingCounts] = useState<
        Record<SyncProvider, number>
    >({ lichess: 0, chesscom: 0 });
    const [truncatedReasons, setTruncatedReasons] = useState<
        Record<SyncProvider, HistoryImportTruncatedReason>
    >({ lichess: null, chesscom: null });
    const [historyCursors, setHistoryCursors] = useState<
        Record<SyncProvider, string | null>
    >({ lichess: null, chesscom: null });
    const [historyPages, setHistoryPages] = useState<
        Record<SyncProvider, number>
    >({ lichess: 1, chesscom: 1 });
    const [analyzeInBrowserAfter, setAnalyzeInBrowserAfter] = useState(false);
    const [queueServerAnalysisAfter, setQueueServerAnalysisAfter] = useState(false);
    const [rows, setRows] = useState<FetchedRow[]>([]);
    const [providerErrors, setProviderErrors] = useState<
        Array<{ provider: SyncProvider; error: string }>
    >([]);
    const [runSummary, setRunSummary] = useState<SyncRunSummary | null>(null);
    const [serverReviewOpen, setServerReviewOpen] = useState(false);
    const [continueReviewOpen, setContinueReviewOpen] = useState(false);

    useEffect(() => {
        if (!open || !ownerId) return;
        let cancelled = false;
        const statusController = new AbortController();
        backgroundAnalysis.setOwner(ownerId);
        setStep('config');
        setRows([]);
        setAnalyzeInBrowserAfter(false);
        setQueueServerAnalysisAfter(false);
        setBusy(false);
        operationControllerRef.current?.abort();
        operationControllerRef.current = null;
        setOperationPhase('idle');
        setProviderErrors([]);
        setAllowances({ lichess: null, chesscom: null });
        setExistingCounts({ lichess: 0, chesscom: 0 });
        setTruncatedReasons({ lichess: null, chesscom: null });
        setHistoryCursors({ lichess: null, chesscom: null });
        setHistoryPages({ lichess: 1, chesscom: 1 });
        setRunSummary(null);
        setServerReviewOpen(false);
        setContinueReviewOpen(false);
        setStatusLoading(true);
        setStatusError(null);

        getSyncStatus({ signal: statusController.signal })
            .then((s) => {
                if (cancelled) return;
                if (s.ownerId !== ownerId) {
                    throw new Error(
                        'The server returned source status for a different account.'
                    );
                }
                setStatus(s);
                setStatusOwnerId(ownerId);
                setStatusLoading(false);
                // default providers based on linked usernames
                setProviders({
                    lichess: !!s.linked.lichessUsername,
                    chesscom: !!s.linked.chesscomUsername,
                });
            })
            .catch((error) => {
                if (cancelled) return;
                setStatusLoading(false);
                setStatusOwnerId(ownerId);
                setStatusError(
                    error instanceof Error
                        ? error.message
                        : 'Could not load linked account status'
                    );
            });
        return () => {
            cancelled = true;
            statusController.abort();
            operationControllerRef.current?.abort();
            operationControllerRef.current = null;
        };
    }, [open, ownerId]);

    const enabledProviders = useMemo(() => {
        const list: SyncProvider[] = [];
        if (providers.lichess) list.push('lichess');
        if (providers.chesscom) list.push('chesscom');
        return list;
    }, [providers]);
    const currentStatus = statusOwnerId === ownerId ? status : null;
    const currentStatusLoading =
        statusOwnerId !== ownerId || statusLoading;
    const currentStatusError =
        statusOwnerId === ownerId ? statusError : null;
    const currentStep = statusOwnerId === ownerId ? step : 'config';

    const selectedCount = useMemo(
        () => rows.filter((r) => r.selected && r.isNew).length,
        [rows]
    );
    const newCount = useMemo(() => rows.filter((r) => r.isNew).length, [rows]);
    const dupCount = existingCounts.lichess + existingCounts.chesscom;

    if (!open || !ownerId) return null;

    function runIsCurrent(run: OwnerRunToken) {
        return isOwnerRunCurrent(run, ownerEpochRef.current);
    }

    function beginAbortableOperation(
        phase: Extract<OperationPhase, 'fetching' | 'preparing-save'>
    ) {
        operationControllerRef.current?.abort();
        const controller = new AbortController();
        operationControllerRef.current = controller;
        setOperationPhase(phase);
        return controller;
    }

    function finishAbortableOperation(controller: AbortController) {
        if (operationControllerRef.current === controller) {
            operationControllerRef.current = null;
            setOperationPhase('idle');
        }
    }

    const operationCanCancel =
        operationPhase === 'fetching' ||
        operationPhase === 'preparing-save';
    const closeProtected = busy && !operationCanCancel;

    function close() {
        if (closeProtected) return;
        if (operationCanCancel) {
            operationControllerRef.current?.abort();
            operationControllerRef.current = null;
            setOperationPhase('idle');
        }
        onClose();
    }

    async function fetchStep(
        cursorOverrides?: Partial<Record<SyncProvider, string | null>>
    ) {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        if (!currentStatus) {
            toast.error('Missing sync status');
            return;
        }
        const continuing = cursorOverrides !== undefined;
        const providersToFetch = continuing
            ? enabledProviders.filter(
                  (provider) => !!cursorOverrides[provider]
              )
            : enabledProviders;
        if (providersToFetch.length === 0) {
            toast.error('Select at least one provider');
            return;
        }

        // need linked usernames for each provider
        for (const p of providersToFetch) {
            const u =
                p === 'lichess'
                    ? currentStatus.linked.lichessUsername
                    : currentStatus.linked.chesscomUsername;
            if (!u) {
                toast.error(`Link your ${p} username in Settings first.`);
                return;
            }
        }

        setBusy(true);
        const controller = beginAbortableOperation('fetching');
        const toastId = toast.loading('Fetching games…');
        try {
            const nextRows: FetchedRow[] = [];
            const failures: Array<{ provider: SyncProvider; error: string }> = [];
            const nextAllowances: Record<
                SyncProvider,
                HistoryImportAllowance | null
            > = continuing
                ? { ...allowances }
                : { lichess: null, chesscom: null };
            const nextExistingCounts: Record<SyncProvider, number> = {
                lichess: 0,
                chesscom: 0,
            };
            const nextTruncatedReasons: Record<
                SyncProvider,
                HistoryImportTruncatedReason
            > = { lichess: null, chesscom: null };
            const nextCursors: Record<SyncProvider, string | null> =
                continuing
                    ? { ...historyCursors }
                    : { lichess: null, chesscom: null };
            const nextPages: Record<SyncProvider, number> = continuing
                ? { ...historyPages }
                : { lichess: 1, chesscom: 1 };
            for (const p of providersToFetch) {
                try {
                    const snapshot = await fetchHistoricalGames({
                        ownerId: run.ownerId,
                        provider: p,
                        filters,
                        cursor: cursorOverrides?.[p] ?? undefined,
                        signal: controller.signal,
                    });
                    if (!runIsCurrent(run)) return;
                    nextAllowances[p] = snapshot.allowance;
                    nextExistingCounts[p] = snapshot.existingCount;
                    nextTruncatedReasons[p] = snapshot.truncatedReason;
                    nextCursors[p] = snapshot.nextCursor;
                    nextPages[p] = snapshot.page;
                    for (const row of snapshot.rows) {
                        const game = row.game;
                        nextRows.push({
                            game,
                            ticket: row.ticket,
                            provider: p,
                            externalId: parseExternalId(game),
                            isNew: true,
                            selected: true,
                        });
                    }
                } catch (error) {
                    if (
                        controller.signal.aborted ||
                        (error instanceof Error &&
                            error.name === 'AbortError')
                    ) {
                        throw error;
                    }
                    if (!runIsCurrent(run)) return;
                    failures.push({
                        provider: p,
                        error:
                            error instanceof Error
                                ? error.message
                                : `Failed to fetch ${p} games`,
                    });
                }
            }

            if (!runIsCurrent(run)) return;
            if (failures.length === providersToFetch.length) {
                throw new Error(
                    failures.map((failure) => failure.error).join(' ')
                );
            }
            // newest first
            nextRows.sort((a, b) => +new Date(b.game.playedAt) - +new Date(a.game.playedAt));
            setRows(nextRows);
            setProviderErrors(failures);
            setAllowances(nextAllowances);
            setExistingCounts(nextExistingCounts);
            setTruncatedReasons(nextTruncatedReasons);
            setHistoryCursors(nextCursors);
            setHistoryPages(nextPages);

            if (failures.length > 0) {
                toast.warning(
                    `Fetched ${nextRows.length} games. ${failures.length} provider${failures.length === 1 ? '' : 's'} need attention.`,
                    { id: toastId }
                );
            } else {
                toast.success(`Fetched ${nextRows.length} games`, { id: toastId });
            }
            setRunSummary(null);
            setStep('review');
        } catch (e) {
            if (
                controller.signal.aborted ||
                (e instanceof Error && e.name === 'AbortError')
            ) {
                toast.dismiss(toastId);
                return;
            }
            if (!runIsCurrent(run)) return;
            toast.error(e instanceof Error ? e.message : 'Fetch failed', { id: toastId });
        } finally {
            finishAbortableOperation(controller);
            if (runIsCurrent(run)) {
                setBusy(false);
            } else {
                toast.dismiss(toastId);
            }
        }
    }

    async function saveStep(existingRun?: OwnerRunToken) {
        const run = existingRun ?? captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        const toSave = rows.filter((r) => r.isNew && r.selected);
        if (toSave.length === 0) {
            toast.message('No new games selected');
            return;
        }

        setStep('saving');
        setBusy(true);
        operationControllerRef.current?.abort();
        operationControllerRef.current = null;
        setOperationPhase('committing');
        const toastId = toast.loading('Saving games…');
        try {
            const res = await saveHistoricalGamesToLibrary({
                ownerId: run.ownerId,
                items: toSave.map((row) => ({
                    game: row.game,
                    ticket: row.ticket,
                })),
            });
            if (!runIsCurrent(run)) return;
            const summary: SyncRunSummary = {
                selected: toSave.length,
                imported: res.imported,
                duplicates: dupCount + res.duplicates,
                failed: res.failed,
                capRejected: res.capRejected,
                browserRequested: 0,
                serverQueued: 0,
                serverSkipped: 0,
                analysisError: null,
                providerErrors: [...providerErrors],
            };
            setAllowances((current) => ({
                ...current,
                ...res.allowances,
            }));
            clearLastAnalysisCompletion(run.ownerId);
            if (res.failed > 0 || res.duplicates > 0) {
                toast.warning(
                    `Imported ${res.imported} of ${toSave.length} selected games.`,
                    { id: toastId }
                );
            } else {
                toast.success(`Imported ${res.imported} games`, { id: toastId });
            }

            if (enableAnalyze && (analyzeInBrowserAfter || queueServerAnalysisAfter)) {
                const dbIds = Object.values(res.ids ?? {}).filter(Boolean);
                if (dbIds.length > 0 && analyzeInBrowserAfter) {
                    if (!runIsCurrent(run)) return;
                    backgroundAnalysis.enqueueGameDbIds(run.ownerId, dbIds);
                    summary.browserRequested = dbIds.length;
                    toast.message(
                        `Browser analysis started for ${dbIds.length} game${dbIds.length === 1 ? '' : 's'}. Keep this tab open.`
                    );
                }
                if (dbIds.length > 0 && queueServerAnalysisAfter) {
                    try {
                        if (!runIsCurrent(run)) return;
                        const queued = await enqueueServerAnalysisJobs({ gameIds: dbIds });
                        if (!runIsCurrent(run)) return;
                        summary.serverQueued = queued.queued;
                        summary.serverSkipped =
                            queued.skipped + (queued.errors?.length ?? 0);
                        if (queued.queued > 0) {
                            const incomingBatch = createServerAnalysisBatch({
                                    ownerId: run.ownerId,
                                    queued: queued.queued,
                                    jobIds: (queued.jobs ?? [])
                                        .filter(
                                            (job) =>
                                                job.acceptedInBatch === true
                                        )
                                        .map((job) => job.id),
                                    failedAtStart:
                                        currentStatus?.analysisJobs?.failed ?? 0,
                                    trainingMomentsAtStart: null,
                                    pendingAtStart: null,
                                });
                            const batch = mergeServerAnalysisBatches(
                                readServerAnalysisBatch(run.ownerId),
                                incomingBatch
                            );
                            if (!runIsCurrent(run)) return;
                            writeServerAnalysisBatch(run.ownerId, batch);
                        }
                        if (summary.serverSkipped > 0) {
                            toast.warning(
                                `Queued ${queued.queued} games; ${summary.serverSkipped} could not be queued.`
                            );
                        } else {
                            toast.message(
                                `Queued ${queued.queued} game${queued.queued === 1 ? '' : 's'} for server analysis.`
                            );
                        }
                    } catch (error) {
                        if (!runIsCurrent(run)) return;
                        summary.analysisError =
                            error instanceof Error
                                ? error.message
                                : 'Failed to queue server analysis';
                        toast.error(
                            `Games were imported, but server analysis was not queued: ${summary.analysisError}`
                        );
                    }
                }
            }

            if (!runIsCurrent(run)) return;
            setRunSummary(summary);
            setStep('done');
            publishLibraryChanged(run.ownerId, { invalidateCompletion: true });
            onFinished?.();
        } catch (e) {
            if (!runIsCurrent(run)) return;
            toast.error(e instanceof Error ? e.message : 'Save failed', { id: toastId });
            setStep('review');
        } finally {
            setOperationPhase('idle');
            if (runIsCurrent(run)) {
                setBusy(false);
            } else {
                toast.dismiss(toastId);
            }
        }
    }

    function toggleAllNew(v: boolean) {
        setRows((prev) =>
            prev.map((r) => (r.isNew ? { ...r, selected: v } : r))
        );
    }

    const hasOlderHistoryPage =
        historyCursors.lichess !== null ||
        historyCursors.chesscom !== null;
    const unresolvedPageGames = runSummary
        ? unresolvedHistoryPageGameCount({
              newCount,
              selectedCount: runSummary.selected,
              failed: runSummary.failed,
          })
        : Math.max(0, newCount - selectedCount);

    function resetHistoryTraversal() {
        setHistoryCursors({ lichess: null, chesscom: null });
        setHistoryPages({ lichess: 1, chesscom: 1 });
        setRows([]);
        setRunSummary(null);
        setProviderErrors([]);
        setTruncatedReasons({ lichess: null, chesscom: null });
        setContinueReviewOpen(false);
        setStep('config');
    }

    async function continueHistoryTraversal() {
        setContinueReviewOpen(false);
        await fetchStep({ ...historyCursors });
    }

    function requestHistoryContinuation() {
        if (unresolvedPageGames > 0) {
            setContinueReviewOpen(true);
            return;
        }
        void continueHistoryTraversal();
    }

    async function prepareServerReview() {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        setServerReviewOpen(false);
        setBusy(true);
        const controller = beginAbortableOperation('preparing-save');
        try {
            const latestStatus = await getSyncStatus({
                signal: controller.signal,
            });
            if (!runIsCurrent(run)) return;
            if (latestStatus.ownerId !== run.ownerId) {
                throw new Error(
                    'The server returned credit capacity for a different account.'
                );
            }
            setStatus(latestStatus);
            setStatusOwnerId(run.ownerId);
            setServerReviewOpen(true);
        } catch (error) {
            if (
                controller.signal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return;
            }
            if (!runIsCurrent(run)) return;
            toast.error(
                error instanceof Error
                    ? error.message
                    : 'Could not verify server credit capacity'
                );
        } finally {
            finishAbortableOperation(controller);
            if (runIsCurrent(run)) setBusy(false);
        }
    }

    async function confirmServerImport() {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        setServerReviewOpen(false);
        setBusy(true);
        const controller = beginAbortableOperation('preparing-save');
        try {
            const latestStatus = await getSyncStatus({
                signal: controller.signal,
            });
            if (!runIsCurrent(run)) return;
            if (latestStatus.ownerId !== run.ownerId) {
                throw new Error(
                    'The server returned credit capacity for a different account.'
                );
            }
            setStatus(latestStatus);
            setStatusOwnerId(run.ownerId);
            const capacity = latestStatus.billing;
            if (!capacity || selectedCount > capacity.reservableGames) {
                toast.error(
                    capacity?.limitingReason ??
                        'Server credit capacity could not be verified.'
                );
                return;
            }
            finishAbortableOperation(controller);
            await saveStep(run);
            if (!runIsCurrent(run)) return;
        } catch (error) {
            if (
                controller.signal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return;
            }
            if (!runIsCurrent(run)) return;
            toast.error(
                error instanceof Error
                    ? error.message
                    : 'Could not verify server credit capacity'
            );
        } finally {
            finishAbortableOperation(controller);
            if (runIsCurrent(run)) setBusy(false);
        }
    }

    function retryFailedProviders() {
        const failed = runSummary?.providerErrors ?? [];
        setProviders({
            lichess: failed.some((item) => item.provider === 'lichess'),
            chesscom: failed.some((item) => item.provider === 'chesscom'),
        });
        setProviderErrors([]);
        setRows([]);
        setHistoryCursors({ lichess: null, chesscom: null });
        setHistoryPages({ lichess: 1, chesscom: 1 });
        setRunSummary(null);
        setStep('config');
    }

    const modalTitle = 'Import older games';

    return (
        <>
        <DialogPrimitive.Root
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) close();
            }}
        >
            <DialogPrimitive.Portal>
            <DialogPrimitive.Overlay
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 40,
                    background: 'rgba(0,0,0,0.45)',
                }}
            />
            <DialogPrimitive.Content
                data-context={context}
                style={{
                    position: 'fixed',
                    left: '50%',
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                    zIndex: 41,
                    width: 'min(980px, calc(100% - 32px))',
                    maxHeight: 'calc(100vh - 32px)',
                    overflow: 'auto',
                    // shadcn theme vars are HSL triplets; must wrap in hsl(...)
                    background: 'hsl(var(--card, 0 0% 100%))',
                    color: 'hsl(var(--card-foreground, 222.2 84% 4.9%))',
                    borderRadius: 12,
                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                    padding: 16,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                }}
                onEscapeKeyDown={(event) => {
                    if (closeProtected) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (closeProtected) event.preventDefault();
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <DialogPrimitive.Title style={{ fontWeight: 800 }}>
                        {modalTitle}
                    </DialogPrimitive.Title>
                    <button
                        type="button"
                        onClick={close}
                        disabled={closeProtected}
                        aria-disabled={closeProtected}
                        style={{
                            height: 30,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                            background: 'hsl(var(--background, 0 0% 100%))',
                            fontWeight: 700,
                            cursor: closeProtected ? 'not-allowed' : 'pointer',
                            opacity: closeProtected ? 0.5 : 1,
                        }}
                    >
                        {operationCanCancel ? 'Cancel' : 'Close'}
                    </button>
                </div>
                <DialogPrimitive.Description
                    style={{ fontSize: 12, opacity: 0.8 }}
                >
                    Add a bounded snapshot of up to 2,000 older games per
                    connected source. Syncing is free. Analysis is separate and
                    only server analysis uses credits.
                </DialogPrimitive.Description>

                {currentStep === 'config' ? (
                    <>
                        {currentStatusLoading ? (
                            <div role="status" style={{ fontSize: 12, opacity: 0.8 }}>
                                Checking linked accounts…
                            </div>
                        ) : null}
                        {currentStatusError ? (
                            <div
                                role="alert"
                                style={{
                                    border: '1px solid hsl(var(--destructive, 0 84.2% 60.2%) / 0.35)',
                                    borderRadius: 10,
                                    padding: 10,
                                    fontSize: 12,
                                }}
                            >
                                Source status unavailable: {currentStatusError}. Close and reopen
                                this dialog to retry.
                            </div>
                        ) : null}
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            Choose connected sources. We’ll find the most recent
                            older games and skip anything already in your
                            library. Use Sync now outside this dialog for future
                            games.
                        </div>

                        <div
                            style={{
                                display: 'grid',
                                gridTemplateColumns:
                                    'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
                                gap: 12,
                            }}
                        >
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={providers.lichess}
                                    disabled={!currentStatus?.linked.lichessUsername}
                                    onChange={(e) => setProviders((p) => ({ ...p, lichess: e.target.checked }))}
                                />
                                <span>
                                    Lichess
                                    {currentStatus?.linked.lichessUsername
                                        ? ` · up to 2,000 for ${currentStatus.linked.lichessUsername}`
                                        : ' · not connected'}
                                </span>
                            </label>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={providers.chesscom}
                                    disabled={!currentStatus?.linked.chesscomUsername}
                                    onChange={(e) => setProviders((p) => ({ ...p, chesscom: e.target.checked }))}
                                />
                                <span>
                                    Chess.com
                                    {currentStatus?.linked.chesscomUsername
                                        ? ` · up to 2,000 for ${currentStatus.linked.chesscomUsername}`
                                        : ' · not connected'}
                                </span>
                            </label>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Time class</span>
                                <MultiSelect
                                    options={timeClassOptions}
                                    value={filters.timeClasses}
                                    onChange={(next) =>
                                        setFilters((current) => ({
                                            ...current,
                                            timeClasses: next as TimeClass[],
                                        }))
                                    }
                                    placeholder="Any"
                                    searchPlaceholder="Search…"
                                    maxBadges={2}
                                    triggerClassName="h-9 text-xs"
                                />
                            </div>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Rated</span>
                                <select
                                    value={filters.rated}
                                    onChange={(event) =>
                                        setFilters((current) => ({
                                            ...current,
                                            rated: event.target
                                                .value as HistoricalGameFilters['rated'],
                                        }))
                                    }
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                >
                                    <option value="any">Any</option>
                                    <option value="rated">Rated only</option>
                                    <option value="casual">Casual only</option>
                                </select>
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Since</span>
                                <input
                                    value={filters.since?.slice(0, 10) ?? ''}
                                    type="date"
                                    onChange={(event) =>
                                        setFilters((current) => ({
                                            ...current,
                                            since: event.target.value || undefined,
                                        }))
                                    }
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>
                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Until</span>
                                <input
                                    value={filters.until?.slice(0, 10) ?? ''}
                                    type="date"
                                    onChange={(event) =>
                                        setFilters((current) => ({
                                            ...current,
                                            until: event.target.value || undefined,
                                        }))
                                    }
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>
                        </div>

                        {enableAnalyze ? (
                            <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
                                <div style={{ fontWeight: 700 }}>After import</div>
                                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                    <input
                                        type="checkbox"
                                        checked={analyzeInBrowserAfter}
                                        onChange={(e) => {
                                            setAnalyzeInBrowserAfter(e.target.checked);
                                            if (e.target.checked) setQueueServerAnalysisAfter(false);
                                        }}
                                    />
                                    <span>
                                        <span style={{ display: 'block', fontWeight: 650 }}>Analyze in browser after import</span>
                                        <span style={{ display: 'block', opacity: 0.75 }}>
                                            Free {currentStatus?.billing?.analysisQuality === 'STANDARD' ? 'Standard' : 'Thorough'} analysis. Uses this device and this tab must stay open.
                                        </span>
                                    </span>
                                </label>
                                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                    <input
                                        type="checkbox"
                                        checked={queueServerAnalysisAfter}
                                        onChange={(e) => {
                                            setQueueServerAnalysisAfter(e.target.checked);
                                            if (e.target.checked) setAnalyzeInBrowserAfter(false);
                                        }}
                                    />
                                    <span>
                                        <span style={{ display: 'block', fontWeight: 650 }}>Queue server analysis for new games</span>
                                        <span style={{ display: 'block', opacity: 0.75 }}>
                                            Uses {currentStatus?.billing?.analysisQuality === 'STANDARD' ? 'Standard' : 'Thorough'} quality at {currentStatus?.billing?.creditsPerGame ?? 10} server credits per game and continues in the background.{' '}
                                            <Link href="/settings#analysis-defaults" style={{ textDecoration: 'underline' }}>
                                                Change quality
                                            </Link>
                                        </span>
                                    </span>
                                </label>
                            </div>
                        ) : null}

                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={() => void fetchStep()}
                                disabled={busy || currentStatusLoading || !!currentStatusError}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid transparent',
                                    background: 'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                    color: 'hsl(var(--primary-foreground, 210 40% 98%))',
                                    fontWeight: 750,
                                    cursor:
                                        busy || currentStatusLoading || currentStatusError
                                            ? 'not-allowed'
                                            : 'pointer',
                                    opacity:
                                        busy || currentStatusLoading || currentStatusError ? 0.7 : 1,
                                }}
                            >
                                Find older games
                            </button>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>
                                Importing is free. You choose separately whether
                                and where to analyze the new games.
                            </div>
                        </div>
                    </>
                ) : null}

                {currentStep === 'review' ? (
                    <>
                        {providerErrors.length > 0 ? (
                            <div
                                role="status"
                                style={{
                                    border: '1px solid hsl(var(--destructive, 0 84.2% 60.2%) / 0.35)',
                                    borderRadius: 10,
                                    padding: 10,
                                    fontSize: 12,
                                }}
                            >
                                <strong>Partial provider result.</strong>{' '}
                                {providerErrors.map((failure) => (
                                    <span key={failure.provider}>
                                        {failure.provider}: {failure.error}{' '}
                                    </span>
                                ))}
                                Games fetched from the other provider remain available to import.
                            </div>
                        ) : null}
                        {(['lichess', 'chesscom'] as const).some(
                            (provider) => truncatedReasons[provider] !== null
                        ) ? (
                            <div
                                role="status"
                                style={{
                                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                    borderRadius: 10,
                                    padding: 10,
                                    fontSize: 12,
                                }}
                            >
                                {(['lichess', 'chesscom'] as const)
                                    .filter(
                                        (provider) =>
                                            truncatedReasons[provider] !== null
                                    )
                                    .map((provider) => {
                                        const label =
                                            provider === 'lichess'
                                                ? 'Lichess'
                                                : 'Chess.com';
                                        return (
                                            <div key={provider}>
                                                <strong>{label}:</strong>{' '}
                                                {truncatedReasons[provider] ===
                                                'allowance'
                                                    ? 'This is the final importable batch for this account’s 2,000-game history allowance.'
                                                    : truncatedReasons[
                                                            provider
                                                        ] ===
                                                        'provider-page'
                                                      ? `Page ${historyPages[provider]}. Import this page, then continue explicitly to older games.`
                                                      : 'This review page reached the safe response-size limit. Import it, then Start over to recover every remaining game on this page.'}
                                            </div>
                                        );
                                    })}
                            </div>
                        ) : null}
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                            <div style={{ display: 'grid', gap: 4, fontSize: 12, opacity: 0.85 }}>
                                <div>
                                    New: <strong>{newCount}</strong> • Existing: <strong>{dupCount}</strong> • Selected: <strong>{selectedCount}</strong>
                                </div>
                                <div>
                                    {(['lichess', 'chesscom'] as const)
                                        .filter((provider) => allowances[provider])
                                        .map((provider) => {
                                            const value = allowances[provider];
                                            return `${provider === 'lichess' ? 'Lichess' : 'Chess.com'}: ${value?.remaining ?? 0} of ${value?.limit ?? 0} imports remaining`;
                                        })
                                        .join(' • ')}
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 10 }}>
                                <button
                                    type="button"
                                    onClick={() => toggleAllNew(true)}
                                    style={{
                                        height: 32,
                                        padding: '0 10px',
                                        borderRadius: 10,
                                        border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                        background: 'transparent',
                                        fontWeight: 650,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Select all new
                                </button>
                                <button
                                    type="button"
                                    onClick={() => toggleAllNew(false)}
                                    style={{
                                        height: 32,
                                        padding: '0 10px',
                                        borderRadius: 10,
                                        border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                        background: 'transparent',
                                        fontWeight: 650,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Select none
                                </button>
                            </div>
                        </div>

                        <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', borderRadius: 12 }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                    <tr style={{ textAlign: 'left', opacity: 0.8 }}>
                                        <th style={{ padding: 10 }}>
                                            <span className="sr-only">Select game</span>
                                        </th>
                                        <th style={{ padding: 10 }}>When</th>
                                        <th style={{ padding: 10 }}>Provider</th>
                                        <th style={{ padding: 10 }}>Players</th>
                                        <th style={{ padding: 10 }}>Result</th>
                                        <th style={{ padding: 10 }}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rows.map((r) => (
                                        <tr
                                            key={`${r.provider}:${r.externalId}`}
                                            style={{
                                                borderTop: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                                contentVisibility: 'auto',
                                                containIntrinsicSize: '44px',
                                            }}
                                        >
                                            <td style={{ padding: 10 }}>
                                                {r.isNew ? (
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`Select ${r.game.white.name} versus ${r.game.black.name}`}
                                                        checked={r.selected}
                                                        onChange={(e) =>
                                                            setRows((prev) =>
                                                                prev.map((x) =>
                                                                    x === r ? { ...x, selected: e.target.checked } : x
                                                                )
                                                            )
                                                        }
                                                    />
                                                ) : (
                                                    <span style={{ opacity: 0.5 }}>—</span>
                                                )}
                                            </td>
                                            <td style={{ padding: 10, fontFamily: 'var(--font-geist-mono)' }}>
                                                {new Date(r.game.playedAt).toLocaleString()}
                                            </td>
                                            <td style={{ padding: 10 }}>{r.provider}</td>
                                            <td style={{ padding: 10 }}>
                                                {r.game.white.name} vs {r.game.black.name}
                                            </td>
                                            <td style={{ padding: 10 }}>{r.game.result ?? '—'}</td>
                                            <td style={{ padding: 10 }}>
                                                {r.isNew ? (
                                                    <span style={{ color: '#067647', fontWeight: 750 }}>NEW</span>
                                                ) : (
                                                    <span style={{ opacity: 0.7 }}>Already imported</span>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                            <button
                                type="button"
                                onClick={() => {
                                    if (queueServerAnalysisAfter) {
                                        void prepareServerReview();
                                    } else {
                                        void saveStep();
                                    }
                                }}
                                disabled={busy || selectedCount === 0}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid transparent',
                                    background: 'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                    color: 'hsl(var(--primary-foreground, 210 40% 98%))',
                                    fontWeight: 750,
                                    cursor: busy || selectedCount === 0 ? 'not-allowed' : 'pointer',
                                    opacity: busy || selectedCount === 0 ? 0.6 : 1,
                                }}
                            >
                                Import selected
                            </button>
                            {hasOlderHistoryPage &&
                            selectedCount === 0 ? (
                                <button
                                    type="button"
                                    onClick={requestHistoryContinuation}
                                    disabled={busy}
                                    style={{
                                        height: 36,
                                        padding: '0 12px',
                                        borderRadius: 10,
                                        border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                        background: 'transparent',
                                        fontWeight: 700,
                                        cursor: busy
                                            ? 'not-allowed'
                                            : 'pointer',
                                    }}
                                >
                                    {newCount > 0
                                        ? `Skip ${newCount} and continue older`
                                        : 'Continue to older games'}
                                </button>
                            ) : null}
                            <button
                                type="button"
                                onClick={resetHistoryTraversal}
                                disabled={busy}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                    background: 'transparent',
                                    fontWeight: 650,
                                    cursor: busy ? 'not-allowed' : 'pointer',
                                    opacity: busy ? 0.6 : 1,
                                }}
                            >
                                Start over
                            </button>
                        </div>
                    </>
                ) : null}

                {currentStep === 'saving' ? (
                    <div style={{ fontSize: 12, opacity: 0.8 }}>Saving…</div>
                ) : null}

                {currentStep === 'done' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <div style={{ fontWeight: 800 }}>
                            {runSummary?.analysisError ||
                            (runSummary?.failed ?? 0) > 0 ||
                            (runSummary?.serverSkipped ?? 0) > 0 ||
                            (runSummary?.providerErrors.length ?? 0) > 0
                                ? 'Imported with follow-up needed'
                                : 'Import complete'}
                        </div>
                        {runSummary ? (
                            <div
                                aria-live="polite"
                                style={{
                                    display: 'grid',
                                    gap: 6,
                                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                    borderRadius: 10,
                                    padding: 12,
                                    fontSize: 12,
                                }}
                            >
                                <div>
                                    Selected <strong>{runSummary.selected}</strong> • Imported{' '}
                                    <strong>{runSummary.imported}</strong>
                                    {runSummary.duplicates > 0
                                        ? ` • Already in library ${runSummary.duplicates}`
                                        : ''}
                                    {runSummary.failed > 0
                                        ? ` • Failed ${runSummary.failed}`
                                        : ''}
                                </div>
                                {runSummary.capRejected > 0 ? (
                                    <div>
                                        {runSummary.capRejected} selected game
                                        {runSummary.capRejected === 1 ? '' : 's'} exceeded
                                        the 2,000-game allowance for that source.
                                    </div>
                                ) : null}
                                <div>
                                    {(['lichess', 'chesscom'] as const)
                                        .filter((provider) => allowances[provider])
                                        .map((provider) => {
                                            const value = allowances[provider];
                                            return `${provider === 'lichess' ? 'Lichess' : 'Chess.com'}: ${value?.remaining ?? 0} imports remaining`;
                                        })
                                        .join(' • ')}
                                </div>
                                {runSummary.browserRequested > 0 ? (
                                    <div>
                                        Browser analysis started for{' '}
                                        <strong>{runSummary.browserRequested}</strong> games. Keep
                                        this tab open.
                                    </div>
                                ) : null}
                                {queueServerAnalysisAfter ? (
                                    <div>
                                        Server analysis queued for{' '}
                                        <strong>{runSummary.serverQueued}</strong> games
                                        {runSummary.serverSkipped > 0
                                            ? `; ${runSummary.serverSkipped} were not queued`
                                            : ''}
                                        .
                                    </div>
                                ) : null}
                                {runSummary.analysisError ? (
                                    <div style={{ color: 'hsl(var(--destructive, 0 84.2% 60.2%))' }}>
                                        The games are safely imported, but analysis needs retry:{' '}
                                        {runSummary.analysisError}
                                    </div>
                                ) : null}
                                {runSummary.providerErrors.length > 0 ? (
                                    <div>
                                        Provider fetch partially failed:{' '}
                                        {runSummary.providerErrors
                                            .map(
                                                (failure) =>
                                                    `${failure.provider}: ${failure.error}`
                                            )
                                            .join(' • ')}
                                    </div>
                                ) : null}
                            </div>
                        ) : null}
                        <div style={{ display: 'flex', gap: 10 }}>
                            {hasOlderHistoryPage ? (
                                <button
                                    type="button"
                                    onClick={requestHistoryContinuation}
                                    disabled={busy}
                                    style={{
                                        height: 36,
                                        padding: '0 12px',
                                        borderRadius: 10,
                                        border: '1px solid transparent',
                                        background:
                                            'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                        color:
                                            'hsl(var(--primary-foreground, 210 40% 98%))',
                                        fontWeight: 750,
                                        cursor: busy
                                            ? 'not-allowed'
                                            : 'pointer',
                                    }}
                                >
                                    {unresolvedPageGames > 0
                                        ? `Skip ${unresolvedPageGames} and continue older`
                                        : 'Continue to older games'}
                                </button>
                            ) : null}
                            {(runSummary?.providerErrors.length ?? 0) > 0 ? (
                                <button
                                    type="button"
                                    onClick={retryFailedProviders}
                                    style={{
                                        height: 36,
                                        padding: '0 12px',
                                        borderRadius: 10,
                                        border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                        background: 'transparent',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                    }}
                                >
                                    Retry failed provider
                                </button>
                            ) : null}
                            <button
                                type="button"
                                onClick={() => {
                                    close();
                                }}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid transparent',
                                    background: 'hsl(var(--primary, 222.2 47.4% 11.2%))',
                                    color: 'hsl(var(--primary-foreground, 210 40% 98%))',
                                    fontWeight: 750,
                                    cursor: 'pointer',
                                }}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                onClick={resetHistoryTraversal}
                                style={{
                                    height: 36,
                                    padding: '0 12px',
                                    borderRadius: 10,
                                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                                    background: 'transparent',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                }}
                            >
                                Start over
                            </button>
                        </div>
                    </div>
                ) : null}
            </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
        <ActionConfirmDialog
            open={continueReviewOpen && statusOwnerId === ownerId}
            onOpenChange={setContinueReviewOpen}
            title="Continue past unimported games?"
            description={`This page still has ${unresolvedPageGames} unimported game${unresolvedPageGames === 1 ? '' : 's'}. Continuing moves this review to older games.`}
            confirmLabel={`Skip ${unresolvedPageGames} and continue`}
            onConfirm={continueHistoryTraversal}
            busy={busy}
        >
            <div style={{ fontSize: 12 }}>
                Skipped games are not deleted or lost. Choose{' '}
                <strong>Start over</strong>, or reopen this dialog, to review
                them again from the newest page.
            </div>
        </ActionConfirmDialog>
        <ActionConfirmDialog
            open={serverReviewOpen && statusOwnerId === ownerId}
            onOpenChange={setServerReviewOpen}
            title="Import and queue server analysis?"
            description={`Import ${selectedCount} selected game${selectedCount === 1 ? '' : 's'}, then queue each newly saved game for server analysis.`}
            confirmLabel={`Import and queue ${selectedCount}`}
            onConfirm={confirmServerImport}
            busy={busy}
            confirmDisabled={
                !currentStatus?.billing ||
                selectedCount > currentStatus.billing.reservableGames
            }
        >
            <div
                style={{
                    border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                    borderRadius: 10,
                    padding: 12,
                    fontSize: 12,
                }}
            >
                {currentStatus?.billing ? (
                    <>
                        <div>
                            Quality:{' '}
                            <strong>
                                {currentStatus.billing.analysisQuality ===
                                'STANDARD'
                                    ? 'Standard'
                                    : 'Thorough'}
                            </strong>{' '}
                            · {currentStatus.billing.creditsPerGame} credits per
                            game
                        </div>
                        <div>
                            Current balance:{' '}
                            <strong>{currentStatus.billing.currentBalance}</strong> •
                            Reservable now:{' '}
                            <strong>{currentStatus.billing.reservableGames}</strong> games •
                            Balance after maximum cost:{' '}
                            <strong>
                                {Math.max(
                                    0,
                                    currentStatus.billing.currentBalance -
                                        selectedCount *
                                            currentStatus.billing.creditsPerGame
                                )}
                            </strong>
                        </div>
                        {selectedCount > currentStatus.billing.reservableGames ? (
                            <div style={{ color: 'hsl(var(--destructive, 0 84.2% 60.2%))' }}>
                                {currentStatus.billing.limitingReason ??
                                    `This exceeds the ${currentStatus.billing.reservableGames} games currently reservable at ${currentStatus.billing.creditsPerGame} credits each.`}
                            </div>
                        ) : null}
                    </>
                ) : (
                    <div style={{ color: 'hsl(var(--destructive, 0 84.2% 60.2%))' }}>
                        Credit capacity could not be verified. Close and retry.
                    </div>
                )}
                <div>
                    Maximum cost:{' '}
                    <strong>
                        {selectedCount *
                            (currentStatus?.billing?.creditsPerGame ?? 10)}{' '}
                        server credits
                    </strong>{' '}
                    ({currentStatus?.billing?.creditsPerGame ?? 10} per accepted game). Import remains saved even if
                    analysis cannot be queued. Server analysis continues after
                    this tab is closed.
                </div>
            </div>
        </ActionConfirmDialog>
        </>
    );
}
