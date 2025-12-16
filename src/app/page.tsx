"use client";

import styles from "./page.module.css";
import type { NormalizedGame, TimeClass } from "@/lib/types/game";
import { useMemo, useState } from "react";
import { Chess, type Move } from "chess.js";
import { Chessboard } from "react-chessboard";
import { StockfishClient, type EvalResult } from "@/lib/analysis/stockfishClient";
import { extractPuzzlesFromGames, type ExtractOptions, type PuzzleMode } from "@/lib/analysis/extractPuzzles";
import type { Puzzle } from "@/lib/analysis/puzzles";
import { useEffect } from "react";
import { extractStartFenFromPgn } from "@/lib/chess/utils";
import { ecoName } from "@/lib/chess/eco";
import { PuzzlePanel } from "@/app/puzzle/PuzzlePanel";

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : "Unexpected error";
}

type VerboseMove = Move;

const START_FEN = new Chess().fen();

type UserColor = "white" | "black" | null;
type UserResult = "win" | "loss" | "draw" | "unknown";

function normalizeName(s: string): string {
  return (s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^@/, "");
}

function userColorForGame(game: NormalizedGame, userName: string): UserColor {
  const u = normalizeName(userName);
  if (!u) return null;
  const w = normalizeName(game.white.name);
  const b = normalizeName(game.black.name);
  if (u === w) return "white";
  if (u === b) return "black";
  return null;
}

function userResultForGame(game: NormalizedGame, userColor: UserColor): UserResult {
  if (!userColor) return "unknown";
  const r = (game.result ?? "").trim();
  if (r === "1/2-1/2") return "draw";
  if (r === "1-0") return userColor === "white" ? "win" : "loss";
  if (r === "0-1") return userColor === "black" ? "win" : "loss";
  return "unknown";
}

type RatedFilter = "any" | "rated" | "casual";

type Filters = {
  lichessUsername: string;
  chesscomUsername: string;
  timeClass: TimeClass | "any";
  rated: RatedFilter;
  since: string; // yyyy-mm-dd
  until: string; // yyyy-mm-dd
  minElo: string;
  maxElo: string;
  max: string;
};

function buildQuery(filters: Filters) {
  const p = new URLSearchParams();
  if (filters.timeClass !== "any") p.set("timeClass", filters.timeClass);
  if (filters.rated === "rated") p.set("rated", "true");
  if (filters.rated === "casual") p.set("rated", "false");
  if (filters.since) p.set("since", new Date(filters.since).toISOString());
  if (filters.until) {
    // inclusive end-of-day
    const d = new Date(filters.until);
    d.setHours(23, 59, 59, 999);
    p.set("until", d.toISOString());
  }
  if (filters.minElo) p.set("minElo", filters.minElo);
  if (filters.maxElo) p.set("maxElo", filters.maxElo);
  if (filters.max) p.set("max", filters.max);
  return p;
}

