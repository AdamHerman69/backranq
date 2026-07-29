"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ActionConfirmDialog } from "@/components/ui/ActionConfirmDialog";
import { cn } from "@/lib/utils";
import {
  backgroundAnalysis,
  type BackgroundAnalysisSnapshot,
} from "@/lib/analysis/backgroundAnalysisManager";
import {
  clearLastAnalysisCompletion,
  createServerAnalysisBatch,
  deriveServerAnalysisCompletion,
  deriveServerJobCompletion,
  mergeServerAnalysisBatches,
  publishAnalysisCompletion,
  publishLibraryChanged,
  readLastAnalysisCompletion,
  readServerAnalysisBatch,
  writeServerAnalysisBatch,
  analysisCompletionStorageKeys,
  ANALYSIS_COMPLETION_EVENT,
  LIBRARY_CHANGED_EVENT,
  type AnalysisCompletionSummary,
  type ServerAnalysisBatch,
  type ServerAnalysisObservation,
} from "@/lib/analysis/analysisCompletion";
import {
  enqueueServerAnalysisJobs,
  fetchServerAnalysisJobs,
  getSyncStatus,
  type SyncStatus,
} from "@/lib/services/gameSync";
import { shouldPollAnalysis } from "@/lib/analysis/analysisRefreshPolicy";

const NEW_DISMISS_PREFIX = "backranq.analysisBar.dismiss.v2";

function dismissKey(ownerId: string) {
  return `${NEW_DISMISS_PREFIX}:${encodeURIComponent(ownerId)}`;
}

function readDismissedCount(ownerId: string): number {
  try {
    const rawNew = localStorage.getItem(dismissKey(ownerId));
    const parsed = rawNew ? (JSON.parse(rawNew) as { dismissedForPending?: number }) : null;
    return typeof parsed?.dismissedForPending === "number" ? parsed.dismissedForPending : 0;
  } catch {
    return 0;
  }
}

function writeDismissedCount(ownerId: string, n: number) {
  try {
    localStorage.setItem(dismissKey(ownerId), JSON.stringify({ dismissedForPending: n }));
  } catch {
    // ignore
  }
}

async function fetchTrainingMomentCount(): Promise<number | null> {
  try {
    const response = await fetch("/api/training/session?limit=50", {
      cache: "no-store",
    });
    if (!response.ok) return null;
    const json = (await response.json().catch(() => ({}))) as {
      items?: unknown[];
    };
    return Array.isArray(json.items) ? json.items.length : null;
  } catch {
    return null;
  }
}

function completionMessage(summary: AnalysisCompletionSummary) {
  const analyzed = `${summary.succeeded} game${summary.succeeded === 1 ? "" : "s"} analyzed`;
  const failed = summary.failed > 0 ? `, ${summary.failed} failed` : "";
  const trainingMoments =
    summary.trainingMomentsGenerated == null
      ? ""
      : `, ${summary.trainingMomentsGenerated} training moment${summary.trainingMomentsGenerated === 1 ? "" : "s"}`;
  if (summary.status === "cancelled") return `Analysis cancelled after ${analyzed}${trainingMoments}.`;
  return `${analyzed}${failed}${trainingMoments}.`;
}

