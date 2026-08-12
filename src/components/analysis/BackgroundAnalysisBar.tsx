"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
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
  publishLibraryChanged,
  readLastAnalysisCompletion,
  analysisCompletionStorageKeys,
  ANALYSIS_COMPLETION_EVENT,
  LIBRARY_CHANGED_EVENT,
  type AnalysisCompletionSummary,
} from "@/lib/analysis/analysisCompletion";
import {
  fetchJsonWithTimeout,
  getSyncStatus,
  type SyncStatus,
} from "@/lib/services/gameSync";
import {
  acceptedServerAnalysisCount,
  queueServerAnalysisBatch,
  readTrackedServerAnalysisRequests,
  reconcileTrackedServerAnalysis,
  serverAnalysisTrackingStorageKey,
  SERVER_ANALYSIS_TRACKING_EVENT,
  type TrackedServerAnalysisRequest,
} from "@/lib/analysis/serverAnalysisCoordinator";
import { shouldPollAnalysis } from "@/lib/analysis/analysisRefreshPolicy";

const NEW_DISMISS_PREFIX = "backranq.analysisBar.dismiss.v2";
const BACKGROUND_REFRESH_STEP_TIMEOUT_MS = 10_000;

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error("Background refresh timed out")),
      timeoutMs
    );
    promise.then(resolve, reject).finally(() => window.clearTimeout(timeout));
  });
}

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
    const { response, json } = await fetchJsonWithTimeout(
      "/api/training/feed?limit=50",
      { cache: "no-store" }
    );
    if (!response.ok) return null;
    const parsed = json as {
      items?: unknown[];
    };
    return Array.isArray(parsed.items) ? parsed.items.length : null;
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
      : `, ${summary.trainingMomentsGenerated} practice position${summary.trainingMomentsGenerated === 1 ? "" : "s"}`;
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
  const [trackedServerRequests, setTrackedServerRequests] = React.useState<TrackedServerAnalysisRequest[]>([]);
  const toastedCompletionId = React.useRef<string | null>(null);
  const refreshInFlight = React.useRef<Promise<void> | null>(null);
  const activeOwnerId = React.useRef<string | null>(ownerId);

  const showCompletionToast = React.useCallback(
    (summary: AnalysisCompletionSummary) => {
      if (toastedCompletionId.current === summary.id) return;
      toastedCompletionId.current = summary.id;
      const options = {
        action:
          (summary.trainingMomentsGenerated ?? 0) > 0
            ? { label: "Practice", onClick: () => router.push("/practice") }
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
    setTrackedServerRequests(ownerId ? readTrackedServerAnalysisRequests(ownerId) : []);
    refreshInFlight.current = null;
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
      const [, statusResult, trainingMomentResult] =
        await Promise.allSettled([
          settleWithin(
            backgroundAnalysis.refreshPendingUnanalyzedCount(ownerId),
            BACKGROUND_REFRESH_STEP_TIMEOUT_MS
          ),
          getSyncStatus(),
          fetchTrainingMomentCount(),
          reconcileTrackedServerAnalysis(ownerId),
        ]);
      if (activeOwnerId.current !== ownerId) return;

      const nextStatus =
        statusResult.status === "fulfilled" ? statusResult.value : null;
      const nextTrainingMomentCount =
        trainingMomentResult.status === "fulfilled" ? trainingMomentResult.value : null;
      if (nextStatus) setSyncStatus(nextStatus);
      if (nextTrainingMomentCount != null) setTrainingMomentCount(nextTrainingMomentCount);
      setTrackedServerRequests(readTrackedServerAnalysisRequests(ownerId));
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
    const trackingKey = serverAnalysisTrackingStorageKey(scopedOwnerId);
    function onStorage(event: StorageEvent) {
      if (event.key === keys.completion) {
        setLastCompletion(readLastAnalysisCompletion(scopedOwnerId));
        publishLibraryChanged(scopedOwnerId);
        router.refresh();
      }
      if (event.key === trackingKey) {
        setTrackedServerRequests(readTrackedServerAnalysisRequests(scopedOwnerId));
        void refreshAll();
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [ownerId, refreshAll, router]);

  React.useEffect(() => {
    if (!ownerId) return;
    const scopedOwnerId = ownerId;
    function onTracking(event: Event) {
      const detail = (event as CustomEvent<{ ownerId?: string }>).detail;
      if (detail?.ownerId !== scopedOwnerId) return;
      setTrackedServerRequests(readTrackedServerAnalysisRequests(scopedOwnerId));
    }
    window.addEventListener(SERVER_ANALYSIS_TRACKING_EVENT, onTracking);
    return () => window.removeEventListener(SERVER_ANALYSIS_TRACKING_EVENT, onTracking);
  }, [ownerId]);

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
      setTrackedServerRequests(readTrackedServerAnalysisRequests(scopedOwnerId));
      if (detail.invalidateCompletion) setLastCompletion(null);
      void refreshAll();
    }
    window.addEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
    return () =>
      window.removeEventListener(LIBRARY_CHANGED_EVENT, onLibraryChanged);
  }, [ownerId, refreshAll]);

  const currentSyncStatus =
    activeOwnerId.current === ownerId ? syncStatus : null;
  const trackedPlanning = trackedServerRequests.reduce((sum, request) => sum + request.planning, 0);
  const trackedQueued = trackedServerRequests.reduce((sum, request) => sum + request.queued, 0);
  const trackedRunning = trackedServerRequests.reduce((sum, request) => sum + request.running, 0);
  const serverQueued = trackedPlanning + trackedQueued || currentSyncStatus?.analysisJobs?.queued || 0;
  const serverRunning = trackedRunning || currentSyncStatus?.analysisJobs?.running || 0;
  const hasTrackedServerBatch = trackedServerRequests.length > 0;
  const isRunning = snap.ownerId === ownerId && snap.state === "running";

  React.useEffect(() => {
    if (!shouldPollAnalysis({
      authenticated: sessionStatus === "authenticated",
      ownerId,
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
      const { response, json: responseJson } = await fetchJsonWithTimeout(
        "/api/games?hasAnalysis=false&page=1&limit=25",
        { cache: "no-store" }
      );
      if (activeOwnerId.current !== authenticatedOwnerId) return;
      const json = responseJson as {
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
      const result = await queueServerAnalysisBatch({
        ownerId: authenticatedOwnerId,
        gameIds: serverReviewIds,
      });
      if (result.state === "confirming") {
        toast.message("The server is still confirming this request. Backranq will keep checking it in the background.");
        setServerReviewOpen(false);
        setServerReviewIds([]);
        setCollapsed(false);
        return;
      }
      toastServerQueueResult(result);
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
    !!billing && serverReviewIds.length > billing.reservableGames;

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
                  <Button size="sm" onClick={() => router.push(completionHasTrainingMoments ? "/practice" : "/games")}>
                    {completionHasTrainingMoments ? "Practice positions" : "View games"}
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
        description={`Analyze ${serverReviewIds.length} game${serverReviewIds.length === 1 ? "" : "s"} on the server. This can use up to ${serverReviewIds.length * (billing?.creditsPerGame ?? 10)} credits.`}
        confirmLabel={`Queue ${serverReviewIds.length} game${serverReviewIds.length === 1 ? "" : "s"}`}
        onConfirm={confirmServerAnalysis}
        busy={serverQueueing}
        allowCloseWhileBusy
        confirmDisabled={false}
      >
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
          {billing ? (
            <>
              <div>
                Current balance: <strong>{billing.currentBalance}</strong> •
                Reservable now: <strong>{billing.reservableGames} games</strong> •
                Quality: <strong>{billing.analysisQuality === "THOROUGH" ? "Thorough" : "Standard"}</strong> •
                Balance after maximum cost:{" "}
                <strong>{Math.max(0, billing.currentBalance - serverReviewIds.length * billing.creditsPerGame)}</strong>
              </div>
              <div>
                <Link href="/settings#analysis-defaults" className="underline">
                  Change analysis quality
                </Link>
              </div>
              {serverReviewOverCapacity ? (
                <div className="text-destructive">
                  {billing.limitingReason ??
                    `This batch exceeds the ${billing.reservableGames} games currently reservable at ${billing.creditsPerGame} credits each.`}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-muted-foreground">
              Current credit capacity is unavailable. The server will apply the authoritative limits while planning this batch.
            </div>
          )}
          <div>
            Server analysis continues after you close this tab. Each accepted game reserves {billing?.creditsPerGame ?? 10} credits and saves the practice positions it finds.
          </div>
        </div>
      </ActionConfirmDialog>
    </>
  );
}

function toastServerQueueResult(result: {
  batch: {
    requested: number;
    planning: number;
    queued: number;
    running: number;
    skipped: number;
    failed: number;
  };
}) {
  const accepted = acceptedServerAnalysisCount(result.batch);
  const parts = [`Accepted ${accepted} game${accepted === 1 ? "" : "s"}`];
  if (result.batch.skipped > 0) parts.push(`${result.batch.skipped} already queued or complete`);
  if (result.batch.failed > 0) parts.push(`${result.batch.failed} unavailable`);
  const message = `${parts.join(", ")} for server analysis.`;
  if (result.batch.failed > 0) toast.warning(message);
  else toast.message(message);
}