async function fetchProviderGames(
  provider: "lichess" | "chesscom",
  username: string,
  filters: Filters,
): Promise<NormalizedGame[]> {
  const q = buildQuery(filters);
  q.set("username", username);
  const res = await fetch(`/api/${provider}/games?${q.toString()}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${provider} fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { games?: NormalizedGame[] };
  return Array.isArray(json.games) ? json.games : [];
}

export default function Home() {
  const [filters, setFilters] = useState<Filters>({
    lichessUsername: "",
    chesscomUsername: "",
    timeClass: "any",
    rated: "any",
    since: "",
    until: "",
    minElo: "",
    maxElo: "",
    max: "100",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [games, setGames] = useState<NormalizedGame[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [engineBusy, setEngineBusy] = useState(false);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [engineResult, setEngineResult] = useState<EvalResult | null>(null);
  const [engineMoveTimeMs, setEngineMoveTimeMs] = useState("200");
  const [engineClient, setEngineClient] = useState<StockfishClient | null>(null);
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [puzzleIdx, setPuzzleIdx] = useState(0);
  const [puzzleTagFilter, setPuzzleTagFilter] = useState<string[]>([]);
  const [puzzleOpeningFilter, setPuzzleOpeningFilter] = useState<string>("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<string>("");

  // Puzzle extraction options
  const [puzzleMode, setPuzzleMode] = useState<PuzzleMode>("both");
  const [maxPuzzlesPerGame, setMaxPuzzlesPerGame] = useState("5");
  const [blunderSwingCp, setBlunderSwingCp] = useState("250");
  const [missedTacticSwingCp, setMissedTacticSwingCp] = useState("180");
  const [evalBandMinCp, setEvalBandMinCp] = useState("-300");
  const [evalBandMaxCp, setEvalBandMaxCp] = useState("600");
  const [requireTactical, setRequireTactical] = useState(true);
  const [tacticalLookaheadPlies, setTacticalLookaheadPlies] = useState("4");
  const [openingSkipPlies, setOpeningSkipPlies] = useState("8");
  const [minPvMoves, setMinPvMoves] = useState("2");
  const [skipTrivialEndgames, setSkipTrivialEndgames] = useState(true);
  const [minNonKingPieces, setMinNonKingPieces] = useState("4");
  const [confirmMovetimeMs, setConfirmMovetimeMs] = useState("");
  const [showAdvancedOptions, setShowAdvancedOptions] = useState(false);

  function puzzleOpeningKey(p: Puzzle): string {
    const o = p.opening;
    if (o?.eco || o?.name || o?.variation) {
      return `${o.eco ?? ""}::${o.name ?? ""}::${o.variation ?? ""}`;
    }
    // Fallback for older saved puzzles: attempt to read from tags.
    const tags = p.tags ?? [];
    const eco = tags.find((t) => t.startsWith("eco:"))?.slice("eco:".length) ?? "";
    const name = tags.find((t) => t.startsWith("opening:"))?.slice("opening:".length) ?? "";
    const variation = tags.find((t) => t.startsWith("openingVar:"))?.slice("openingVar:".length) ?? "";
    if (eco || name || variation) return `${eco}::${name}::${variation}`;
    return "unknown";
  }

  function puzzleOpeningLabelFromKey(key: string): string {
    if (!key || key === "unknown") return "Unknown";
    const [eco, name, variation] = key.split("::");
    const parts: string[] = [];
    if (eco) parts.push(eco);
    const nm = name || ecoName(eco) || "";
    if (nm) parts.push(nm);
    const base = parts.join(" ");
    return variation ? `${base} — ${variation}` : base || "Unknown";
  }

  const allPuzzleOpenings = useMemo(() => {
    const s = new Set<string>();
    for (const p of puzzles) s.add(puzzleOpeningKey(p));
    const list = Array.from(s);
    list.sort((a, b) => puzzleOpeningLabelFromKey(a).localeCompare(puzzleOpeningLabelFromKey(b)));
    return list;
  }, [puzzles]);

  const allPuzzleTags = useMemo(() => {
    const s = new Set<string>();
    for (const p of puzzles) for (const t of p.tags ?? []) s.add(t);
    return Array.from(s).sort();
  }, [puzzles]);

  const visiblePuzzles = useMemo(() => {
    let list = puzzles;
    if (puzzleOpeningFilter) {
      list = list.filter((p) => puzzleOpeningKey(p) === puzzleOpeningFilter);
    }
    if (puzzleTagFilter.length === 0) return list;
    // Any-of match: include a puzzle if it contains at least one selected tag.
    return list.filter((p) => (p.tags ?? []).some((t) => puzzleTagFilter.includes(t)));
  }, [puzzles, puzzleTagFilter, puzzleOpeningFilter]);

  // Clamp selection when the visible list changes (e.g. filter applied/cleared).
  useEffect(() => {
    setPuzzleIdx((i) => Math.max(0, Math.min(i, Math.max(0, visiblePuzzles.length - 1))));
  }, [visiblePuzzles.length]);

  const currentPuzzle = visiblePuzzles[puzzleIdx] ?? null;

  // localStorage hydration
  useEffect(() => {
    try {
      const raw = localStorage.getItem("backrank.miniState.v1");
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      const state = parsed as {
        filters?: Partial<Filters>;
        puzzles?: Puzzle[];
        puzzleIdx?: number;
        puzzleTagFilter?: string[];
        puzzleOpeningFilter?: string;
        // Puzzle extraction options
        puzzleMode?: PuzzleMode;
        maxPuzzlesPerGame?: string;
        blunderSwingCp?: string;
        missedTacticSwingCp?: string;
        evalBandMinCp?: string;
        evalBandMaxCp?: string;
        requireTactical?: boolean;
        tacticalLookaheadPlies?: string;
        openingSkipPlies?: string;
        minPvMoves?: string;
        skipTrivialEndgames?: boolean;
        minNonKingPieces?: string;
        confirmMovetimeMs?: string;
        engineMoveTimeMs?: string;
      };
      if (state.filters) setFilters((f) => ({ ...f, ...state.filters }));
      if (Array.isArray(state.puzzles)) setPuzzles(state.puzzles);
      if (typeof state.puzzleIdx === "number") setPuzzleIdx(state.puzzleIdx);
      if (Array.isArray(state.puzzleTagFilter)) setPuzzleTagFilter(state.puzzleTagFilter);
      if (typeof state.puzzleOpeningFilter === "string") setPuzzleOpeningFilter(state.puzzleOpeningFilter);
      // Puzzle extraction options
      if (state.puzzleMode) setPuzzleMode(state.puzzleMode);
      if (state.maxPuzzlesPerGame) setMaxPuzzlesPerGame(state.maxPuzzlesPerGame);
      if (state.blunderSwingCp) setBlunderSwingCp(state.blunderSwingCp);
      if (state.missedTacticSwingCp) setMissedTacticSwingCp(state.missedTacticSwingCp);
      if (state.evalBandMinCp) setEvalBandMinCp(state.evalBandMinCp);
      if (state.evalBandMaxCp) setEvalBandMaxCp(state.evalBandMaxCp);
      if (typeof state.requireTactical === "boolean") setRequireTactical(state.requireTactical);
      if (state.tacticalLookaheadPlies) setTacticalLookaheadPlies(state.tacticalLookaheadPlies);
      if (state.openingSkipPlies) setOpeningSkipPlies(state.openingSkipPlies);
      if (state.minPvMoves) setMinPvMoves(state.minPvMoves);
      if (typeof state.skipTrivialEndgames === "boolean") setSkipTrivialEndgames(state.skipTrivialEndgames);
      if (state.minNonKingPieces) setMinNonKingPieces(state.minNonKingPieces);
      if (state.confirmMovetimeMs) setConfirmMovetimeMs(state.confirmMovetimeMs);
      if (state.engineMoveTimeMs) setEngineMoveTimeMs(state.engineMoveTimeMs);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      const payload = JSON.stringify({
        filters,
        puzzles,
        puzzleIdx,
        puzzleTagFilter,
        puzzleOpeningFilter,
        // Puzzle extraction options
        puzzleMode,
        maxPuzzlesPerGame,
        blunderSwingCp,
        missedTacticSwingCp,
        evalBandMinCp,
        evalBandMaxCp,
        requireTactical,
        tacticalLookaheadPlies,
        openingSkipPlies,
        minPvMoves,
        skipTrivialEndgames,
        minNonKingPieces,
        confirmMovetimeMs,
        engineMoveTimeMs,
      });
      localStorage.setItem("backrank.miniState.v1", payload);
    } catch {
      // ignore
    }
  }, [
    filters,
    puzzles,
    puzzleIdx,
    puzzleTagFilter,
    puzzleOpeningFilter,
    puzzleMode,
    maxPuzzlesPerGame,
    blunderSwingCp,
    missedTacticSwingCp,
    evalBandMinCp,
    evalBandMaxCp,
    requireTactical,
    tacticalLookaheadPlies,
    openingSkipPlies,
    minPvMoves,
    skipTrivialEndgames,
    minNonKingPieces,
    confirmMovetimeMs,
    engineMoveTimeMs,
  ]);

  // PuzzlePanel owns per-puzzle UI state (attempt, tabs, explorer, etc.)

  const selectedCount = useMemo(
    () => Object.values(selected).reduce((acc, v) => acc + (v ? 1 : 0), 0),
    [selected],
  );

  const selectedSummary = useMemo(() => {
    const ids = new Set<string>(Object.entries(selected).filter(([, v]) => v).map(([k]) => k));
    const base = { total: ids.size, win: 0, loss: 0, draw: 0, unknown: 0 };
    if (ids.size === 0) return base;
    for (const g of games) {
      if (!ids.has(g.id)) continue;
      const user =
        g.provider === "lichess"
          ? filters.lichessUsername
          : g.provider === "chesscom"
            ? filters.chesscomUsername
            : "";
      const uc = userColorForGame(g, user);
      const ur = userResultForGame(g, uc);
      base[ur] += 1;
    }
    return base;
  }, [games, selected, filters.lichessUsername, filters.chesscomUsername]);

  const activeGame = useMemo(
    () => (activeGameId ? games.find((g) => g.id === activeGameId) ?? null : null),
    [activeGameId, games],
  );

  const parsed = useMemo(() => {
    if (!activeGame) return null;
    const chess = new Chess();
    try {
      // chess.js accepts PGN with headers; will also respect FEN/SetUp tags if present.
      chess.loadPgn(activeGame.pgn, { strict: false });
    } catch {
      return { moves: [] as string[], startFen: START_FEN };
    }
    const history = chess.history(); // SAN list
    const startFen = (() => {
      // Re-load and then reset by undoing all moves to capture starting position.
      const c2 = new Chess();
      try {
        c2.loadPgn(activeGame.pgn, { strict: false });
        while (c2.undo()) {
          // undo to start
        }
        return c2.fen();
      } catch {
        return START_FEN;
      }
    })();
    return { moves: history, startFen };
  }, [activeGame]);

  const puzzleSourceGame = useMemo(() => {
    if (!currentPuzzle) return null;
    return games.find((g) => g.id === currentPuzzle.sourceGameId) ?? null;
  }, [currentPuzzle, games]);

  const puzzleSourceParsed = useMemo(() => {
    if (!puzzleSourceGame) return null;
    const chess = new Chess();
    try {
      chess.loadPgn(puzzleSourceGame.pgn, { strict: false });
    } catch {
      return null;
    }
    const moves = chess.history({ verbose: true }) as VerboseMove[];
    const fenTag = extractStartFenFromPgn(puzzleSourceGame.pgn);
    if (fenTag) return { startFen: fenTag, moves };

    const startChess = new Chess();
    try {
      startChess.loadPgn(puzzleSourceGame.pgn, { strict: false });
      while (startChess.undo()) {}
      return { startFen: startChess.fen(), moves };
    } catch {
      return { startFen: new Chess().fen(), moves };
    }
  }, [puzzleSourceGame]);

  const userBoardOrientation = useMemo(() => {
    if (!puzzleSourceGame) return "white" as const;
    const user =
      puzzleSourceGame.provider === "lichess"
        ? filters.lichessUsername
        : puzzleSourceGame.provider === "chesscom"
          ? filters.chesscomUsername
          : "";
    const u = normalizeName(user);
    const w = normalizeName(puzzleSourceGame.white.name);
    const b = normalizeName(puzzleSourceGame.black.name);
    if (u && u === w) return "white" as const;
    if (u && u === b) return "black" as const;
    return "white" as const;
  }, [puzzleSourceGame, filters.chesscomUsername, filters.lichessUsername]);

  const [ply, setPly] = useState(0);
  const viewerFen = useMemo(() => {
    if (!activeGame || !parsed) return START_FEN;
    if (parsed.startFen === START_FEN) {
      const c = new Chess(START_FEN);
      if (!activeGame?.pgn) return c.fen();
      try {
        c.loadPgn(activeGame.pgn, { strict: false });
      } catch {
        return c.fen();
      }
      // derive start FEN by undo-all, then replay to ply
      while (c.undo()) {}
      const moves = parsed.moves;
      for (let i = 0; i < Math.min(ply, moves.length); i++) {
        // replay using SAN
        c.move(moves[i]);
      }
      return c.fen();
    }

    const c = new Chess(parsed.startFen);
    const moves = parsed.moves;
    for (let i = 0; i < Math.min(ply, moves.length); i++) {
      c.move(moves[i]);
    }
    return c.fen();
  }, [activeGame, parsed, ply]);

  async function onFetchGames() {
    setError(null);
    setLoading(true);
    try {
      const jobs: Promise<NormalizedGame[]>[] = [];
      const lich = filters.lichessUsername.trim();
      const cc = filters.chesscomUsername.trim();
      if (!lich && !cc) throw new Error("Enter a lichess and/or chess.com username.");

      if (lich) jobs.push(fetchProviderGames("lichess", lich, filters));
      if (cc) jobs.push(fetchProviderGames("chesscom", cc, filters));

      const results = await Promise.all(jobs);
      const merged = results.flat().sort((a, b) => +new Date(b.playedAt) - +new Date(a.playedAt));
      setGames(merged);
      const nextSelected: Record<string, boolean> = {};
      for (const g of merged) nextSelected[g.id] = true;
      setSelected(nextSelected);
      setActiveGameId(merged[0]?.id ?? null);
      setPly(0);
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  async function onEvalPosition() {
    setEngineError(null);
    setEngineBusy(true);
    try {
      const fen = viewerFen;
      const movetimeMs = Number(engineMoveTimeMs) || 200;
      const client = engineClient ?? new StockfishClient();
      if (!engineClient) setEngineClient(client);
      const res = await client.evalPosition({ fen, movetimeMs });
      setEngineResult(res);
    } catch (e: unknown) {
      setEngineError(errorMessage(e));
    } finally {
      setEngineBusy(false);
    }
  }

  async function onGeneratePuzzles() {
    setEngineError(null);
    setAnalyzing(true);
    setAnalysisProgress("");
    try {
      const ids = new Set<string>(Object.entries(selected).filter(([, v]) => v).map(([k]) => k));
      if (ids.size === 0) throw new Error("Select at least one game.");
      const client = engineClient ?? new StockfishClient();
      if (!engineClient) setEngineClient(client);

      // Build extraction options from UI state
      const extractOptions: ExtractOptions = {
        movetimeMs: Number(engineMoveTimeMs) || 200,
        puzzleMode,
        maxPuzzlesPerGame: Number(maxPuzzlesPerGame) || 5,
        blunderSwingCp: Number(blunderSwingCp) || 250,
        missedTacticSwingCp: Number(missedTacticSwingCp) || 180,
        evalBandMinCp: evalBandMinCp ? Number(evalBandMinCp) : null,
        evalBandMaxCp: evalBandMaxCp ? Number(evalBandMaxCp) : null,
        requireTactical,
        tacticalLookaheadPlies: Number(tacticalLookaheadPlies) || 4,
        openingSkipPlies: Number(openingSkipPlies) || 8,
        minPvMoves: Number(minPvMoves) || 2,
        skipTrivialEndgames,
        minNonKingPieces: Number(minNonKingPieces) || 4,
        confirmMovetimeMs: confirmMovetimeMs ? Number(confirmMovetimeMs) : null,
      };

      const list = await extractPuzzlesFromGames({
        games,
        selectedGameIds: ids,
        engine: client,
        usernameByProvider: {
          lichess: filters.lichessUsername,
          chesscom: filters.chesscomUsername,
        },
        onProgress: (p) => {
          const phase = p.phase ? ` (${p.phase})` : "";
          setAnalysisProgress(
            `Game ${p.gameIndex + 1}/${p.gameCount} • ply ${p.ply + 1}/${p.plyCount}${phase}`,
          );
        },
        options: extractOptions,
      });
      // Deduplicate by (sourceGameId, sourcePly, fen)
      const dedup = new Map<string, Puzzle>();
      for (const p of [...puzzles, ...list]) {
        const k = `${p.sourceGameId}::${p.sourcePly}::${p.fen}`;
        if (!dedup.has(k)) dedup.set(k, p);
      }
      setPuzzles(Array.from(dedup.values()));
      setPuzzleIdx(0);
    } catch (e: unknown) {
      setEngineError(errorMessage(e));
    } finally {
      setAnalyzing(false);
    }
  }

  function toggleAll(v: boolean) {
    const next: Record<string, boolean> = {};
    for (const g of games) next[g.id] = v;
    setSelected(next);
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.header}>
          <h1>BackRank — Your games → your puzzles</h1>
          <p>Connect by username (public games). Filter games, then generate puzzles from blunders and missed wins.</p>
        </header>

        <section className={styles.panel}>
          <h2>1) Fetch games</h2>
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Lichess username</span>
              <input
                value={filters.lichessUsername}
                onChange={(e) => setFilters((f) => ({ ...f, lichessUsername: e.target.value }))}
                placeholder="e.g. DrNykterstein"
              />
            </label>
            <label className={styles.field}>
              <span>Chess.com username</span>
              <input
                value={filters.chesscomUsername}
                onChange={(e) => setFilters((f) => ({ ...f, chesscomUsername: e.target.value }))}
                placeholder="e.g. hikaru"
              />
            </label>

            <label className={styles.field}>
              <span>Time control</span>
              <select
                value={filters.timeClass}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, timeClass: e.target.value as Filters["timeClass"] }))
                }
              >
                <option value="any">Any</option>
                <option value="bullet">Bullet</option>
                <option value="blitz">Blitz</option>
                <option value="rapid">Rapid</option>
                <option value="classical">Classical</option>
              </select>
            </label>

            <label className={styles.field}>
              <span>Rated</span>
              <select
                value={filters.rated}
                onChange={(e) => setFilters((f) => ({ ...f, rated: e.target.value as RatedFilter }))}
              >
                <option value="any">Any</option>
                <option value="rated">Rated only</option>
                <option value="casual">Casual only</option>
              </select>
            </label>

            <label className={styles.field}>
              <span>Since</span>
              <input
                type="date"
                value={filters.since}
                onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value }))}
              />
            </label>

            <label className={styles.field}>
              <span>Until</span>
              <input
                type="date"
                value={filters.until}
                onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value }))}
              />
            </label>

            <label className={styles.field}>
              <span>Min Elo</span>
              <input
                inputMode="numeric"
                value={filters.minElo}
                onChange={(e) => setFilters((f) => ({ ...f, minElo: e.target.value }))}
                placeholder="e.g. 1200"
              />
            </label>

            <label className={styles.field}>
              <span>Max Elo</span>
              <input
                inputMode="numeric"
                value={filters.maxElo}
                onChange={(e) => setFilters((f) => ({ ...f, maxElo: e.target.value }))}
                placeholder="e.g. 2000"
              />
            </label>

            <label className={styles.field}>
              <span>Max games</span>
              <input
                inputMode="numeric"
                value={filters.max}
                onChange={(e) => setFilters((f) => ({ ...f, max: e.target.value }))}
              />
            </label>
          </div>

          <div className={styles.actions}>
            <button className={styles.primaryButton} disabled={loading} onClick={onFetchGames}>
              {loading ? "Fetching…" : "Fetch games"}
            </button>
            {games.length > 0 && (
              <>
                <button className={styles.secondaryButton} onClick={() => toggleAll(true)}>
                  Select all
                </button>
                <button className={styles.secondaryButton} onClick={() => toggleAll(false)}>
                  Select none
                </button>
                <div className={styles.muted}>
                  {games.length} games • {selectedCount} selected
                </div>
              </>
            )}
          </div>
          {error && <div className={styles.error}>{error}</div>}
        </section>

        <section className={styles.panel}>
          <h2>2) Games</h2>
          {games.length === 0 ? (
            <p className={styles.muted}>Fetch games to see them here.</p>
          ) : (
            <>
              <div className={styles.muted}>
                {games.length} games • selected {selectedSummary.total} • W {selectedSummary.win} / L{" "}
                {selectedSummary.loss} / D {selectedSummary.draw}
                {selectedSummary.unknown ? ` / ? ${selectedSummary.unknown}` : ""}
              </div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th />
                      <th>When</th>
                      <th>Provider</th>
                      <th>Time</th>
                      <th>Players</th>
                      <th>Result</th>
                      <th>Rated</th>
                      <th>Link</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {games.map((g) => {
                      const user =
                        g.provider === "lichess"
                          ? filters.lichessUsername
                          : g.provider === "chesscom"
                            ? filters.chesscomUsername
                            : "";
                      const uc = userColorForGame(g, user);
                      const ur = userResultForGame(g, uc);
                      const letter = ur === "win" ? "W" : ur === "loss" ? "L" : ur === "draw" ? "D" : "?";
                      const badgeClass =
                        ur === "win"
                          ? styles.resultWin
                          : ur === "loss"
                            ? styles.resultLoss
                            : ur === "draw"
                              ? styles.resultDraw
                              : styles.resultUnknown;
                      const titleParts = [
                        uc ? `You: ${uc}` : "You: (not found in players)",
                        `Outcome: ${ur}`,
                        g.result ? `PGN: ${g.result}` : "PGN: ?",
                        g.termination ? `Termination: ${g.termination}` : null,
                      ].filter(Boolean);
                      return (
                        <tr key={g.id} className={g.id === activeGameId ? styles.activeRow : undefined}>
                          <td>
                            <input
                              type="checkbox"
                              checked={!!selected[g.id]}
                              onChange={(e) => setSelected((s) => ({ ...s, [g.id]: e.target.checked }))}
                            />
                          </td>
                          <td className={styles.mono}>{new Date(g.playedAt).toLocaleString()}</td>
                          <td>{g.provider}</td>
                          <td>{g.timeClass}</td>
                          <td className={styles.mono}>
                            {g.white.name} ({g.white.rating ?? "?"}) vs {g.black.name} ({g.black.rating ?? "?"})
                          </td>
                          <td>
                            <div className={styles.resultCell}>
                              <span className={`${styles.resultBadge} ${badgeClass}`} title={titleParts.join(" • ")}>
                                {letter}
                              </span>
                              {(g.result || g.termination) && (
                                <div className={styles.resultMeta}>
                                  <span className={styles.mono}>{g.result ?? "?"}</span>
                                  {g.termination ? <span className={styles.muted}> • {g.termination}</span> : null}
                                </div>
                              )}
                            </div>
                          </td>
                          <td>{g.rated == null ? "?" : g.rated ? "Yes" : "No"}</td>
                          <td>
                            {g.url ? (
                              <a href={g.url} target="_blank" rel="noreferrer">
                                Open
                              </a>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td>
                            <button
                              className={styles.linkButton}
                              onClick={() => {
                                setActiveGameId(g.id);
                                setPly(0);
                              }}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>

        <section className={styles.panel}>
          <h2>2b) Game viewer (PGN)</h2>
          {!activeGame ? (
            <p className={styles.muted}>Pick a game to view its PGN.</p>
          ) : !parsed ? (
            <p className={styles.muted}>Loading PGN…</p>
          ) : (
            <div className={styles.viewer}>
              <div className={styles.board}>
                <Chessboard options={{ position: viewerFen, allowDragging: false }} />
                <div className={styles.scrub}>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setPly(0)}
                    disabled={ply === 0}
                  >
                    Start
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setPly((p) => Math.max(0, p - 1))}
                    disabled={ply === 0}
                  >
                    Back
                  </button>
                  <div className={styles.muted}>
                    Ply {ply} / {parsed.moves.length}
                  </div>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setPly((p) => Math.min(parsed.moves.length, p + 1))}
                    disabled={ply >= parsed.moves.length}
                  >
                    Next
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setPly(parsed.moves.length)}
                    disabled={ply >= parsed.moves.length}
                  >
                    End
                  </button>
                </div>
              </div>
              <div className={styles.moves}>
                <div className={styles.muted}>
                  {activeGame.provider} • {activeGame.timeClass} • {new Date(activeGame.playedAt).toLocaleString()}
                </div>
                <ol className={styles.moveList}>
                  {parsed.moves.map((m, idx) => (
                    <li key={`${idx}-${m}`}>
                      <button
                        className={idx + 1 === ply ? styles.moveActive : styles.moveButton}
                        onClick={() => setPly(idx + 1)}
                      >
                        {m}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          )}
        </section>

        <section className={styles.panel}>
          <h2>3) Analyze → puzzles</h2>

          {/* Puzzle Mode Selection */}
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Puzzle mode</span>
              <select value={puzzleMode} onChange={(e) => setPuzzleMode(e.target.value as PuzzleMode)}>
                <option value="both">Both types</option>
                <option value="avoidBlunder">Avoid blunder (your mistakes)</option>
                <option value="punishBlunder">Punish blunder (opponent mistakes)</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>Engine movetime (ms)</span>
              <input
                inputMode="numeric"
                value={engineMoveTimeMs}
                onChange={(e) => setEngineMoveTimeMs(e.target.value)}
                title="Time per position evaluation. Higher = more accurate but slower."
              />
            </label>
            <label className={styles.field}>
              <span>Max puzzles per game</span>
              <input
                inputMode="numeric"
                value={maxPuzzlesPerGame}
                onChange={(e) => setMaxPuzzlesPerGame(e.target.value)}
              />
            </label>
          </div>

          {/* Quality Filters */}
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Min swing (cp) for tactic</span>
              <input
                inputMode="numeric"
                value={missedTacticSwingCp}
                onChange={(e) => setMissedTacticSwingCp(e.target.value)}
                title="Minimum eval swing (centipawns) to consider a position puzzleworthy."
              />
            </label>
            <label className={styles.field}>
              <span>Min swing (cp) for blunder</span>
              <input
                inputMode="numeric"
                value={blunderSwingCp}
                onChange={(e) => setBlunderSwingCp(e.target.value)}
                title="Minimum eval swing to classify as a blunder."
              />
            </label>
          </div>

          {/* Eval Band - Filter out already lost/won positions */}
          <div className={styles.grid}>
            <label className={styles.field}>
              <span>Min starting eval (cp)</span>
              <input
                inputMode="numeric"
                value={evalBandMinCp}
                onChange={(e) => setEvalBandMinCp(e.target.value)}
                placeholder="-300"
                title="Skip positions where you're already losing worse than this. Empty = no limit."
              />
            </label>
            <label className={styles.field}>
              <span>Max starting eval (cp)</span>
              <input
                inputMode="numeric"
                value={evalBandMaxCp}
                onChange={(e) => setEvalBandMaxCp(e.target.value)}
                placeholder="600"
                title="Skip positions where you're already winning more than this. Empty = no limit."
              />
            </label>
          </div>

          {/* Tactical filter toggle */}
          <div className={styles.actions}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={requireTactical}
                onChange={(e) => setRequireTactical(e.target.checked)}
              />
              <span>Require tactical solution (check/capture/promotion in PV)</span>
            </label>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={skipTrivialEndgames}
                onChange={(e) => setSkipTrivialEndgames(e.target.checked)}
              />
              <span>Skip trivial endgames</span>
            </label>
          </div>

          {/* Advanced options toggle */}
          <div className={styles.actions}>
            <button
              className={styles.linkButton}
              onClick={() => setShowAdvancedOptions((v) => !v)}
            >
              {showAdvancedOptions ? "▼ Hide advanced options" : "▶ Show advanced options"}
            </button>
          </div>

          {showAdvancedOptions && (
            <div className={styles.grid}>
              <label className={styles.field}>
                <span>Tactical lookahead (plies)</span>
                <input
                  inputMode="numeric"
                  value={tacticalLookaheadPlies}
                  onChange={(e) => setTacticalLookaheadPlies(e.target.value)}
                  title="How many plies into PV to look for tactical moves."
                />
              </label>
              <label className={styles.field}>
                <span>Skip opening plies</span>
                <input
                  inputMode="numeric"
                  value={openingSkipPlies}
                  onChange={(e) => setOpeningSkipPlies(e.target.value)}
                  title="Skip the first N plies to avoid opening theory noise."
                />
              </label>
              <label className={styles.field}>
                <span>Min PV length (moves)</span>
                <input
                  inputMode="numeric"
                  value={minPvMoves}
                  onChange={(e) => setMinPvMoves(e.target.value)}
                  title="Require engine PV to be at least this long."
                />
              </label>
              <label className={styles.field}>
                <span>Min pieces (endgame filter)</span>
                <input
                  inputMode="numeric"
                  value={minNonKingPieces}
                  onChange={(e) => setMinNonKingPieces(e.target.value)}
                  title="Minimum non-king pieces to analyze position."
                />
              </label>
              <label className={styles.field}>
                <span>Confirm movetime (ms)</span>
                <input
                  inputMode="numeric"
                  value={confirmMovetimeMs}
                  onChange={(e) => setConfirmMovetimeMs(e.target.value)}
                  placeholder="Empty = disabled"
                  title="Re-evaluate candidates at higher depth. Empty to disable."
                />
              </label>
            </div>
          )}

          <div className={styles.actions}>
            <button className={styles.primaryButton} onClick={onEvalPosition} disabled={engineBusy}>
              {engineBusy ? "Evaluating…" : "Evaluate current position"}
            </button>
            <button className={styles.secondaryButton} onClick={onGeneratePuzzles} disabled={analyzing}>
              {analyzing ? "Analyzing games…" : "Generate puzzles from selected games"}
            </button>
            {engineResult?.score && (
              <div className={styles.mono}>
                {engineResult.score.type === "cp"
                  ? `Score: ${(engineResult.score.value / 100).toFixed(2)}`
                  : `Mate: ${engineResult.score.value}`}
                {engineResult.depth ? ` (d${engineResult.depth})` : ""}
              </div>
            )}
          </div>
          {analysisProgress && <div className={styles.muted}>{analysisProgress}</div>}
          {engineResult && (
            <div className={styles.muted}>
              Best: <span className={styles.mono}>{engineResult.bestMoveUci || "?"}</span>{" "}
              {engineResult.pvUci.length > 0 ? (
                <>
                  • PV: <span className={styles.mono}>{engineResult.pvUci.slice(0, 8).join(" ")}</span>
                </>
              ) : null}
            </div>
          )}
          {engineError && <div className={styles.error}>{engineError}</div>}
        </section>

        <section className={styles.panel}>
          <h2>4) Puzzles</h2>
          {puzzles.length === 0 ? (
            <p className={styles.muted}>Generate puzzles to see them here.</p>
          ) : (
            <>
              <div className={styles.actions}>
                <label className={styles.field}>
                  <span>Opening</span>
                  <select
                    value={puzzleOpeningFilter}
                    onChange={(e) => {
                      setPuzzleOpeningFilter(e.target.value);
                      setPuzzleIdx(0);
                    }}
                  >
                    <option value="">Any</option>
                    {allPuzzleOpenings.map((k) => (
                      <option key={k} value={k}>
                        {puzzleOpeningLabelFromKey(k)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>Filter by tags</span>
                  <select
                    multiple
                    value={puzzleTagFilter}
                    onChange={(e) => {
                      const next = Array.from(e.target.selectedOptions).map((o) => o.value);
                      setPuzzleTagFilter(next);
                      setPuzzleIdx(0);
                    }}
                  >
                    {allPuzzleTags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                {(puzzleTagFilter.length > 0 || puzzleOpeningFilter) && (
                  <button
                    className={styles.secondaryButton}
                    onClick={() => {
                      setPuzzleTagFilter([]);
                      setPuzzleOpeningFilter("");
                      setPuzzleIdx(0);
                    }}
                  >
                    Clear filters
                  </button>
                )}
                <div className={styles.muted}>
                  Showing {visiblePuzzles.length}/{puzzles.length}
                </div>
              </div>

              {visiblePuzzles.length === 0 ? (
                <p className={styles.muted}>No puzzles match the selected tags.</p>
              ) : (
                <PuzzlePanel
                  puzzles={visiblePuzzles}
                  puzzleIdx={puzzleIdx}
                  setPuzzleIdx={setPuzzleIdx}
                  currentPuzzle={currentPuzzle}
                  puzzleSourceGame={puzzleSourceGame}
                  puzzleSourceParsed={puzzleSourceParsed}
                  userBoardOrientation={userBoardOrientation}
                  engineClient={engineClient}
                  setEngineClient={setEngineClient}
                  engineMoveTimeMs={engineMoveTimeMs}
                />
              )}

              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Opening</th>
                      <th>Type</th>
                      <th>Severity</th>
                      <th>Tags</th>
                      <th>Game</th>
                      <th>Ply</th>
                      <th>Best</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visiblePuzzles.map((p, idx) => (
                      <tr key={p.id} className={idx === puzzleIdx ? styles.activeRow : undefined}>
                        <td className={styles.mono}>{idx + 1}</td>
                        <td className={styles.mono}>{puzzleOpeningLabelFromKey(puzzleOpeningKey(p))}</td>
                        <td>{p.type}</td>
                        <td className={styles.mono}>{p.severity ?? "-"}</td>
                        <td className={styles.mono}>{(p.tags ?? []).join(", ") || "-"}</td>
                        <td className={styles.mono}>{p.sourceGameId}</td>
                        <td className={styles.mono}>{p.sourcePly + 1}</td>
                        <td className={styles.mono}>
                          <button className={styles.linkButton} onClick={() => setPuzzleIdx(idx)}>
                            {p.bestMoveUci}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
