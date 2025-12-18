"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { backgroundAnalysis, type BackgroundAnalysisSnapshot } from "@/lib/analysis/backgroundAnalysisManager";

const NEW_DISMISS_KEY = "backranq.analysisBar.dismiss.v1";
const OLD_DISMISS_KEY = "backrank.analysisBar.dismiss.v1";

function readDismissedCount(): number {
  try {
    const rawNew = localStorage.getItem(NEW_DISMISS_KEY);
    const rawOld = rawNew ? null : localStorage.getItem(OLD_DISMISS_KEY);
    const raw = rawNew ?? rawOld;
    const parsed = raw ? (JSON.parse(raw) as { dismissedForPending?: number }) : null;
    if (rawOld) {
      // Back-compat: migrate old key to new key.
      try {
        localStorage.setItem(NEW_DISMISS_KEY, rawOld);
        localStorage.removeItem(OLD_DISMISS_KEY);
      } catch {
        // ignore
      }
    }
    return typeof parsed?.dismissedForPending === "number" ? parsed.dismissedForPending : 0;
  } catch {
    return 0;
  }
}

function writeDismissedCount(n: number) {
  try {
    localStorage.setItem(NEW_DISMISS_KEY, JSON.stringify({ dismissedForPending: n }));
    localStorage.removeItem(OLD_DISMISS_KEY);
  } catch {
    // ignore
  }
}

export function BackgroundAnalysisBar() {
  const [snap, setSnap] = React.useState<BackgroundAnalysisSnapshot>(() => backgroundAnalysis.snapshot());
  const [collapsed, setCollapsed] = React.useState(false);
  const [dismissedForPending, setDismissedForPending] = React.useState(0);

  React.useEffect(() => {
    setDismissedForPending(readDismissedCount());
    return backgroundAnalysis.subscribe(setSnap);
  }, []);

  React.useEffect(() => {
    void backgroundAnalysis.refreshPendingUnanalyzedCount();
    const t = setInterval(() => void backgroundAnalysis.refreshPendingUnanalyzedCount(), 30_000);
    return () => clearInterval(t);
  }, []);

  const pending = snap.pendingUnanalyzedCount ?? 0;
  const hasPendingSuggestion = pending > 0 && pending > dismissedForPending;
  const isRunning = snap.state === "running";
  const isError = snap.state === "error";

  const shouldShow = isRunning || isError || hasPendingSuggestion;
  if (!shouldShow) return null;

  const percent = Math.max(0, Math.min(100, snap.percent));

  async function onAnalyzePending() {
    try {
      await backgroundAnalysis.enqueuePendingUnanalyzed({ limit: 25 });
      toast.message("Analysis started in the background.");
      setCollapsed(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start analysis");
    }
  }

  function dismissSuggestion() {
    const next = pending;
    setDismissedForPending(next);
    writeDismissedCount(next);
  }

  return (
    <div className="border-b bg-background">
      {/* progress meter */}
      <div className="h-1 w-full bg-muted">
        <div
          className={cn("h-full bg-primary transition-[width] duration-200", !isRunning && "opacity-60")}
          style={{ width: `${isRunning ? percent : hasPendingSuggestion ? 0 : percent}%` }}
        />
      </div>

      {/* content */}
      {collapsed && isRunning ? (
        <div className="container flex items-center justify-between gap-3 py-1 text-xs text-muted-foreground">
          <div className="truncate">
            {snap.label || `Analyzing…`} ({Math.round(percent)}%)
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
            ) : hasPendingSuggestion ? (
              <div className="text-sm font-medium">
                You have <span className="font-semibold">{pending}</span> imported games not analyzed yet.
              </div>
            ) : isError ? (
              <div className="text-sm font-medium text-destructive">
                Analysis failed{snap.lastError ? `: ${snap.lastError}` : ""}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {hasPendingSuggestion && !isRunning ? (
              <>
                <Button size="sm" onClick={onAnalyzePending}>
                  Analyze now
                </Button>
                <Button size="sm" variant="outline" onClick={dismissSuggestion}>
                  Close
                </Button>
              </>
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
                    backgroundAnalysis.cancel();
                    toast.message("Cancelled analysis.");
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
  );
}


