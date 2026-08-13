"use client";

import * as React from "react";
import { Gauge } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "next-auth/react";
import { EXPECTED_OWNER_HEADER } from "@/lib/auth/ownerContract";
import {
  advanceOwnerEpoch,
  captureOwnerRun,
  isOwnerRunGenerationCurrent,
  resolveSessionOwnerId,
  type OwnerEpoch,
} from "@/lib/auth/ownerRun";

import {
  defaultPreferences,
  pickAnalysisDefaults,
  type AnalysisDefaults,
  type PreferencesSchema,
} from "@/lib/preferences";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InlineStatus } from "@/components/ui/async-state";
import { LoadingButton } from "@/components/ui/loading-button";
import {
  AnalysisDefaultsFields,
  analysisDefaultsAreValid,
} from "@/components/analysis/AnalysisDefaultsFields";

export function analysisDefaultsEqual(
  left: AnalysisDefaults,
  right: AnalysisDefaults,
): boolean {
  return (
    left.analysisQuality === right.analysisQuality &&
    left.trainingCoveragePreset === right.trainingCoveragePreset &&
    left.trainingGradingTolerance === right.trainingGradingTolerance
  );
}

export function AnalysisDefaultsCard({ ownerId: initialOwnerId }: { ownerId: string }) {
  const { data: session, status: sessionStatus } = useSession();
  const activeOwnerId = resolveSessionOwnerId({
    sessionStatus,
    liveOwnerId: session?.user?.id ?? null,
    initialOwnerId,
  });
  const ownerEpochRef = React.useRef<OwnerEpoch>({ ownerId: null, generation: 0 });
  ownerEpochRef.current = advanceOwnerEpoch(ownerEpochRef.current, activeOwnerId);
  const loadControllerRef = React.useRef<AbortController | null>(null);
  const mutationControllerRef = React.useRef<AbortController | null>(null);
  const loadGenerationRef = React.useRef(0);
  const mutationGenerationRef = React.useRef(0);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [analysisDefaults, setAnalysisDefaults] = React.useState<AnalysisDefaults>(
    () => pickAnalysisDefaults(defaultPreferences())
  );
  const [savedDefaults, setSavedDefaults] =
    React.useState<AnalysisDefaults | null>(null);
  const [loadedOwnerId, setLoadedOwnerId] = React.useState<string | null>(null);
  const valid = analysisDefaultsAreValid(analysisDefaults);
  const dirty =
    savedDefaults !== null &&
    !analysisDefaultsEqual(analysisDefaults, savedDefaults);
  const canSave =
    valid &&
    dirty &&
    !loading &&
    !busy &&
    loadError === null &&
    activeOwnerId === initialOwnerId &&
    loadedOwnerId === initialOwnerId;

  const load = React.useCallback(async () => {
    const run = captureOwnerRun(ownerEpochRef.current);
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    loadControllerRef.current?.abort();
    mutationGenerationRef.current += 1;
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = null;
    setLoadedOwnerId(null);
    setSavedDefaults(null);
    setLoading(true);
    setBusy(false);
    setLoadError(null);
    if (!run || run.ownerId !== initialOwnerId) {
      setLoadError("Your signed-in account changed. Reload Settings to continue.");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const isCurrent = () =>
      !controller.signal.aborted &&
      isOwnerRunGenerationCurrent({
        run,
        epoch: ownerEpochRef.current,
        generation,
        currentGeneration: loadGenerationRef.current,
      });
    try {
      const res = await fetch("/api/user/preferences", {
        cache: "no-store",
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ownerId?: string;
        preferences?: PreferencesSchema;
        error?: string;
      };
      if (!res.ok) throw new Error(json?.error ?? "Failed to load preferences");
      if (!json.preferences) throw new Error("Missing preferences");
      if (!isCurrent()) return;
      if (json.ownerId !== run.ownerId) {
        throw new Error("The server returned analysis settings for a different account.");
      }
      const loaded = pickAnalysisDefaults(json.preferences);
      setAnalysisDefaults(loaded);
      setSavedDefaults(loaded);
      setLoadedOwnerId(run.ownerId);
    } catch (error) {
      if (!isCurrent()) return;
      setSavedDefaults(null);
      setLoadError(
        error instanceof Error ? error.message : "Failed to load preferences",
      );
    } finally {
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
      }
      if (isCurrent()) setLoading(false);
    }
  }, [initialOwnerId]);

  React.useEffect(() => {
    void load();
    return () => {
      loadGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      loadControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
    };
  }, [activeOwnerId, load]);

  const ownerReady =
    activeOwnerId === initialOwnerId && loadedOwnerId === initialOwnerId;

  function resetToAppDefaults() {
    if (savedDefaults === null || loading || busy) return;
    setAnalysisDefaults(pickAnalysisDefaults(defaultPreferences()));
    toast.message("Reset to app defaults.");
  }

  async function save() {
    if (!canSave) return;
    const run = captureOwnerRun(ownerEpochRef.current);
    if (!run || run.ownerId !== loadedOwnerId) return;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    mutationControllerRef.current = controller;
    const generation = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = generation;
    const isCurrent = () =>
      !controller.signal.aborted &&
      loadedOwnerId === run.ownerId &&
      isOwnerRunGenerationCurrent({
        run,
        epoch: ownerEpochRef.current,
        generation,
        currentGeneration: mutationGenerationRef.current,
      });
    const id = toast.loading("Saving analysis defaults…");
    setBusy(true);
    try {
      const res = await fetch("/api/user/preferences", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          [EXPECTED_OWNER_HEADER]: run.ownerId,
        },
        body: JSON.stringify(analysisDefaults),
        signal: controller.signal,
      });
      const json = (await res.json().catch(() => ({}))) as {
        ownerId?: string;
        preferences?: PreferencesSchema;
        error?: string;
      };
      if (!isCurrent()) return;
      if (!res.ok) throw new Error(json?.error ?? "Save failed");
      if (json.ownerId !== run.ownerId || !json.preferences) {
        throw new Error("The server saved analysis settings for a different account.");
      }
      toast.success("Analysis defaults saved.", { id });
      const persisted = json.preferences
        ? pickAnalysisDefaults(json.preferences)
        : analysisDefaults;
      setAnalysisDefaults(persisted);
      setSavedDefaults(persisted);
    } catch (e) {
      if (
        controller.signal.aborted ||
        (e instanceof Error && e.name === "AbortError") ||
        !isCurrent()
      ) {
        toast.dismiss(id);
        return;
      }
      toast.error(e instanceof Error ? e.message : "Save failed", { id });
    } finally {
      if (!isCurrent()) toast.dismiss(id);
      if (mutationControllerRef.current === controller) {
        mutationControllerRef.current = null;
      }
      if (isCurrent()) setBusy(false);
    }
  }

  return (
    <Card id="analysis-defaults" variant="panel" className="scroll-mt-24 overflow-hidden">
      <CardHeader className="border-b border-border/70 bg-surface-subtle/50">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
            <Gauge className="h-4 w-4" aria-hidden="true" />
          </span>
          Analysis defaults
        </CardTitle>
        <CardDescription>
          Set the quality, coverage, and grading used by automatic analysis.
          You can override them when starting an individual analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <AnalysisDefaultsFields
          value={analysisDefaults}
          onChange={setAnalysisDefaults}
          disabled={busy || loading || loadError !== null || !ownerReady}
        />
        {loading ? (
          <InlineStatus tone="info" live>
            Loading your current analysis defaults…
          </InlineStatus>
        ) : null}
        {loadError ? (
          <InlineStatus tone="danger">
            <div>
              <p>
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
          </InlineStatus>
        ) : null}
        {!valid ? (
          <InlineStatus tone="danger">
            Open Advanced analysis and correct the highlighted value before
            saving.
          </InlineStatus>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
          <p className="text-xs text-muted-foreground" role="status">
            {!loading && !loadError && savedDefaults !== null && !dirty
              ? "Saved"
              : "Changes apply to future analysis."}
          </p>
          <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={resetToAppDefaults}
            disabled={busy || loading || savedDefaults === null}
          >
            Reset
          </Button>
          <LoadingButton
            type="button"
            loading={busy}
            loadingLabel="Saving…"
            onClick={save}
            disabled={!canSave}
          >
            Save
          </LoadingButton>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
