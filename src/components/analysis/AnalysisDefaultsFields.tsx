"use client";

import * as React from "react";

import type { AnalysisDefaults } from "@/lib/preferences";
import type { PuzzleMode } from "@/lib/analysis/extractPuzzles";
import { Input } from "@/components/ui/input";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </label>
  );
}

function isPuzzleMode(x: unknown): x is PuzzleMode {
  return x === "avoidBlunder" || x === "punishBlunder" || x === "both";
}

export function AnalysisDefaultsFields({
  value,
  onChange,
  disabled,
  dense,
}: {
  value: AnalysisDefaults;
  onChange: (next: AnalysisDefaults) => void;
  disabled?: boolean;
  dense?: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  function patch(p: Partial<AnalysisDefaults>) {
    onChange({ ...value, ...p });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Puzzle mode">
          <select
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            value={value.puzzleMode}
            onChange={(e) =>
              patch({ puzzleMode: (isPuzzleMode(e.target.value) ? e.target.value : "both") as PuzzleMode })
            }
            disabled={disabled}
          >
            <option value="both">Both</option>
            <option value="avoidBlunder">Avoid blunder</option>
            <option value="punishBlunder">Punish blunder</option>
          </select>
        </Field>

        <Field label="Engine movetime (ms)" hint="Time per position. Higher = slower, stronger.">
          <Input
            inputMode="numeric"
            value={value.engineMoveTimeMs}
            onChange={(e) => patch({ engineMoveTimeMs: e.target.value })}
            disabled={disabled}
          />
        </Field>

        <Field
          label="Max puzzles per game"
          hint='Leave blank for unlimited. "0" also means unlimited.'
        >
          <Input
            inputMode="numeric"
            value={value.maxPuzzlesPerGame}
            onChange={(e) => patch({ maxPuzzlesPerGame: e.target.value })}
            disabled={disabled}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Blunder swing (cp)" hint="Threshold for blunder-based puzzles.">
          <Input
            inputMode="numeric"
            value={value.blunderSwingCp}
            onChange={(e) => patch({ blunderSwingCp: e.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field label="Missed tactic swing (cp)" hint="Threshold for missed tactic puzzles.">
          <Input
            inputMode="numeric"
            value={value.missedTacticSwingCp}
            onChange={(e) => patch({ missedTacticSwingCp: e.target.value })}
            disabled={disabled}
          />
        </Field>
        <Field label="Confirm movetime (ms)" hint="Optional: re-check candidates at higher depth. Blank disables.">
          <Input
            inputMode="numeric"
            value={value.confirmMovetimeMs}
            onChange={(e) => patch({ confirmMovetimeMs: e.target.value })}
            disabled={disabled}
            placeholder=""
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field
          label="Min starting eval (cp)"
          hint="Blank disables the min bound."
        >
          <Input
            inputMode="numeric"
            value={value.evalBandMinCp}
            onChange={(e) => patch({ evalBandMinCp: e.target.value })}
            disabled={disabled}
            placeholder=""
          />
        </Field>
        <Field
          label="Max starting eval (cp)"
          hint="Blank disables the max bound."
        >
          <Input
            inputMode="numeric"
            value={value.evalBandMaxCp}
            onChange={(e) => patch({ evalBandMaxCp: e.target.value })}
            disabled={disabled}
            placeholder=""
          />
        </Field>
        <Field
          label="Uniqueness margin (cp)"
          hint="Optional: require best move to beat #2 by at least this much. Blank disables."
        >
          <Input
            inputMode="numeric"
            value={value.uniquenessMarginCp}
            onChange={(e) => patch({ uniquenessMarginCp: e.target.value })}
            disabled={disabled}
            placeholder=""
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!value.requireTactical}
            onChange={(e) => patch({ requireTactical: e.target.checked })}
            disabled={disabled}
          />
          Require tactical solution (check/capture/promotion)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={!!value.skipTrivialEndgames}
            onChange={(e) => patch({ skipTrivialEndgames: e.target.checked })}
            disabled={disabled}
          />
          Skip trivial endgames
        </label>
      </div>

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="text-sm text-primary underline-offset-4 hover:underline"
          onClick={() => setShowAdvanced((v) => !v)}
          disabled={disabled}
        >
          {showAdvanced ? "Hide advanced" : "Show advanced"}
        </button>
        {dense ? null : (
          <div className="text-xs text-muted-foreground">
            These defaults apply to background analysis and puzzle extraction.
          </div>
        )}
      </div>

      {showAdvanced ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Opening skip (plies)">
            <Input
              inputMode="numeric"
              value={value.openingSkipPlies}
              onChange={(e) => patch({ openingSkipPlies: e.target.value })}
              disabled={disabled}
            />
          </Field>
          <Field label="Min PV moves">
            <Input
              inputMode="numeric"
              value={value.minPvMoves}
              onChange={(e) => patch({ minPvMoves: e.target.value })}
              disabled={disabled}
            />
          </Field>
          <Field label="Min non-king pieces">
            <Input
              inputMode="numeric"
              value={value.minNonKingPieces}
              onChange={(e) => patch({ minNonKingPieces: e.target.value })}
              disabled={disabled}
            />
          </Field>
          <Field label="Tactical lookahead (plies)">
            <Input
              inputMode="numeric"
              value={value.tacticalLookaheadPlies}
              onChange={(e) => patch({ tacticalLookaheadPlies: e.target.value })}
              disabled={disabled}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