export function BackgroundAnalysisBar() {
  const router = useRouter();
  const { data: session, status: sessionStatus } = useSession();
  const ownerId = session?.user?.id ?? null;
  const [snap, setSnap] = React.useState<BackgroundAnalysisSnapshot>(() => backgroundAnalysis.snapshot());
  const [syncStatus, setSyncStatus] = React.useState<SyncStatus | null>(null);
  const [trainingMomentCount, setTrainingMomentCount] = React.useState<number | null>(null);
  const [lastCompletion, setLastCompletion] = React.useState<AnalysisCompletionSummary | null>(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const [dismissedForPending, setDismissedForPending] = React.useState(0);
  const [browserStarting, setBrowserStarting] = React.useState(false);
  const [serverQueueing, setServerQueueing] = React.useState(false);
  const [serverReviewOpen, setServerReviewOpen] = React.useState(false);
  const [serverReviewIds, setServerReviewIds] = React.useState<string[]>([]);
  const [hasTrackedServerBatch, setHasTrackedServerBatch] = React.useState(false);
  const previousServerObservation = React.useRef<ServerAnalysisObservation | null>(null);
  const serverBatch = React.useRef<ServerAnalysisBatch | null>(null);
  const toastedCompletionId = React.useRef<string | null>(null);
  const completedBatchIds = React.useRef(new Set<string>());
  const refreshInFlight = React.useRef<Promise<void> | null>(null);
  const activeOwnerId = React.useRef<string | null>(ownerId);

  const showCompletionToast = React.useCallback(
    (summary: AnalysisCompletionSummary) => {
      if (toastedCompletionId.current === summary.id) return;
      toastedCompletionId.current = summary.id;
      const options = {
        action:
          (summary.trainingMomentsGenerated ?? 0) > 0
            ? { label: "Train", onClick: () => router.push("/training") }
            : { label: "Details", onClick: () => router.push("/games") },
      };
      if (summary.status === "failed") toast.error(completionMessage(summary), options);
      else if (summary.status === "partial") toast.warning(completionMessage(summary), options);
      else toast.success(completionMessage(summary), options);
    },
    [router]
  );

  React.useEffect(() => {
    activeOwnerId.current = ownerId;
    backgroundAnalysis.setOwner(ownerId);
    setSyncStatus(null);
    setTrainingMomentCount(null);
    setLastCompletion(ownerId ? readLastAnalysisCompletion(ownerId) : null);
    setDismissedForPending(ownerId ? readDismissedCount(ownerId) : 0);
    setSnap(backgroundAnalysis.snapshot());
    serverBatch.current = ownerId ? readServerAnalysisBatch(ownerId) : null;
    setHasTrackedServerBatch(!!serverBatch.current);
    previousServerObservation.current = null;
    refreshInFlight.current = null;
    completedBatchIds.current.clear();
    toastedCompletionId.current = null;
    if (!ownerId) return;
    return backgroundAnalysis.subscribe((next) => {
      if (next.ownerId !== ownerId) return;
      setSnap(next);
      if (next.lastCompletion?.ownerId === ownerId) {
        setLastCompletion(next.lastCompletion);
      }
    });
  }, [ownerId]);

  React.useEffect(() => {
    function onCompletion(event: Event) {
      const summary = (event as CustomEvent<AnalysisCompletionSummary>).detail;
      if (!summary || summary.ownerId !== ownerId) return;
      setLastCompletion(summary);
      showCompletionToast(summary);
      router.refresh();
    }
    window.addEventListener(ANALYSIS_COMPLETION_EVENT, onCompletion);
    return () => window.removeEventListener(ANALYSIS_COMPLETION_EVENT, onCompletion);
  }, [ownerId, router, showCompletionToast]);

  const refreshAll = React.useCallback(() => {
    if (sessionStatus !== "authenticated" || !ownerId) {
      return Promise.resolve();
    }
    if (refreshInFlight.current) return refreshInFlight.current;

    const task = (async () => {
      const storedBatch = readServerAnalysisBatch(ownerId);
      let batch = mergeServerAnalysisBatches(serverBatch.current, storedBatch);
      serverBatch.current = batch;
      setHasTrackedServerBatch(!!batch);

      const [pendingResult, statusResult, trainingMomentResult] =
        await Promise.allSettled([
          backgroundAnalysis.refreshPendingUnanalyzedCount(ownerId),
          getSyncStatus(),
          fetchTrainingMomentCount(),
        ]);
      if (activeOwnerId.current !== ownerId) return;

      const nextStatus =
        statusResult.status === "fulfilled" ? statusResult.value : null;
      const nextTrainingMomentCount =
        trainingMomentResult.status === "fulfilled" ? trainingMomentResult.value : null;
      if (nextStatus) setSyncStatus(nextStatus);
      if (nextTrainingMomentCount != null) setTrainingMomentCount(nextTrainingMomentCount);
      if (!nextStatus) return;

      const observation: ServerAnalysisObservation = {
        queued: nextStatus.analysisJobs?.queued ?? 0,
        running: nextStatus.analysisJobs?.running ?? 0,
        failed: nextStatus.analysisJobs?.failed ?? 0,
        trainingMomentCount: nextTrainingMomentCount,
        pendingCount:
          pendingResult.status === "fulfilled" ? pendingResult.value : null,
      };
      const active = observation.queued + observation.running;
      const shouldFetchJobs = (batch?.jobIds.length ?? 0) > 0 || active > 0;
      const jobs = shouldFetchJobs
        ? await fetchServerAnalysisJobs(
            batch?.jobIds.length ? batch.jobIds : undefined
          ).catch(() => [])
        : [];
      if (activeOwnerId.current !== ownerId) return;
      batch = mergeServerAnalysisBatches(
        batch,
        readServerAnalysisBatch(ownerId)
      );
      serverBatch.current = batch;
      if (!batch && active > 0) {
        const activeJobs = jobs.filter(
          (job) => job.status === "QUEUED" || job.status === "RUNNING"
        );
        batch = createServerAnalysisBatch({
          ownerId,
          queued: active,
          jobIds:
            activeJobs.length === active
              ? activeJobs.map((job) => job.id)
              : [],
          failedAtStart: observation.failed,
          trainingMomentsAtStart: observation.trainingMomentCount,
          pendingAtStart: observation.pendingCount,
        });
        serverBatch.current = batch;
        setHasTrackedServerBatch(true);
        writeServerAnalysisBatch(ownerId, batch);
      }

      const completion =
        batch?.jobIds.length
          ? deriveServerJobCompletion(batch, jobs, observation)
          : deriveServerAnalysisCompletion(
              previousServerObservation.current,
              observation,
              batch
            );
      previousServerObservation.current = observation;
      if (
        completion &&
        !completedBatchIds.current.has(completion.batchId ?? completion.id)
      ) {
        completedBatchIds.current.add(completion.batchId ?? completion.id);
        serverBatch.current = null;
        setHasTrackedServerBatch(false);
        writeServerAnalysisBatch(ownerId, null);
        publishAnalysisCompletion(completion);
      }
    })();
    const tracked = task.finally(() => {
      if (refreshInFlight.current === tracked) refreshInFlight.current = null;
    });
    refreshInFlight.current = tracked;
    return tracked;
  }, [ownerId, sessionStatus]);

  React.useEffect(() => {
    if (sessionStatus !== "authenticated" || !ownerId) return;
    void refreshAll();
  }, [ownerId, refreshAll, sessionStatus]);

  React.useEffect(() => {
    if (!ownerId) return;
    const scopedOwnerId = ownerId;
    const keys = analysisCompletionStorageKeys(scopedOwnerId);
    function onStorage(event: StorageEvent) {
      if (event.key === keys.completion) {
        setLastCompletion(readLastAnalysisCompletion(scopedOwnerId));
        publishLibraryChanged(scopedOwnerId);
        router.refresh();
      }
      if (event.key === keys.serverBatch) {
        const stored = readServerAnalysisBatch(scopedOwnerId);
        serverBatch.current = event.newValue
          ? mergeServerAnalysisBatches(serverBatch.current, stored)
          : null;
        setHasTrackedServerBatch(!!serverBatch.current);
        void refreshAll();
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [ownerId, refreshAll, router]);

  React.useEffect(() => {
    if (!ownerId) return;
    const scopedOwnerId = ownerId;
    function onLibraryChanged(event: Event) {
      const detail = (
        event as CustomEvent<{
          ownerId?: string;
          invalidateCompletion?: boolean;
        }>
      ).detail;
      if (
        detail?.ownerId !== scopedOwnerId ||
        activeOwnerId.current !== scopedOwnerId
      ) {
        return;
      }
      const stored = readServerAnalysisBatch(scopedOwnerId);
      serverBatch.current = mergeServerAnalysisBatches(
        serverBatch.current,
        stored
      );
      setHasTrackedServerBatch(!!serverBatch.current);
      if (detail.invalidateCompletion) setLastCompletion(null);
      void refreshAll();
    }
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
    return () =>
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
  }, [ownerId, refreshAll]);

  const currentSyncStatus =
    activeOwnerId.current === ownerId ? syncStatus : null;
  const hasLinkedAccount =
    !!currentSyncStatus?.linked.lichessUsername ||
    !!currentSyncStatus?.linked.chesscomUsername;
  const serverQueued = currentSyncStatus?.analysisJobs?.queued ?? 0;
  const serverRunning = currentSyncStatus?.analysisJobs?.running ?? 0;
  const isRunning = snap.ownerId === ownerId && snap.state === "running";

  React.useEffect(() => {
    if (!shouldPollAnalysis({
      authenticated: sessionStatus === "authenticated",
      ownerId,
      hasLinkedAccount,
      hasTrackedServerBatch,
      serverQueued,
      serverRunning,
      browserRunning: isRunning,
    })) {
      return;
    }
    const timer = window.setInterval(() => void refreshAll(), 30_000);
    return () => window.clearInterval(timer);
  }, [
    hasLinkedAccount,
    hasTrackedServerBatch,
    isRunning,
    ownerId,
    refreshAll,
    serverQueued,
    serverRunning,
    sessionStatus,
  ]);

  if (sessionStatus !== "authenticated" || !ownerId) return null;
  const authenticatedOwnerId = ownerId;

  const snapshotMatchesOwner = snap.ownerId === authenticatedOwnerId;
  const pending = snapshotMatchesOwner
    ? (snap.pendingUnanalyzedCount ?? 0)
    : 0;
  const hasPendingSuggestion = pending > 0 && pending > dismissedForPending;
  const isError = snapshotMatchesOwner && snap.state === "error";
  const currentCompletion =
    lastCompletion?.ownerId === authenticatedOwnerId
      ? lastCompletion
      : null;
  const hasServerWork = serverQueued > 0 || serverRunning > 0;
  const shouldShow = isRunning || isError || hasPendingSuggestion || hasServerWork || !!currentCompletion;
  if (!shouldShow) return null;

  const percent = Math.max(0, Math.min(100, snap.percent));

  async function onAnalyzePendingInBrowser() {
    if (browserStarting || serverQueueing) return;
    setBrowserStarting(true);
    try {
      const queued = await backgroundAnalysis.enqueuePendingUnanalyzed(authenticatedOwnerId, { limit: 25 });
      if (queued === 0) {
        toast.message("No unanalyzed games found.");
        return;
      }
      toast.message("Browser analysis started. Keep this tab open.");
      setLastCompletion(null);
      clearLastAnalysisCompletion(authenticatedOwnerId);
      publishLibraryChanged(authenticatedOwnerId, {
        invalidateCompletion: true,
      });
      setCollapsed(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to start analysis");
    } finally {
      setBrowserStarting(false);
    }
  }

  async function prepareServerReview() {
    if (browserStarting || serverQueueing) return;
    setServerQueueing(true);
    try {
      const [response, latestStatus] = await Promise.all([
        fetch("/api/games?hasAnalysis=false&page=1&limit=25", {
          cache: "no-store",
        }),
        getSyncStatus(),
      ]);
      if (activeOwnerId.current !== authenticatedOwnerId) return;
      setSyncStatus(latestStatus);
      const json = (await response.json().catch(() => ({}))) as {
        games?: { id: string }[];
        error?: string;
      };
      if (!response.ok) throw new Error(json.error ?? "Failed to load games");
      const gameIds = (json.games ?? []).map((game) => game.id).filter(Boolean);
      if (gameIds.length === 0) {
        toast.message("No unanalyzed games found.");
        return;
      }
      setServerReviewIds(gameIds);
      setServerReviewOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to prepare analysis");
    } finally {
      setServerQueueing(false);
    }
  }

  async function confirmServerAnalysis() {
    if (serverReviewIds.length === 0) return;
    setServerQueueing(true);
    try {
      const latestStatus = await getSyncStatus();
      if (activeOwnerId.current !== authenticatedOwnerId) return;
      setSyncStatus(latestStatus);
      if (
        latestStatus.billing &&
        serverReviewIds.length > latestStatus.billing.reservableCredits
      ) {
        toast.error(
          latestStatus.billing.limitingReason ??
            `Only ${latestStatus.billing.reservableCredits} server credits can be reserved right now.`
        );
        return;
      }
      const result = await enqueueServerAnalysisJobs({ gameIds: serverReviewIds });
      toastServerQueueResult(result);
      if (result.queued > 0) {
        const incomingBatch = createServerAnalysisBatch({
          ownerId: authenticatedOwnerId,
          queued: result.queued,
          jobIds: (result.jobs ?? [])
            .filter((job) => job.acceptedInBatch === true)
            .map((job) => job.id),
          failedAtStart: latestStatus.analysisJobs?.failed ?? 0,
          trainingMomentsAtStart: trainingMomentCount,
          pendingAtStart: snap.pendingUnanalyzedCount,
        });
        const batch = mergeServerAnalysisBatches(
          mergeServerAnalysisBatches(
            serverBatch.current,
            readServerAnalysisBatch(authenticatedOwnerId)
          ),
          incomingBatch
        );
        serverBatch.current = batch;
        setHasTrackedServerBatch(!!batch);
        writeServerAnalysisBatch(authenticatedOwnerId, batch);
      }
      setLastCompletion(null);
      clearLastAnalysisCompletion(authenticatedOwnerId);
      publishLibraryChanged(authenticatedOwnerId, {
        invalidateCompletion: true,
      });
      setServerReviewOpen(false);
      setServerReviewIds([]);
      await refreshAll();
      setCollapsed(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to queue analysis");
    } finally {
      setServerQueueing(false);
    }
  }

  function dismissSuggestion() {
    const next = pending;
    setDismissedForPending(next);
    writeDismissedCount(authenticatedOwnerId, next);
  }

  function dismissCompletion() {
    setLastCompletion(null);
    clearLastAnalysisCompletion(authenticatedOwnerId);
    backgroundAnalysis.clearCompletion(authenticatedOwnerId);
  }

  const completionHasTrainingMoments =
    !!currentCompletion &&
    (currentCompletion.trainingMomentsGenerated ??
      trainingMomentCount ??
      0) > 0;
  const canRetry =
    pending > 0 &&
    (isError ||
      currentCompletion?.status === "failed" ||
      currentCompletion?.status === "partial");
  const billing = currentSyncStatus?.billing;
  const serverReviewOverCapacity =
    !billing || serverReviewIds.length > billing.reservableCredits;

  return (
    <>
      <div className="border-b bg-background">
        <div className="h-1 w-full bg-muted">
          <div
            className={cn("h-full bg-primary transition-[width] duration-200", !isRunning && "opacity-60")}
            style={{ width: `${isRunning ? percent : 0}%` }}
          />
        </div>

        {collapsed && isRunning ? (
          <div className="container flex items-center justify-between gap-3 py-1 text-xs text-muted-foreground">
            <div className="truncate">
              {snap.label || "Analyzing…"} ({Math.round(percent)}%)
            </div>
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(false)}>
              Expand
            </Button>
          </div>
        ) : (
          <div className="container flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0">
              {isRunning ? (
                <div className="text-sm font-medium">
                  {snap.label || "Analyzing games…"}{" "}
                  <span className="text-muted-foreground">({Math.round(percent)}%)</span>
                </div>
              ) : hasServerWork ? (
                <div className="text-sm font-medium">
                  Server analysis{" "}
                  <span className="text-muted-foreground">
                    {serverRunning} running • {serverQueued} queued
                  </span>
                </div>
              ) : isError ? (
                <div className="text-sm font-medium text-destructive">
                  Analysis needs attention{snap.lastError ? `: ${snap.lastError}` : ""}
                </div>
              ) : currentCompletion ? (
                <div className="text-sm font-medium">
                  Analysis complete{" "}
                  <span className="text-muted-foreground">{completionMessage(currentCompletion)}</span>
                </div>
              ) : hasPendingSuggestion ? (
                <div className="text-sm font-medium">
                  You have <span className="font-semibold">{pending}</span> imported games not analyzed yet.
                </div>
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(hasPendingSuggestion || canRetry) && !isRunning && !hasServerWork ? (
                <>
                  <Button size="sm" onClick={onAnalyzePendingInBrowser} disabled={browserStarting || serverQueueing}>
                    {browserStarting ? "Starting..." : canRetry ? "Retry in browser" : "Analyze in browser"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={prepareServerReview} disabled={browserStarting || serverQueueing}>
                    {serverQueueing ? "Checking..." : canRetry ? "Retry on server" : "Analyze on server"}
                  </Button>
                </>
              ) : null}

              {currentCompletion && !isRunning && !hasServerWork ? (
                <>
                  <Button size="sm" onClick={() => router.push(completionHasTrainingMoments ? "/training" : "/games")}>
                    {completionHasTrainingMoments ? "Train decisions" : "View games"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={dismissCompletion}>
                    Dismiss
                  </Button>
                </>
              ) : hasPendingSuggestion && !isRunning && !hasServerWork ? (
                <Button size="sm" variant="ghost" onClick={dismissSuggestion}>
                  Dismiss
                </Button>
              ) : null}

              {isRunning ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => setCollapsed(true)}>
                    Hide
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      backgroundAnalysis.cancel(authenticatedOwnerId);
                      toast.message("Cancelling analysis…");
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : null}
            </div>
          </div>
        )}
      </div>

      <ActionConfirmDialog
        open={serverReviewOpen}
        onOpenChange={setServerReviewOpen}
        title="Queue server analysis?"
        description={`Analyze ${serverReviewIds.length} game${serverReviewIds.length === 1 ? "" : "s"} on the server. This can use up to ${serverReviewIds.length} credit${serverReviewIds.length === 1 ? "" : "s"}.`}
        confirmLabel={`Queue ${serverReviewIds.length} game${serverReviewIds.length === 1 ? "" : "s"}`}
        onConfirm={confirmServerAnalysis}
        busy={serverQueueing}
        confirmDisabled={serverReviewOverCapacity}
      >
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          {billing ? (
            <>
              <div>
                Current balance: <strong>{billing.currentBalance}</strong> •
                Reservable now: <strong>{billing.reservableCredits}</strong> •
                Balance after maximum cost:{" "}
                <strong>{Math.max(0, billing.currentBalance - serverReviewIds.length)}</strong>
              </div>
              {serverReviewOverCapacity ? (
                <div className="text-destructive">
                  {billing.limitingReason ??
                    `This batch exceeds the ${billing.reservableCredits} credits currently reservable.`}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-destructive">
              Credit capacity could not be verified. Close and retry.
            </div>
          )}
          <div>
            Server analysis continues after you close this tab. Each accepted game reserves one credit and stores its generated training moments.
          </div>
        </div>
      </ActionConfirmDialog>
    </>
  );
}

function toastServerQueueResult(result: {
  queued: number;
  skipped: number;
  requested?: number;
  accepted?: number;
  errors?: Array<{ error: string }>;
}) {
  const parts = [`Queued ${result.queued} game${result.queued === 1 ? "" : "s"}`];
  if (result.skipped > 0) parts.push(`${result.skipped} already queued or complete`);
  const rejected =
    result.requested != null && result.accepted != null
      ? Math.max(0, result.requested - result.accepted)
      : 0;
  if (rejected > 0) parts.push(`${rejected} unavailable`);
  if (result.errors?.length) parts.push(`${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`);
  const message = `${parts.join(", ")} for server analysis.`;
  if (result.errors?.length || rejected > 0) toast.warning(message);
  else toast.message(message);
}
