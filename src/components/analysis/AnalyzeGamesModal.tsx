"use client";

import * as React from "react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { EXPECTED_OWNER_HEADER } from "@/lib/auth/ownerContract";

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
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
}) {
  const { data: session } = useSession();
  const ownerId = session?.user?.id ?? null;
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

  React.useEffect(() => {
    if (!open) return;
    setBusy(false);
    setLoading(true);
    setGames([]);
    setSelected({});
    setAnalysisMode(null);
    setPrefsLoading(true);
    setServerCapacity(null);
    setAnalysisDefaults(pickAnalysisDefaults(defaultPreferences()));

    fetch("/api/user/preferences", { cache: "no-store" })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as {
          preferences?: PreferencesSchema;
          error?: string;
        };
        if (!r.ok) throw new Error(json?.error ?? "Failed to load preferences");
        if (!json.preferences) throw new Error("Missing preferences");
        setAnalysisDefaults(pickAnalysisDefaults(json.preferences));
      })
      .catch(() => {
        // ignore: we keep defaults
      })
      .finally(() => setPrefsLoading(false));

    getSyncStatus()
      .then((status) => {
        setServerCapacity(status.billing ?? null);
      })
      .catch(() => {
        // The enqueue API remains authoritative if capacity cannot be previewed.
        setServerCapacity(null);
      });

    fetch("/api/games?hasAnalysis=false&page=1&limit=50", { cache: "no-store" })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as { games?: ApiGameRow[]; error?: string };
        if (!r.ok) throw new Error(json?.error ?? "Failed to load games");
        const rows = Array.isArray(json.games) ? json.games : [];
        setGames(rows);
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : "Failed to load games");
        setGames([]);
      })
      .finally(() => setLoading(false));
  }, [open]);

  const selectedIds = React.useMemo(() => {
    return Object.entries(selected)
      .filter(([, v]) => v)
      .map(([id]) => id);
  }, [selected]);
  const creditsPerGame = analysisCreditsPerGame(analysisDefaults.analysisQuality);
  const serverQueueableGames = serverCapacity
    ? Math.floor(serverCapacity.reservableCredits / creditsPerGame)
    : null;

  React.useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

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
    if (!ownerId) {
      toast.error("Your session changed. Reopen analysis and try again.");
      return;
    }
    const id = toast.loading("Saving defaults…");
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [EXPECTED_OWNER_HEADER]: ownerId,
        },
        body: JSON.stringify(analysisDefaults),
      });
      const json = (await res.json().catch(() => ({}))) as {
        preferences?: PreferencesSchema;
        error?: string;
      };
      if (!res.ok) throw new Error(json?.error ?? "Save failed");
      toast.success("Defaults saved.", { id });
      if (json.preferences) setAnalysisDefaults(pickAnalysisDefaults(json.preferences));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed", { id });
    }
  }

  async function analyzeSelected() {
    const ids = selectedIds;
    if (ids.length === 0) {
      toast.message("Select at least one game.");
      return;
    }
    if (!analysisMode) {
      toast.message("Choose browser or server analysis.");
      return;
    }
    if (!ownerId) {
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
    backgroundAnalysis.setOwner(ownerId);
    setBusy(true);
    try {
      if (analysisMode === "browser") {
        backgroundAnalysis.enqueueGameDbIdsWithOptions(ownerId, ids, { analysisDefaults });
        clearLastAnalysisCompletion(ownerId);
        publishLibraryChanged(ownerId, { invalidateCompletion: true });
        toast.message(
          `Browser analysis started for ${ids.length} game${ids.length === 1 ? "" : "s"}. Keep this tab open.`
        );
      } else {
        const result = await queueServerAnalysisBatch({
          ownerId,
          gameIds: ids,
          analysisDefaults,
        });
        if (result.state === "confirming") {
          toast.message("The server is still confirming this request. Backranq will keep checking it in the background.");
        } else {
          toastServerQueueResult(result.batch);
        }
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to start analysis");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-busy={busy}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={close}
    >
      <div
        className="flex w-full max-w-5xl flex-col rounded-xl border bg-card p-4 text-card-foreground shadow-lg"
        style={{ maxHeight: "calc(100vh - 2rem)" }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="text-base font-semibold">{title}</div>
          <button
            type="button"
            onClick={close}
            className="h-11 rounded-md border px-3 text-sm font-medium sm:h-9"
          >
            Close
          </button>
        </div>

        <div className="mt-2 text-sm text-muted-foreground">
          Pick which games to analyze and choose whether this device or the server should do the work.
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {busy ? "Request in progress. You may close this dialog while Backranq continues in the background." : ""}
        </div>

        <div className="mt-4 flex-1 overflow-auto">
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
                  disabled={busy || prefsLoading}
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
                disabled={busy || loading || games.length === 0}
              >
                Select all
              </button>
              <button
                type="button"
                className="h-11 rounded-md border px-3 text-sm font-medium sm:h-9"
                onClick={() => toggleAll(false)}
                disabled={busy || loading || games.length === 0}
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

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="rounded-lg border p-3 text-sm">
              <div className="flex items-start gap-3">
                <input
                  className="mt-1"
                  type="radio"
                  name="analysis-mode"
                  checked={analysisMode === "browser"}
                  onChange={() => setAnalysisMode("browser")}
                  disabled={busy}
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
                  disabled={busy}
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
          </div>

          <div className="mt-4 overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="p-3" />
                  <th className="p-3">When</th>
                  <th className="p-3">GameSource</th>
                  <th className="p-3">Time</th>
                  <th className="p-3">Players</th>
                  <th className="p-3">Result</th>
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
                          checked={!!selected[g.id]}
                          onChange={(e) =>
                            setSelected((s) => ({
                              ...s,
                              [g.id]: e.target.checked,
                            }))
                          }
                          disabled={busy}
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
    </div>
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
