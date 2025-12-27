import type { TimeClass } from "@/lib/types/game";

export type GameFetchFilters = {
  since?: string; // ISO date or datetime
  until?: string; // ISO date or datetime
  timeClasses?: TimeClass[]; // empty or undefined = any
  rated?: boolean;
  minElo?: number;
  maxElo?: number;
  max?: number;
};

export function parseBooleanParam(v: string | null): boolean | undefined {
  if (v == null) return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

export function parseNumberParam(v: string | null): number | undefined {
  if (v == null || v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

export function parseIsoDateOrDateTime(v: string | null): string | undefined {
  if (v == null || v.trim() === "") return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

export function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

