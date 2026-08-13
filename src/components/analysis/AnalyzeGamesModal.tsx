"use client";

import * as React from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { EXPECTED_OWNER_HEADER } from "@/lib/auth/ownerContract";
import {
  advanceOwnerEpoch,
  captureOwnerRun,
  isOwnerRunCurrent,
  type OwnerEpoch,
  type OwnerRunToken,
} from "@/lib/auth/ownerRun";

import { gameSourceToUi, timeClassToUi } from "@/lib/api/games";
import { backgroundAnalysis } from "@/lib/analysis/backgroundAnalysisManager";
import { getSyncStatus, type SyncStatus } from "@/lib/services/gameSync";
import type { GameSource, TimeClass } from "@prisma/client";
import {
  defaultPreferences,
  pickAnalysisDefaults,
  type AnalysisDefaults,
  type PreferencesSchema,
} from "@/lib/preferences";
import { AnalysisDefaultsFields } from "@/components/analysis/AnalysisDefaultsFields";
import { analysisCreditsPerGame } from "@/lib/analysis/quality";
import {
  clearLastAnalysisCompletion,
  publishLibraryChanged,
} from "@/lib/analysis/analysisCompletion";
import {
  acceptedServerAnalysisCount,
  queueServerAnalysisBatch,
} from "@/lib/analysis/serverAnalysisCoordinator";
import { ModalDialog } from "@/components/ui/ModalDialog";

type ApiGameRow = {
  id: string;
  provider: GameSource;
  playedAt: string;
  timeClass: TimeClass;
  whiteName: string;
  blackName: string;
  result: string | null;
  analyzedAt: string | null;
};

