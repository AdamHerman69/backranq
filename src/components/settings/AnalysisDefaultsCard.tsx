"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  defaultPreferences,
  pickAnalysisDefaults,
  type AnalysisDefaults,
  type PreferencesSchema,
} from "@/lib/preferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AnalysisDefaultsFields,
  analysisDefaultsAreValid,
} from "@/components/analysis/AnalysisDefaultsFields";

export function analysisDefaultsEqual(
  left: AnalysisDefaults,
  right: AnalysisDefaults,
): boolean {
  return (
    left.analysisNodesPerPosition === right.analysisNodesPerPosition &&
    left.confirmationNodes === right.confirmationNodes &&
    left.themeLookaheadPlies === right.themeLookaheadPlies &&
    left.trainingCoveragePreset === right.trainingCoveragePreset &&
    left.trainingGradingTolerance === right.trainingGradingTolerance
  );
}

export function AnalysisDefaultsCard() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [analysisDefaults, setAnalysisDefaults] = React.useState<AnalysisDefaults>(
    () => pickAnalysisDefaults(defaultPreferences())
  );
  const [savedDefaults, setSavedDefaults] =
    React.useState<AnalysisDefaults | null>(null);
  const requestIdRef = React.useRef(0);
  const valid = analysisDefaultsAreValid(analysisDefaults);
  const dirty =
    savedDefaults !== null &&
    !analysisDefaultsEqual(analysisDefaults, savedDefaults);
  const canSave =
    valid &&
    dirty &&
    !loading &&
    !busy &&
    loadError === null;

  const load = React.useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/user/preferences", { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as {
        preferences?: PreferencesSchema;
        error?: string;
      };
      if (!res.ok) throw new Error(json?.error ?? "Failed to load preferences");
      if (!json.preferences) throw new Error("Missing preferences");
      if (requestId !== requestIdRef.current) return;
      const loaded = pickAnalysisDefaults(json.preferences);
      setAnalysisDefaults(loaded);
      setSavedDefaults(loaded);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setSavedDefaults(null);
      setLoadError(
        error instanceof Error ? error.message : "Failed to load preferences",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    return () => {
      requestIdRef.current += 1;
    };
  }, [load]);

  function resetToAppDefaults() {
    if (savedDefaults === null || loading || busy) return;
    setAnalysisDefaults(pickAnalysisDefaults(defaultPreferences()));
    toast.message("Reset to app defaults.");
  }

  async function save() {
    if (!canSave) return;
    const id = toast.loading("Saving analysis defaults…");
    setBusy(true);
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
      toast.success("Analysis defaults saved.", { id });
      const persisted = json.preferences
        ? pickAnalysisDefaults(json.preferences)
        : analysisDefaults;
      setAnalysisDefaults(persisted);
      setSavedDefaults(persisted);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed", { id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Analysis defaults</CardTitle>
        <CardDescription>
          These settings are used by background analysis (and can be overridden when starting analysis).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AnalysisDefaultsFields
          value={analysisDefaults}
          onChange={setAnalysisDefaults}
          disabled={busy || loading || loadError !== null}
        />
        {loading ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading your current analysis defaults…
          </p>
        ) : null}
        {loadError ? (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3"
            role="alert"
          >
            <p className="text-sm text-destructive">
              We could not load your saved analysis defaults. Nothing can be
              changed until they are loaded.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{loadError}</p>
            <Button
              className="mt-3"
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={loading || busy}
            >
              Retry
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={resetToAppDefaults}
            disabled={busy || loading || savedDefaults === null}
          >
            Reset
          </Button>
          <Button
            type="button"
            onClick={save}
            disabled={!canSave}
          >
            Save
          </Button>
          {!loading &&
          !loadError &&
          savedDefaults !== null &&
          !dirty ? (
            <p className="text-xs text-muted-foreground" role="status">
              Saved
            </p>
          ) : null}
          {!valid ? (
            <p className="text-xs text-destructive" role="status">
              Open Advanced analysis and correct the highlighted value before
              saving.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
