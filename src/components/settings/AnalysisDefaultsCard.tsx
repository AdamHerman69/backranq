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
import { AnalysisDefaultsFields } from "@/components/analysis/AnalysisDefaultsFields";

export function AnalysisDefaultsCard() {
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [analysisDefaults, setAnalysisDefaults] = React.useState<AnalysisDefaults>(
    () => pickAnalysisDefaults(defaultPreferences())
  );

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/user/preferences", { cache: "no-store" });
        const json = (await res.json().catch(() => ({}))) as {
          preferences?: PreferencesSchema;
          error?: string;
        };
        if (!res.ok) throw new Error(json?.error ?? "Failed to load preferences");
        if (!json.preferences) throw new Error("Missing preferences");
        if (cancelled) return;
        setAnalysisDefaults(pickAnalysisDefaults(json.preferences));
      } catch {
        // ignore; keep app defaults
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function resetToAppDefaults() {
    setAnalysisDefaults(pickAnalysisDefaults(defaultPreferences()));
    toast.message("Reset to app defaults.");
  }

  async function save() {
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
      if (json.preferences) setAnalysisDefaults(pickAnalysisDefaults(json.preferences));
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
          disabled={busy || loading}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={resetToAppDefaults} disabled={busy || loading}>
            Reset
          </Button>
          <Button type="button" onClick={save} disabled={busy || loading}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