export function AnalyzeGamesModal({
  open,
  onClose,
  title = "Analyze games",
  returnFocusElement,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  returnFocusElement?: HTMLElement | null;
}) {
  const { data: session } = useSession();
  const ownerId = session?.user?.id ?? null;
  const ownerEpochRef = React.useRef<OwnerEpoch>({ ownerId: null, generation: 0 });
  ownerEpochRef.current = advanceOwnerEpoch(ownerEpochRef.current, ownerId);
  const loadGenerationRef = React.useRef(0);
  const loadControllerRef = React.useRef<AbortController | null>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  if (open && returnFocusElement) {
    returnFocusRef.current = returnFocusElement;
  }
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [games, setGames] = React.useState<ApiGameRow[]>([]);
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [prefsLoading, setPrefsLoading] = React.useState(false);
  const [analysisMode, setAnalysisMode] = React.useState<"browser" | "server" | null>(null);
  const [analysisDefaults, setAnalysisDefaults] = React.useState<AnalysisDefaults>(
    () => pickAnalysisDefaults(defaultPreferences())
  );
  const [serverCapacity, setServerCapacity] = React.useState<
    SyncStatus["billing"] | null
  >(null);
  const [loadedOwnerId, setLoadedOwnerId] = React.useState<string | null>(null);

  React.useEffect(() => {
    const generation = ++loadGenerationRef.current;
    loadControllerRef.current?.abort();
    setLoadedOwnerId(null);
    if (!open || !ownerId) return;
    const controller = new AbortController();
    loadControllerRef.current = controller;
    let ownerMismatch = false;
    const isCurrent = () =>
      !controller.signal.aborted &&
      generation === loadGenerationRef.current &&
      ownerEpochRef.current.ownerId === ownerId;
    const rejectOwner = (message: string) => {
      if (!isCurrent() || ownerMismatch) return;
      ownerMismatch = true;
      setLoadedOwnerId(null);
      setGames([]);
      toast.error(message);
    };

    setBusy(false);
    setLoading(true);
    setGames([]);
    setSelected({});
    setAnalysisMode(null);
    setPrefsLoading(true);
    setServerCapacity(null);
    setAnalysisDefaults(pickAnalysisDefaults(defaultPreferences()));

    const preferencesPromise = fetch("/api/user/preferences", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          ownerId?: string;
          preferences?: PreferencesSchema;
          error?: string;
        };
        if (!r.ok) throw new Error(json?.error ?? "Failed to load preferences");
        if (json.ownerId !== ownerId) {
          rejectOwner("The server returned analysis settings for a different account.");
          throw new Error("Preferences belong to a different account");
        }
        if (!json.preferences) throw new Error("Missing preferences");
        if (!isCurrent()) return;
        setAnalysisDefaults(pickAnalysisDefaults(json.preferences));
      })
      .catch(() => {
        // ignore: we keep defaults
      })
      .finally(() => {
        if (isCurrent()) setPrefsLoading(false);
      });

    const statusPromise = getSyncStatus({ signal: controller.signal })
      .then((status) => {
        if (!isCurrent()) return;
        if (status.ownerId !== ownerId) {
          rejectOwner("The server returned analysis capacity for a different account.");
          throw new Error("Analysis capacity belongs to a different account");
        }
        setServerCapacity(status.billing ?? null);
      })
      .catch(() => {
        if (!isCurrent()) return;
        // The enqueue API remains authoritative if capacity cannot be previewed.
        setServerCapacity(null);
      });

    const gamesPromise = fetch("/api/games?hasAnalysis=false&page=1&limit=50", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          ownerId?: string;
          games?: ApiGameRow[];
          error?: string;
        };
        if (!r.ok) throw new Error(json?.error ?? "Failed to load games");
        if (json.ownerId !== ownerId) {
          rejectOwner("The server returned games for a different account.");
          throw new Error("Games belong to a different account");
        }
        if (!isCurrent() || ownerMismatch) return;
        const rows = Array.isArray(json.games) ? json.games : [];
        setGames(rows);
        setLoadedOwnerId(ownerId);
      })
      .catch((e) => {
        if (!isCurrent() || ownerMismatch) return;
        toast.error(e instanceof Error ? e.message : "Failed to load games");
        setGames([]);
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });

    void Promise.allSettled([preferencesPromise, statusPromise, gamesPromise]);
    return () => {
      controller.abort();
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    };
  }, [open, ownerId]);

  const selectedIds = React.useMemo(() => {
    return Object.entries(selected)
      .filter(([, v]) => v)
      .map(([id]) => id);
  }, [selected]);
  const creditsPerGame = analysisCreditsPerGame(analysisDefaults.analysisQuality);
  const serverQueueableGames = serverCapacity
    ? Math.floor(serverCapacity.reservableCredits / creditsPerGame)
    : null;
  const ownerLoaded = loadedOwnerId === ownerId;

  if (!open || !ownerId) return null;

  function runIsCurrent(run: OwnerRunToken, generation: number) {
    return (
      isOwnerRunCurrent(run, ownerEpochRef.current) &&
      generation === loadGenerationRef.current &&
      loadedOwnerId === run.ownerId
    );
  }

  function close() {
    onClose();
  }

  function toggleAll(v: boolean) {
    const next: Record<string, boolean> = {};
    for (const g of games) next[g.id] = v;
    setSelected(next);
  }

  function resetToAppDefaults() {
    setAnalysisDefaults(pickAnalysisDefaults(defaultPreferences()));
    toast.message("Reset to app defaults.");
  }

  async function saveAsDefaults() {
    const run = captureOwnerRun(ownerEpochRef.current);
    const generation = loadGenerationRef.current;
    if (!run || !runIsCurrent(run, generation)) {
      toast.error("Your session changed. Reopen analysis and try again.");
      return;
    }
    const id = toast.loading("Saving defaults…");
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [EXPECTED_OWNER_HEADER]: run.ownerId,
        },
        body: JSON.stringify(analysisDefaults),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ownerId?: string;
        preferences?: PreferencesSchema;
        error?: string;
      };
      if (!res.ok) throw new Error(json?.error ?? "Save failed");
      if (json.ownerId !== run.ownerId) {
        throw new Error("Your session changed before the defaults were saved.");
      }
      if (!runIsCurrent(run, generation)) {
        toast.dismiss(id);
        return;
      }
      toast.success("Defaults saved.", { id });
      if (json.preferences) setAnalysisDefaults(pickAnalysisDefaults(json.preferences));
    } catch (e) {
      if (!runIsCurrent(run, generation)) {
        toast.dismiss(id);
        return;
      }
      toast.error(e instanceof Error ? e.message : "Save failed", { id });
    }
  }

  async function analyzeSelected() {
    const run = captureOwnerRun(ownerEpochRef.current);
    const generation = loadGenerationRef.current;
    const ids = selectedIds;
    if (ids.length === 0) {
      toast.message("Select at least one game.");
      return;
    }
    if (!analysisMode) {
      toast.message("Choose browser or server analysis.");
      return;
    }
    if (!run || !runIsCurrent(run, generation)) {
      toast.error("Your session changed. Reopen analysis and try again.");
      return;
    }
    if (analysisMode === "server") {
      const totalCredits = ids.length * creditsPerGame;
      const ok = window.confirm(
        `Queue ${analysisDefaults.analysisQuality === "THOROUGH" ? "Thorough" : "Standard"} server analysis for ${ids.length} game${ids.length === 1 ? "" : "s"}? This will reserve ${totalCredits} server credits (${creditsPerGame} per game).`
      );
      if (!ok) return;
    }
    backgroundAnalysis.setOwner(run.ownerId);
    setBusy(true);
    try {
      if (analysisMode === "browser") {
        const enqueue = backgroundAnalysis.enqueueGameDbIdsWithOptions(run.ownerId, ids, { analysisDefaults });
        if (enqueue.acceptedIds.length > 0) {
          clearLastAnalysisCompletion(run.ownerId);
          publishLibraryChanged(run.ownerId, { invalidateCompletion: true });
          toast.message(
            `Browser analysis started for ${enqueue.acceptedIds.length} game${enqueue.acceptedIds.length === 1 ? "" : "s"}. Keep this tab open.`
          );
        } else {
          toast.message("Those games are already queued or being analyzed in this browser.");
        }
      } else {
        const result = await queueServerAnalysisBatch({
          ownerId: run.ownerId,
          gameIds: ids,
          analysisDefaults,
        });
        if (!runIsCurrent(run, generation)) return;
        if (result.state === "confirming") {
          toast.message("The server is still confirming this request. Backranq will keep checking it in the background.");
        } else {
          toastServerQueueResult(result.batch);
        }
      }
      if (!runIsCurrent(run, generation)) return;
      onClose();
    } catch (e) {
      if (!runIsCurrent(run, generation)) return;
      toast.error(e instanceof Error ? e.message : "Failed to start analysis");
    } finally {
      if (runIsCurrent(run, generation)) setBusy(false);
    }
  }

  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
      }}
      title={title}
      description="Pick which games to analyze and choose whether this device or the server should do the work."
      className="flex max-h-[calc(100vh-2rem)] max-w-5xl flex-col"
      bodyClassName="min-h-0 flex-1"
      onOpenAutoFocus={() => {
        if (returnFocusRef.current) return;
        const active = document.activeElement;
        returnFocusRef.current = active instanceof HTMLElement ? active : null;
      }}
      onCloseAutoFocus={(event) => {
        const target = returnFocusRef.current;
        if (!target?.isConnected) return;
        event.preventDefault();
        target.focus();
      }}
    >
      <div
        aria-busy={busy}
        className="flex min-h-0 flex-col"
      >
        <div className="sr-only" role="status" aria-live="polite">
          {busy ? "Request in progress. You may close this dialog while Backranq continues in the background." : ""}
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">Practice position settings</div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="h-11 rounded-md border px-3 text-sm font-medium sm:h-9"
                  onClick={resetToAppDefaults}
                  disabled={busy || prefsLoading}
                >
                  Reset to defaults
                </button>
                <button
                  type="button"
                  className="h-11 rounded-md border px-3 text-sm font-medium sm:h-9"
                  onClick={saveAsDefaults}
                  disabled={busy || prefsLoading || !ownerLoaded}
                >
                  Save as defaults
                </button>
              </div>
            </div>
            <div className="mt-2">
              <AnalysisDefaultsFields
                value={analysisDefaults}
                onChange={setAnalysisDefaults}
                disabled={busy || prefsLoading}
                dense
              />
            </div>
          </div>

          <div className="sticky top-0 z-10 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/95 p-2 shadow-sm backdrop-blur">
            <div className="text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : `${games.length} unanalyzed game${games.length === 1 ? "" : "s"} found`}
              {selectedIds.length ? ` • ${selectedIds.length} selected` : ""}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="h-11 rounded-md border px-3 text-sm font-medium sm:h-9"
                onClick={() => toggleAll(true)}
                disabled={busy || loading || !ownerLoaded || games.length === 0}
              >
                Select all
              </button>
              <button
                type="button"
                className="h-11 rounded-md border px-3 text-sm font-medium sm:h-9"
                onClick={() => toggleAll(false)}
                disabled={busy || loading || !ownerLoaded || games.length === 0}
              >
                Select none
              </button>
              <button
                type="button"
                className="h-11 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground sm:h-9"
                onClick={analyzeSelected}
                disabled={
                  busy ||
                  loading ||
                  !ownerLoaded ||
                  selectedIds.length === 0 ||
                  !analysisMode
                }
              >
                {analysisMode === "browser"
                  ? "Analyze in browser"
                  : analysisMode === "server"
                    ? "Analyze on server"
                    : "Choose analysis mode"}
              </button>
            </div>
          </div>

          <fieldset className="mt-4 grid gap-3 sm:grid-cols-2">
            <legend className="sr-only">Analysis mode</legend>
            <label className="rounded-lg border p-3 text-sm">
              <div className="flex items-start gap-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="analysis-mode"
                  checked={analysisMode === "browser"}
                  onChange={() => setAnalysisMode("browser")}
                  disabled={busy || !ownerLoaded}
                />
                <span>
                  <span className="block font-medium">Analyze in browser</span>
                  <span className="text-muted-foreground">
                    Free. Uses this device and this tab must stay open. Best for small batches.
                  </span>
                </span>
              </div>
            </label>
            <label className="rounded-lg border p-3 text-sm">
              <div className="flex items-start gap-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="analysis-mode"
                  checked={analysisMode === "server"}
                  onChange={() => setAnalysisMode("server")}
                  disabled={busy || !ownerLoaded}
                />
                <span>
                  <span className="block font-medium">Analyze on server</span>
                  <span className="text-muted-foreground">
                    Uses up to {(selectedIds.length || 0) * creditsPerGame} server credits ({creditsPerGame} per game). Continues in the background.
                    {serverQueueableGames !== null
                      ? ` Current capacity: ${serverQueueableGames} game${serverQueueableGames === 1 ? "" : "s"} at this quality.`
                      : ""}
                  </span>
                </span>
              </div>
            </label>
          </fieldset>

          <div className="mt-4 overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="p-3" scope="col"><span className="sr-only">Select</span></th>
                  <th className="p-3" scope="col">When</th>
                  <th className="p-3" scope="col">Game source</th>
                  <th className="p-3" scope="col">Time</th>
                  <th className="p-3" scope="col">Players</th>
                  <th className="p-3" scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const provider = gameSourceToUi(g.provider);
                  const timeClass = timeClassToUi(g.timeClass);
                  return (
                    <tr key={g.id} className="border-t">
                      <td className="p-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${g.whiteName} versus ${g.blackName}`}
                          checked={!!selected[g.id]}
                          onChange={(e) =>
                            setSelected((s) => ({
                              ...s,
                              [g.id]: e.target.checked,
                            }))
                          }
                          disabled={busy || !ownerLoaded}
                        />
                      </td>
                      <td className="p-3 font-mono text-xs">
                        {new Date(g.playedAt).toLocaleString()}
                      </td>
                      <td className="p-3">{provider}</td>
                      <td className="p-3">{timeClass}</td>
                      <td className="p-3">
                        {g.whiteName} vs {g.blackName}
                      </td>
                      <td className="p-3">{g.result ?? "—"}</td>
                    </tr>
                  );
                })}
                {!loading && games.length === 0 ? (
                  <tr>
                    <td
                      className="p-3 text-sm text-muted-foreground"
                      colSpan={6}
                    >
                      No unanalyzed games found.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}

function toastServerQueueResult(result: {
  requested: number;
  planning: number;
  queued: number;
  running: number;
  skipped: number;
  failed: number;
}) {
  const accepted = acceptedServerAnalysisCount(result);
  const parts = [
    `Accepted ${accepted} game${accepted === 1 ? "" : "s"}`,
  ];
  if (result.skipped > 0) {
    parts.push(`${result.skipped} already queued or complete`);
  }
  if (result.failed > 0) parts.push(`${result.failed} unavailable`);

  const message = `${parts.join(", ")} for server analysis.`;
  if (result.failed > 0) toast.warning(message);
  else toast.message(message);
}
