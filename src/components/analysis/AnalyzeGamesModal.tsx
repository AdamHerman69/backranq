"use client";

import * as React from "react";
import { toast } from "sonner";

import { backgroundAnalysis } from "@/lib/analysis/backgroundAnalysisManager";
import { providerToUi, timeClassToUi } from "@/lib/api/games";
import type { Provider, TimeClass } from "@prisma/client";
import {
  defaultPreferences,
  pickAnalysisDefaults,
  type AnalysisDefaults,
  type PreferencesSchema,
} from "@/lib/preferences";
import { AnalysisDefaultsFields } from "@/components/analysis/AnalysisDefaultsFields";

type ApiGameRow = {
  id: string;
  provider: Provider;
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
  const [busy, setBusy] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [games, setGames] = React.useState<ApiGameRow[]>([]);
  const [selected, setSelected] = React.useState<Record<string, boolean>>({});
  const [prefsLoading, setPrefsLoading] = React.useState(false);
  const [analysisDefaults, setAnalysisDefaults] = React.useState<AnalysisDefaults>(
    () => pickAnalysisDefaults(defaultPreferences())
  );

  React.useEffect(() => {
    if (!open) return;
    setBusy(false);
    setLoading(true);
    setGames([]);
    setSelected({});
    setPrefsLoading(true);
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

    fetch("/api/games?hasAnalysis=false&page=1&limit=50", { cache: "no-store" })
      .then(async (r) => {
        const json = (await r.json().catch(() => ({}))) as { games?: ApiGameRow[]; error?: string };
        if (!r.ok) throw new Error(json?.error ?? "Failed to load games");
        const rows = Array.isArray(json.games) ? json.games : [];
        setGames(rows);
        const next: Record<string, boolean> = {};
        for (const g of rows) next[g.id] = true;
        setSelected(next);
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

  if (!open) return null;

  function close() {
    if (busy) return;
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
    const id = toast.loading("Saving defaults…");
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
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
    setBusy(true);
    try {
      backgroundAnalysis.enqueueGameDbIdsWithOptions(ids, {
        analysisDefaults,
      });
      void backgroundAnalysis.refreshPendingUnanalyzedCount();
      toast.message("Analysis started in the background.");
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
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
            className="h-9 rounded-md border px-3 text-sm font-medium"
            disabled={busy}
          >
            Close
          </button>
        </div>

        <div className="mt-2 text-sm text-muted-foreground">
          Pick which games to analyze. Analysis runs in the background so you can keep browsing.
        </div>

        <div className="mt-4 flex-1 overflow-auto">
          <div className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">Puzzle analysis settings</div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="h-9 rounded-md border px-3 text-sm font-medium"
                  onClick={resetToAppDefaults}
                  disabled={busy || prefsLoading}
                >
                  Reset to defaults
                </button>
                <button
                  type="button"
                  className="h-9 rounded-md border px-3 text-sm font-medium"
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

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-muted-foreground">
              {loading
                ? "Loading…"
                : `${games.length} unanalyzed game${games.length === 1 ? "" : "s"} found`}
              {selectedIds.length ? ` • ${selectedIds.length} selected` : ""}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="h-9 rounded-md border px-3 text-sm font-medium"
                onClick={() => toggleAll(true)}
                disabled={busy || loading || games.length === 0}
              >
                Select all
              </button>
              <button
                type="button"
                className="h-9 rounded-md border px-3 text-sm font-medium"
                onClick={() => toggleAll(false)}
                disabled={busy || loading || games.length === 0}
              >
                Select none
              </button>
              <button
                type="button"
                className="h-9 rounded-md bg-primary px-3 text-sm font-semibold text-primary-foreground"
                onClick={analyzeSelected}
                disabled={busy || loading || selectedIds.length === 0}
              >
                Analyze selected
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="p-3" />
                  <th className="p-3">When</th>
                  <th className="p-3">Provider</th>
                  <th className="p-3">Time</th>
                  <th className="p-3">Players</th>
                  <th className="p-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {games.map((g) => {
                  const provider = providerToUi(g.provider);
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

