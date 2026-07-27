'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useSession } from 'next-auth/react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import { backgroundAnalysis } from '@/lib/analysis/backgroundAnalysisManager';
import {
    enqueueServerAnalysisJobs,
    fetchGamesFromProvider,
    getExistingExternalIds,
    getSyncStatus,
    saveGamesToLibrary,
    splitNewVsExisting,
    type SyncFilters,
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

type FetchedRow = {
    game: NormalizedGame;
    provider: SyncProvider;
    externalId: string;
    isNew: boolean;
    selected: boolean;
};

type SyncRunSummary = {
    selected: number;
    saved: number;
    skipped: number;
    importErrors: number;
    browserRequested: number;
    serverQueued: number;
    serverSkipped: number;
    analysisError: string | null;
    providerErrors: Array<{ provider: SyncProvider; error: string }>;
};

const NEW_SYNC_GAMES_MODAL_STORAGE_PREFIX = 'backranq.syncGamesModal.v2';

function modalStorageKey(ownerId: string) {
    return `${NEW_SYNC_GAMES_MODAL_STORAGE_PREFIX}:${encodeURIComponent(ownerId)}`;
}

function defaultSinceUntilRange(): { since: string; until: string } {
    // Default: last ~30 days, inclusive through end-of-today (UTC).
    const todayStr = new Date().toISOString().slice(0, 10);
    const sinceStr = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
        since: new Date(sinceStr).toISOString(),
        until: new Date(`${todayStr}T23:59:59.999Z`).toISOString(),
    };
}

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
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [statusOwnerId, setStatusOwnerId] = useState<string | null>(null);
    const [statusLoading, setStatusLoading] = useState(true);
    const [statusError, setStatusError] = useState<string | null>(null);

    const [providers, setProviders] = useState<{ lichess: boolean; chesscom: boolean }>(
        { lichess: true, chesscom: true }
    );
    const [filters, setFilters] = useState<SyncFilters>({
        timeClasses: [],
        rated: 'any',
        max: 50,
        since: undefined,
        until: undefined,
    });

    const timeClassOptions: MultiSelectOption[] = useMemo(() => [
        { value: 'bullet', label: 'Bullet' },
        { value: 'blitz', label: 'Blitz' },
        { value: 'rapid', label: 'Rapid' },
        { value: 'classical', label: 'Classical' },
    ], []);
    const [analyzeInBrowserAfter, setAnalyzeInBrowserAfter] = useState(false);
    const [queueServerAnalysisAfter, setQueueServerAnalysisAfter] = useState(false);
    const [rows, setRows] = useState<FetchedRow[]>([]);
    const [providerErrors, setProviderErrors] = useState<
        Array<{ provider: SyncProvider; error: string }>
    >([]);
    const [runSummary, setRunSummary] = useState<SyncRunSummary | null>(null);
    const [serverReviewOpen, setServerReviewOpen] = useState(false);

    useEffect(() => {
        if (!open || !ownerId) return;
        let cancelled = false;
        backgroundAnalysis.setOwner(ownerId);
        setStep('config');
        setRows([]);
        setAnalyzeInBrowserAfter(false);
        setQueueServerAnalysisAfter(false);
        setBusy(false);
        setProviderErrors([]);
        setRunSummary(null);
        setServerReviewOpen(false);
        setStatusLoading(true);
        setStatusError(null);

        // Restore last-used date inputs (or default to last month).
        const defaults = defaultSinceUntilRange();
        try {
            const raw = localStorage.getItem(modalStorageKey(ownerId));
            const parsed = raw
                ? (JSON.parse(raw) as { since?: string; until?: string })
                : null;
            setFilters((f) => ({
                ...f,
                since: parsed?.since ?? f.since ?? defaults.since,
                until: parsed?.until ?? f.until ?? defaults.until,
            }));
        } catch {
            setFilters((f) => ({
                ...f,
                since: f.since ?? defaults.since,
                until: f.until ?? defaults.until,
            }));
        }

        getSyncStatus()
            .then((s) => {
                if (cancelled) return;
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
        };
    }, [open, ownerId]);

    useEffect(() => {
        if (!open || !ownerId) return;
        // Persist date filters so reopening the modal restores them.
        try {
            localStorage.setItem(
                modalStorageKey(ownerId),
                JSON.stringify({ since: filters.since, until: filters.until })
            );
        } catch {
            // ignore
        }
    }, [open, filters.since, filters.until, ownerId]);

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
    const dupCount = useMemo(() => rows.filter((r) => !r.isNew).length, [rows]);

    if (!open || !ownerId) return null;

    function runIsCurrent(run: OwnerRunToken) {
        return isOwnerRunCurrent(run, ownerEpochRef.current);
    }

    function close() {
        if (busy) return;
        onClose();
    }

    async function fetchStep() {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        if (!currentStatus) {
            toast.error('Missing sync status');
            return;
        }
        if (enabledProviders.length === 0) {
            toast.error('Select at least one provider');
            return;
        }

        // need linked usernames for each provider
        for (const p of enabledProviders) {
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
        const toastId = toast.loading('Fetching games…');
        try {
            const nextRows: FetchedRow[] = [];
            const failures: Array<{ provider: SyncProvider; error: string }> = [];
            for (const p of enabledProviders) {
                try {
                    const username =
                        p === 'lichess'
                            ? (currentStatus.linked.lichessUsername as string)
                            : (currentStatus.linked.chesscomUsername as string);
                    const providerGames = await fetchGamesFromProvider({
                        provider: p,
                        username,
                        filters,
                    });
                    if (!runIsCurrent(run)) return;
                    const externalIds = providerGames.map((game) =>
                        parseExternalId(game)
                    );
                    const existing = await getExistingExternalIds({
                        provider: p,
                        externalIds,
                    });
                    if (!runIsCurrent(run)) return;
                    const { newGames, existingGames } = splitNewVsExisting(
                        p,
                        providerGames,
                        existing
                    );

                    for (const game of newGames) {
                        nextRows.push({
                            game,
                            provider: p,
                            externalId: parseExternalId(game),
                            isNew: true,
                            selected: true,
                        });
                    }
                    for (const game of existingGames) {
                        nextRows.push({
                            game,
                            provider: p,
                            externalId: parseExternalId(game),
                            isNew: false,
                            selected: false,
                        });
                    }
                } catch (error) {
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
            if (failures.length === enabledProviders.length) {
                throw new Error(
                    failures.map((failure) => failure.error).join(' ')
                );
            }
            // newest first
            nextRows.sort((a, b) => +new Date(b.game.playedAt) - +new Date(a.game.playedAt));
            setRows(nextRows);
            setProviderErrors(failures);

            if (failures.length > 0) {
                toast.warning(
                    `Fetched ${nextRows.length} games. ${failures.length} provider${failures.length === 1 ? '' : 's'} need attention.`,
                    { id: toastId }
                );
            } else {
                toast.success(`Fetched ${nextRows.length} games`, { id: toastId });
            }
            setStep('review');
        } catch (e) {
            if (!runIsCurrent(run)) return;
            toast.error(e instanceof Error ? e.message : 'Fetch failed', { id: toastId });
        } finally {
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
        const toSave = rows.filter((r) => r.isNew && r.selected).map((r) => r.game);
        if (toSave.length === 0) {
            toast.message('No new games selected');
            return;
        }

        setStep('saving');
        setBusy(true);
        const toastId = toast.loading('Saving games…');
        try {
            const res = await saveGamesToLibrary({ games: toSave });
            if (!runIsCurrent(run)) return;
            const summary: SyncRunSummary = {
                selected: toSave.length,
                saved: res.saved,
                skipped: res.skipped,
                importErrors: res.errors?.length ?? 0,
                browserRequested: 0,
                serverQueued: 0,
                serverSkipped: 0,
                analysisError: null,
                providerErrors: [...providerErrors],
            };
            clearLastAnalysisCompletion(run.ownerId);
            if (res.skipped > 0 || res.errors?.length) {
                toast.warning(
                    `Imported ${res.saved} of ${toSave.length} selected games.`,
                    { id: toastId }
                );
            } else {
                toast.success(`Saved ${res.saved} games`, { id: toastId });
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
                                    puzzlesAtStart: null,
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

    async function prepareServerReview() {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        setBusy(true);
        try {
            const latestStatus = await getSyncStatus();
            if (!runIsCurrent(run)) return;
            setStatus(latestStatus);
            setStatusOwnerId(run.ownerId);
            setServerReviewOpen(true);
        } catch (error) {
            if (!runIsCurrent(run)) return;
            toast.error(
                error instanceof Error
                    ? error.message
                    : 'Could not verify server credit capacity'
                );
        } finally {
            if (runIsCurrent(run)) setBusy(false);
        }
    }

    async function confirmServerImport() {
        const run = captureOwnerRun(ownerEpochRef.current);
        if (!run || !runIsCurrent(run)) {
            toast.error('Your session changed. Reopen sync and try again.');
            return;
        }
        setBusy(true);
        try {
            const latestStatus = await getSyncStatus();
            if (!runIsCurrent(run)) return;
            setStatus(latestStatus);
            setStatusOwnerId(run.ownerId);
            const capacity = latestStatus.billing;
            if (!capacity || selectedCount > capacity.reservableCredits) {
                toast.error(
                    capacity?.limitingReason ??
                        'Server credit capacity could not be verified.'
                );
                return;
            }
            setServerReviewOpen(false);
            await saveStep(run);
            if (!runIsCurrent(run)) return;
        } finally {
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
        setRunSummary(null);
        setStep('config');
    }

    const modalTitle =
        context === 'home' ? 'Sync games to your account' : 'Sync new games';

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
                aria-describedby="sync-games-description"
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
                    if (busy) event.preventDefault();
                }}
                onInteractOutside={(event) => {
                    if (busy) event.preventDefault();
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <DialogPrimitive.Title style={{ fontWeight: 800 }}>
                        {modalTitle}
                    </DialogPrimitive.Title>
                    <button
                        type="button"
                        onClick={close}
                        style={{
                            height: 30,
                            padding: '0 10px',
                            borderRadius: 10,
                            border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))',
                            background: 'hsl(var(--background, 0 0% 100%))',
                            fontWeight: 700,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            opacity: busy ? 0.5 : 1,
                        }}
                    >
                        Close
                    </button>
                </div>
                <DialogPrimitive.Description
                    id="sync-games-description"
                    style={{ fontSize: 12, opacity: 0.8 }}
                >
                    Choose linked providers, review the exact games, then import
                    them with optional browser or server analysis.
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
                                Sync status unavailable: {currentStatusError}. Close and reopen
                                this dialog to retry.
                            </div>
                        ) : null}
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                            Choose providers and filters. We’ll only import games not already in your library.
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={providers.lichess}
                                    onChange={(e) => setProviders((p) => ({ ...p, lichess: e.target.checked }))}
                                />
                                <span>Lichess</span>
                            </label>
                            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                                <input
                                    type="checkbox"
                                    checked={providers.chesscom}
                                    onChange={(e) => setProviders((p) => ({ ...p, chesscom: e.target.checked }))}
                                />
                                <span>Chess.com</span>
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Max games</span>
                                <input
                                    inputMode="numeric"
                                    value={String(filters.max)}
                                    onChange={(e) => setFilters((f) => ({ ...f, max: Number(e.target.value) || 50 }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Time class</span>
                                <MultiSelect
                                    options={timeClassOptions}
                                    value={filters.timeClasses}
                                    onChange={(next) => setFilters((f) => ({ ...f, timeClasses: next as TimeClass[] }))}
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
                                    onChange={(e) => setFilters((f) => ({ ...f, rated: e.target.value as SyncFilters['rated'] }))}
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
                                    value={filters.since ? filters.since.slice(0, 10) : ''}
                                    type="date"
                                    onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value ? new Date(e.target.value).toISOString() : undefined }))}
                                    style={{ height: 36, borderRadius: 10, border: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))', padding: '0 10px', background: 'transparent', color: 'inherit' }}
                                />
                            </label>

                            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, opacity: 0.8 }}>
                                <span>Until</span>
                                <input
                                    value={filters.until ? filters.until.slice(0, 10) : ''}
                                    type="date"
                                    onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value ? new Date(e.target.value + 'T23:59:59.999Z').toISOString() : undefined }))}
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
                                        <span style={{ display: 'block', opacity: 0.75 }}>Free. Uses this device and this tab must stay open.</span>
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
                                        <span style={{ display: 'block', opacity: 0.75 }}>Uses 1 server credit per game and continues in the background.</span>
                                    </span>
                                </label>
                            </div>
                        ) : null}

                        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                onClick={fetchStep}
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
                                Fetch games
                            </button>
                            <div style={{ fontSize: 12, opacity: 0.75 }}>
                                Last sync: lichess {currentStatus?.lastSync.lichess ? new Date(currentStatus.lastSync.lichess).toLocaleDateString() : '—'} • chesscom {currentStatus?.lastSync.chesscom ? new Date(currentStatus.lastSync.chesscom).toLocaleDateString() : '—'}
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
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 12, opacity: 0.85 }}>
                                New: <strong>{newCount}</strong> • Existing: <strong>{dupCount}</strong> • Selected: <strong>{selectedCount}</strong>
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
                                        <tr key={`${r.provider}:${r.externalId}`} style={{ borderTop: '1px solid hsl(var(--border, 214.3 31.8% 91.4%))' }}>
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
                            <button
                                type="button"
                                onClick={() => setStep('config')}
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
                                Back
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
                            (runSummary?.importErrors ?? 0) > 0 ||
                            (runSummary?.skipped ?? 0) > 0 ||
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
                                    <strong>{runSummary.saved}</strong>
                                    {runSummary.skipped > 0
                                        ? ` • Skipped ${runSummary.skipped}`
                                        : ''}
                                    {runSummary.importErrors > 0
                                        ? ` • ${runSummary.importErrors} import errors`
                                        : ''}
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
                        </div>
                    </div>
                ) : null}
            </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
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
                selectedCount > currentStatus.billing.reservableCredits
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
                            Current balance:{' '}
                            <strong>{currentStatus.billing.currentBalance}</strong> •
                            Reservable now:{' '}
                            <strong>{currentStatus.billing.reservableCredits}</strong> •
                            Balance after maximum cost:{' '}
                            <strong>
                                {Math.max(
                                    0,
                                    currentStatus.billing.currentBalance -
                                        selectedCount
                                )}
                            </strong>
                        </div>
                        {selectedCount > currentStatus.billing.reservableCredits ? (
                            <div style={{ color: 'hsl(var(--destructive, 0 84.2% 60.2%))' }}>
                                {currentStatus.billing.limitingReason ??
                                    `This exceeds the ${currentStatus.billing.reservableCredits} credits currently reservable.`}
                            </div>
                        ) : null}
                    </>
                ) : (
                    <div style={{ color: 'hsl(var(--destructive, 0 84.2% 60.2%))' }}>
                        Credit capacity could not be verified. Close and retry.
                    </div>
                )}
                <div>
                    Maximum cost: <strong>{selectedCount} server credits</strong>{' '}
                    (one per accepted game). Import remains saved even if
                    analysis cannot be queued. Server analysis continues after
                    this tab is closed.
                </div>
            </div>
        </ActionConfirmDialog>
        </>
    );
}
