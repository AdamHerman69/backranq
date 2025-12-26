"use client";

import styles from "../page.module.css";
import type { NormalizedGame } from "@/lib/types/game";
import type { Puzzle } from "@/lib/analysis/puzzles";
import { StockfishClient, type EvalResult, type Score } from "@/lib/analysis/stockfishClient";
import { Chess, type Move, type Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { applyUciLine, moveToUci, parseUci, prettyTurnFromFen, uciLineToSan, uciToSan } from "@/lib/chess/utils";
import { ecoName } from "@/lib/chess/eco";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GameAnalysis, MoveClassification } from "@/lib/analysis/classification";
import { getClassificationSymbol } from "@/lib/analysis/classification";
import { usePuzzleAttempt } from "@/lib/hooks/usePuzzleAttempt";
import { useStockfishLiveMultiPvAnalysis } from "@/lib/hooks/useStockfishLiveMultiPvAnalysis";

type VerboseMove = Move;

type LineKind = "best" | "afterUser";

function formatEval(score: Score | null, fen: string): string {
  if (!score) return "—";
  const turn = fen.split(" ")[1] === "b" ? "b" : "w";
  const sign = turn === "w" ? 1 : -1; // convert to White POV
  if (score.type === "cp") {
    const v = (score.value / 100) * sign;
    const s = v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1);
    return s;
  }
  // mate: positive means side-to-move mates; convert to White POV
  const mv = score.value * sign;
  return `#${mv}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function scoreToUnit(score: Score | null, fen: string): number {
  // Returns 0..1 where 1 is White winning, 0 is Black winning.
  if (!score) return 0.5;
  const turn = fen.split(" ")[1] === "b" ? "b" : "w";
  const sign = turn === "w" ? 1 : -1; // to White POV

  if (score.type === "mate") {
    const mv = score.value * sign;
    return mv > 0 ? 1 : 0;
  }
  const cp = score.value * sign;
  // squish with tanh around ~600cp
  const x = cp / 600;
  const t = Math.tanh(x);
  return 0.5 + 0.5 * t;
}

export function PuzzlePanel(props: {
  puzzles: Puzzle[];
  puzzleIdx: number;
  setPuzzleIdx: React.Dispatch<React.SetStateAction<number>>;
  currentPuzzle: Puzzle | null;
  puzzleSourceGame: NormalizedGame | null;
  puzzleSourceParsed: { startFen: string; moves: VerboseMove[] } | null;
  userBoardOrientation: "white" | "black";
  engineClient: StockfishClient | null;
  setEngineClient: React.Dispatch<React.SetStateAction<StockfishClient | null>>;
  engineMoveTimeMs: string;
  /** Move-by-move analysis for the source game (if available) */
  gameAnalysis?: GameAnalysis | null;
  /** All puzzles (for marking puzzle moves in the game tab) */
  allPuzzles?: Puzzle[];
}) {
  const {
    puzzles,
    puzzleIdx,
    setPuzzleIdx,
    currentPuzzle,
    puzzleSourceGame,
    puzzleSourceParsed,
    userBoardOrientation,
    engineClient,
    setEngineClient,
    engineMoveTimeMs,
    gameAnalysis,
    allPuzzles,
  } = props;

  const [tab, setTab] = useState<"puzzle" | "game" | "analyze">("puzzle");
  const [attemptFen, setAttemptFen] = useState<string>(new Chess().fen());
  const [attemptLastMove, setAttemptLastMove] = useState<{ from: string; to: string } | null>(null);
  const [attemptUci, setAttemptUci] = useState<string | null>(null);
  const [attemptResult, setAttemptResult] = useState<"correct" | "incorrect" | null>(null);
  const [solvedKind, setSolvedKind] = useState<"best" | "safe" | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [gamePly, setGamePly] = useState(0);

  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalTargets, setLegalTargets] = useState<Set<string>>(new Set());
  const [showAllLegal, setShowAllLegal] = useState(false);
  const [showBestArrow, setShowBestArrow] = useState(true);
  const [showUserArrow, setShowUserArrow] = useState(true);

  const [lineKind, setLineKind] = useState<LineKind>("best");
  const [lineStep, setLineStep] = useState(0);
  const [evalPerStep, setEvalPerStep] = useState(false);

  // Analyze tab (live Stockfish)
  const [analyzeRootFen, setAnalyzeRootFen] = useState<string>(new Chess().fen());
  const [analyzePvStep, setAnalyzePvStep] = useState(0);
  const [analyzeEnabled, setAnalyzeEnabled] = useState(true);
  const [analyzeMultiPv, setAnalyzeMultiPv] = useState(3);
  const [analyzeSelectedIdx, setAnalyzeSelectedIdx] = useState(0);
  const [analyzeSelectedKey, setAnalyzeSelectedKey] = useState<string | null>(null);

  const [afterUserEval, setAfterUserEval] = useState<EvalResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [engineErr, setEngineErr] = useState<string | null>(null);

  const evalCacheRef = useRef<Map<string, EvalResult>>(new Map());
  const recordedAttemptRef = useRef(false);
  const { startAttempt, recordAttempt, saving: attemptSaving, queued: attemptQueued } = usePuzzleAttempt();

  // reset per puzzle
  useEffect(() => {
    if (!currentPuzzle) return;
    setTab("puzzle");
    setAttemptFen(currentPuzzle.fen);
    setAttemptLastMove(null);
    setAttemptUci(null);
    setAttemptResult(null);
    setSolvedKind(null);
    setShowSolution(false);
    setGamePly(currentPuzzle.sourcePly);
    setSelectedSquare(null);
    setLegalTargets(new Set());
    setLineKind("best");
    setLineStep(0);
    setAnalyzeRootFen(currentPuzzle.fen);
    setAnalyzePvStep(0);
    setAnalyzeEnabled(true);
    setAnalyzeMultiPv(3);
    setAnalyzeSelectedIdx(0);
    setAnalyzeSelectedKey(null);
    setAfterUserEval(null);
    setEngineErr(null);
    recordedAttemptRef.current = false;
    startAttempt(currentPuzzle.id);
  }, [currentPuzzle, startAttempt]);

  const movetimeMs = useMemo(() => Math.max(1, Math.trunc(Number(engineMoveTimeMs) || 200)), [engineMoveTimeMs]);

  // Ensure engine is available for analyze tab.
  useEffect(() => {
    if (tab !== "analyze") return;
    if (!engineClient) setEngineClient(new StockfishClient());
  }, [tab, engineClient, setEngineClient]);

  const puzzleGameFen = useMemo(() => {
    if (!puzzleSourceParsed) return null;
    const c = new Chess(puzzleSourceParsed.startFen);
    const until = clamp(gamePly, 0, puzzleSourceParsed.moves.length);
    try {
      for (let i = 0; i < until; i++) {
        const mv = puzzleSourceParsed.moves[i];
        c.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
      }
      return c.fen();
    } catch {
      return c.fen();
    }
  }, [puzzleSourceParsed, gamePly]);

  const puzzleGameLastMove = useMemo(() => {
    if (!puzzleSourceParsed) return null;
    if (gamePly <= 0) return null;
    const mv = puzzleSourceParsed.moves[gamePly - 1];
    if (!mv) return null;
    return { from: mv.from, to: mv.to };
  }, [puzzleSourceParsed, gamePly]);

  const playedMoveInGame = useMemo(() => {
    if (!currentPuzzle || !puzzleSourceParsed) return null;
    const mv = puzzleSourceParsed.moves[currentPuzzle.sourcePly];
    if (!mv) return null;
    return { san: mv.san, uci: moveToUci(mv), from: mv.from, to: mv.to, promotion: mv.promotion };
  }, [currentPuzzle, puzzleSourceParsed]);

  const playedContinuationUci = useMemo(() => {
    if (!currentPuzzle || !puzzleSourceParsed) return [];
    return puzzleSourceParsed.moves
      .slice(currentPuzzle.sourcePly, currentPuzzle.sourcePly + 8)
      .map((m) => moveToUci(m));
  }, [currentPuzzle, puzzleSourceParsed]);

  const allowAttemptMove = tab === "puzzle" && attemptResult == null;

  // Record the FIRST attempt per puzzle load (not after reset).
  useEffect(() => {
    if (!currentPuzzle) return;
    if (!attemptUci) return;
    if (!attemptResult) return;
    if (recordedAttemptRef.current) return;
    recordedAttemptRef.current = true;
    void recordAttempt({
      puzzleId: currentPuzzle.id,
      move: attemptUci,
      correct: attemptResult === "correct",
    });
  }, [currentPuzzle, attemptUci, attemptResult, recordAttempt]);

  const bestMoveParsed = useMemo(() => {
    if (!currentPuzzle) return null;
    return parseUci(currentPuzzle.bestMoveUci);
  }, [currentPuzzle]);

  const lineBestApplied = useMemo(() => {
    if (!currentPuzzle) return [{ fen: new Chess().fen(), lastMove: null as { from: string; to: string } | null }];
    return applyUciLine(currentPuzzle.fen, currentPuzzle.bestLineUci, 12);
  }, [currentPuzzle]);

  const lineAfterUserUci = useMemo(() => {
    if (!attemptUci) return [];
    const pv = afterUserEval?.pvUci ?? [];
    return [attemptUci, ...pv].slice(0, 12);
  }, [attemptUci, afterUserEval]);

  const lineAfterUserApplied = useMemo(() => {
    if (!currentPuzzle) return [{ fen: new Chess().fen(), lastMove: null as { from: string; to: string } | null }];
    return applyUciLine(currentPuzzle.fen, lineAfterUserUci, 12);
  }, [currentPuzzle, lineAfterUserUci]);

  const activeLineApplied = lineKind === "best" ? lineBestApplied : lineAfterUserApplied;

  const exploring = attemptResult != null && tab === "puzzle";

  const liveAnalyze = useStockfishLiveMultiPvAnalysis({
    client: engineClient,
    fen: tab === "analyze" ? analyzeRootFen : null,
    multiPv: analyzeMultiPv,
    enabled: tab === "analyze" && analyzeEnabled,
    emitIntervalMs: 150,
  });

  useEffect(() => {
    if (tab !== "analyze") return;
    setAnalyzeSelectedIdx(0);
    setAnalyzeSelectedKey(null);
    setAnalyzePvStep(0);
  }, [tab, analyzeRootFen, analyzeMultiPv]);

  const analyzeSelectedLine = useMemo(() => {
    const lines = liveAnalyze.lines ?? [];
    if (analyzeSelectedKey) {
      const idx = lines.findIndex((l) => (l.pvUci ?? []).join(" ") === analyzeSelectedKey);
      if (idx >= 0) return idx;
    }
    return Math.max(0, Math.min(analyzeSelectedIdx, lines.length - 1));
  }, [liveAnalyze.lines, analyzeSelectedIdx, analyzeSelectedKey]);

  const analyzeLineUci = useMemo(() => {
    const lines = liveAnalyze.lines ?? [];
    const selected = lines[analyzeSelectedLine] ?? lines[0];
    return selected?.pvUci ?? [];
  }, [liveAnalyze.lines, analyzeSelectedLine]);

  const analyzeApplied = useMemo(() => {
    return applyUciLine(analyzeRootFen, analyzeLineUci, 18);
  }, [analyzeRootFen, analyzeLineUci]);

  const displayFen = useMemo(() => {
    if (!currentPuzzle) return new Chess().fen();
    if (tab === "analyze") return analyzeApplied[clamp(analyzePvStep, 0, analyzeApplied.length - 1)]?.fen ?? analyzeRootFen;
    if (tab === "game") return puzzleGameFen ?? currentPuzzle.fen;
    if (exploring) return activeLineApplied[clamp(lineStep, 0, activeLineApplied.length - 1)]?.fen ?? currentPuzzle.fen;
    return attemptFen;
  }, [currentPuzzle, tab, analyzeApplied, analyzePvStep, analyzeRootFen, puzzleGameFen, exploring, activeLineApplied, lineStep, attemptFen]);

  const displayLastMove = useMemo(() => {
    if (tab === "analyze") return analyzeApplied[clamp(analyzePvStep, 0, analyzeApplied.length - 1)]?.lastMove ?? null;
    if (tab === "game") return puzzleGameLastMove;
    if (!exploring) return attemptLastMove;
    return activeLineApplied[clamp(lineStep, 0, activeLineApplied.length - 1)]?.lastMove ?? null;
  }, [tab, analyzeApplied, analyzePvStep, puzzleGameLastMove, exploring, attemptLastMove, activeLineApplied, lineStep]);

  const allLegalTargets = useMemo(() => {
    if (!showAllLegal || !allowAttemptMove) return new Set<string>();
    const c = new Chess(displayFen);
    const moves = c.moves({ verbose: true }) as VerboseMove[];
    return new Set(moves.map((m) => m.to));
  }, [showAllLegal, allowAttemptMove, displayFen]);

  const arrows = useMemo(() => {
    const byKey = new Map<string, { startSquare: string; endSquare: string; color: string }>();
    const put = (a: { startSquare: string; endSquare: string; color: string }) => {
      // react-chessboard keys arrows by `${from}-${to}`; dedupe to avoid React key collisions.
      byKey.set(`${a.startSquare}-${a.endSquare}`, a);
    };
    if (tab === "analyze") {
      const first = (liveAnalyze.lines ?? [])[analyzeSelectedLine]?.pvUci?.[0];
      const u = first ? parseUci(first) : null;
      if (u) put({ startSquare: u.from, endSquare: u.to, color: "rgba(64, 132, 255, 0.85)" });
      return Array.from(byKey.values());
    }
    if (tab !== "puzzle") return [];
    if (showBestArrow && attemptResult === "incorrect" && bestMoveParsed) {
      put({ startSquare: bestMoveParsed.from, endSquare: bestMoveParsed.to, color: "rgba(255,70,70,0.9)" });
    }
    if (showUserArrow && attemptLastMove) {
      // User arrow last so it wins if it matches best move.
      put({ startSquare: attemptLastMove.from, endSquare: attemptLastMove.to, color: "rgba(255,215,0,0.9)" });
    }
    return Array.from(byKey.values());
  }, [tab, liveAnalyze.lines, analyzeSelectedLine, showUserArrow, attemptLastMove, showBestArrow, attemptResult, bestMoveParsed]);

  const squareStyles = useMemo(() => {
    const s: Record<string, React.CSSProperties> = {};

    // last move highlight
    if (displayLastMove) {
      s[displayLastMove.from] = { backgroundColor: "rgba(255, 215, 0, 0.22)" };
      s[displayLastMove.to] = { backgroundColor: "rgba(255, 215, 0, 0.45)" };
    }

    // legal hints for selected piece
    if (selectedSquare) {
      s[selectedSquare] = { ...(s[selectedSquare] ?? {}), boxShadow: "inset 0 0 0 3px rgba(64, 132, 255, 0.9)" };
    }
    for (const to of legalTargets) {
      s[to] = { ...(s[to] ?? {}), backgroundColor: "rgba(64, 132, 255, 0.22)" };
    }
    for (const to of allLegalTargets) {
      s[to] = { ...(s[to] ?? {}), backgroundColor: "rgba(64, 132, 255, 0.10)" };
    }

    // incorrect: highlight best move
    if (attemptResult === "incorrect" && bestMoveParsed) {
      s[bestMoveParsed.from] = { ...(s[bestMoveParsed.from] ?? {}), backgroundColor: "rgba(255, 70, 70, 0.25)" };
      s[bestMoveParsed.to] = { ...(s[bestMoveParsed.to] ?? {}), backgroundColor: "rgba(255, 70, 70, 0.45)" };
    }

    return s;
  }, [displayLastMove, selectedSquare, legalTargets, allLegalTargets, attemptResult, bestMoveParsed]);

  const ensureEngine = useCallback(async (): Promise<StockfishClient> => {
    const client = engineClient ?? new StockfishClient();
    if (!engineClient) setEngineClient(client);
    return client;
  }, [engineClient, setEngineClient]);

  const evalFen = useCallback(
    async (fen: string): Promise<EvalResult> => {
      const key = `${fen}::${movetimeMs}`;
      const cached = evalCacheRef.current.get(key);
      if (cached) return cached;
      const client = await ensureEngine();
      const res = await client.evalPosition({ fen, movetimeMs, cacheKey: key });
      evalCacheRef.current.set(key, res);
      return res;
    },
    [ensureEngine, movetimeMs],
  );

  // evaluate after user's move once they attempt
  useEffect(() => {
    if (!currentPuzzle) return;
    if (!attemptResult || !attemptUci) return;
    if (attemptResult !== "incorrect" && attemptResult !== "correct") return;

    // only compute the continuation that starts from after the user's move
    const c = new Chess(currentPuzzle.fen);
    const parsed = parseUci(attemptUci);
    if (!parsed) return;
    try {
      const mv = c.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
      if (!mv) return;
    } catch {
      return;
    }
    const afterFen = c.fen();
    let cancelled = false;

    (async () => {
      setBusy(true);
      setEngineErr(null);
      try {
        const res = await evalFen(afterFen);
        if (!cancelled) setAfterUserEval(res);
      } catch (e: unknown) {
        if (!cancelled) setEngineErr(e instanceof Error ? e.message : "Engine error");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentPuzzle, attemptResult, attemptUci, evalFen]);

  // optional per-step eval in explorer
  const activeStepEval = useMemo(() => {
    if (!evalPerStep) return null;
    const fen = displayFen;
    return evalCacheRef.current.get(`${fen}::${movetimeMs}`) ?? null;
  }, [evalPerStep, displayFen, movetimeMs]);

  useEffect(() => {
    if (!evalPerStep) return;
    if (!exploring) return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      setEngineErr(null);
      try {
        await evalFen(displayFen);
      } catch (e: unknown) {
        if (!cancelled) setEngineErr(e instanceof Error ? e.message : "Engine error");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [evalPerStep, exploring, displayFen, evalFen]);

  function clearHints() {
    setSelectedSquare(null);
    setLegalTargets(new Set());
  }

  function computeHints(square: string) {
    if (!allowAttemptMove) return;
    const c = new Chess(displayFen);
    const moves = c.moves({ square: square as Square, verbose: true }) as VerboseMove[];
    setSelectedSquare(square);
    setLegalTargets(new Set(moves.map((m) => m.to)));
  }

  const startEvalText = useMemo(() => (currentPuzzle ? formatEval(currentPuzzle.score, currentPuzzle.fen) : "—"), [currentPuzzle]);
  const afterMoveEvalText = useMemo(() => {
    if (!attemptResult || !afterUserEval) return "—";
    return formatEval(afterUserEval.score, afterUserEval.fen);
  }, [attemptResult, afterUserEval]);
  const activeEvalText = useMemo(() => {
    if (!evalPerStep) return null;
    if (!activeStepEval) return "…";
    return formatEval(activeStepEval.score, activeStepEval.fen);
  }, [evalPerStep, activeStepEval]);

  const evalUnit = useMemo(() => {
    if (!currentPuzzle) return 0.5;
    if (!exploring && !attemptResult) return scoreToUnit(currentPuzzle.score, currentPuzzle.fen);
    if (!exploring) return afterUserEval?.score ? scoreToUnit(afterUserEval.score, afterUserEval.fen) : scoreToUnit(currentPuzzle.score, currentPuzzle.fen);
    const s = activeStepEval?.score ?? null;
    return scoreToUnit(s, displayFen);
  }, [currentPuzzle, exploring, attemptResult, afterUserEval, activeStepEval, displayFen]);

  const openingText = useMemo(() => {
    if (!currentPuzzle) return null;
    const o = currentPuzzle.opening;
    if (o?.eco || o?.name || o?.variation) {
      const nm = o.name ?? ecoName(o.eco) ?? "";
      const base = `${o.eco ? `${o.eco} ` : ""}${nm}`.trim();
      return o.variation ? `${base} — ${o.variation}` : base || null;
    }
    return null;
  }, [currentPuzzle]);

  // Map puzzles to their source plies for the current puzzle's source game
  const gamePuzzleMap = useMemo(() => {
    const map = new Map<number, Puzzle>();
    const gameId = currentPuzzle?.sourceGameId;
    if (!gameId) return map;
    const puzzlesToCheck = allPuzzles ?? puzzles;
    for (const p of puzzlesToCheck) {
      if (p.sourceGameId === gameId) {
        map.set(p.sourcePly, p);
      }
    }
    return map;
  }, [currentPuzzle?.sourceGameId, allPuzzles, puzzles]);

  // Helper to get classification CSS class name
  function getClassificationClassName(classification: MoveClassification | undefined): string {
    if (!classification) return "";
    const classMap: Record<MoveClassification, string> = {
      brilliant: styles.moveBrilliant,
      great: styles.moveGreat,
      best: styles.moveBest,
      excellent: styles.moveExcellent,
      good: styles.moveGood,
      book: styles.moveBook,
      inaccuracy: styles.moveInaccuracy,
      mistake: styles.moveMistake,
      blunder: styles.moveBlunder,
    };
    return classMap[classification] ?? "";
  }

  if (!currentPuzzle) {
    return <p className={styles.muted}>Pick a puzzle to start solving.</p>;
  }

  return (
    <>
      <div className={styles.actions}>
        <button className={styles.secondaryButton} onClick={() => setPuzzleIdx((i) => Math.max(0, i - 1))} disabled={puzzleIdx === 0}>
          Prev
        </button>
        <button
          className={styles.secondaryButton}
          onClick={() => setPuzzleIdx((i) => Math.min(puzzles.length - 1, i + 1))}
          disabled={puzzleIdx >= puzzles.length - 1}
        >
          Next
        </button>
        <div className={styles.muted}>
          Puzzle {puzzleIdx + 1}/{puzzles.length} • {currentPuzzle.type}
          {(currentPuzzle.acceptedMovesUci ?? []).length > 1 ? " • Multiple correct" : ""}
          {openingText ? ` • ${openingText}` : ""}
        </div>
      </div>

      <div className={styles.viewer}>
        <div className={styles.board}>
          <div className={styles.actions}>
            <button className={tab === "puzzle" ? styles.primaryButton : styles.secondaryButton} onClick={() => setTab("puzzle")}>
              Puzzle
            </button>
            <button
              className={tab === "game" ? styles.primaryButton : styles.secondaryButton}
              onClick={() => setTab("game")}
              disabled={!puzzleSourceParsed}
            >
              Game
            </button>
            <button
              className={tab === "analyze" ? styles.primaryButton : styles.secondaryButton}
              onClick={() => {
                setAnalyzeRootFen(displayFen);
                setAnalyzePvStep(0);
                setAnalyzeEnabled(true);
                setTab("analyze");
              }}
            >
              Analyze
            </button>
            <div className={styles.muted}>
              {puzzleSourceGame ? (
                <>
                  {puzzleSourceGame.provider} • {puzzleSourceGame.white.name} vs {puzzleSourceGame.black.name}
                </>
              ) : (
                "Source game not loaded"
              )}
            </div>
          </div>

          {tab === "puzzle" && (
            <div className={styles.puzzleHud}>
              <div className={styles.turnChip}>{prettyTurnFromFen(displayFen)}</div>
              <div className={styles.evalWrap}>
                <div className={styles.evalBar}>
                  <div className={styles.evalMarker} style={{ left: `${Math.round(evalUnit * 100)}%` }} />
                </div>
                <div className={styles.mono}>
                  Start {startEvalText}
                  {attemptResult ? ` • After ${afterMoveEvalText}` : ""}
                  {activeEvalText ? ` • Step ${activeEvalText}` : ""}
                </div>
              </div>
            </div>
          )}

          <Chessboard
            options={{
              position: displayFen,
              boardOrientation: userBoardOrientation,
              allowDragging: allowAttemptMove,
              allowDrawingArrows: false,
              arrows,
              squareStyles,
              onPieceClick: ({ square }) => {
                if (!square) return;
                computeHints(square);
              },
              onSquareClick: ({ piece, square }) => {
                if (!piece) return clearHints();
                computeHints(square);
              },
              onSquareMouseDown: ({ piece, square }) => {
                if (!piece) return;
                computeHints(square);
              },
              onSquareMouseUp: () => {
                // keep selection until next interaction; feels more puzzle-like
              },
              onMouseOutSquare: () => {
                // no-op
              },
              onPieceDrop: allowAttemptMove
                ? ({ sourceSquare, targetSquare, piece }) => {
                    clearHints();
                    if (!targetSquare) return false;
                    const c = new Chess(attemptFen);
                    const from = sourceSquare;
                    const to = targetSquare;
                    const pt = (piece?.pieceType ?? "").toLowerCase();
                    const isPawn = pt.endsWith("p");
                    const promotionRank = to[1] === "8" || to[1] === "1";
                    const promotion = isPawn && promotionRank ? "q" : undefined;
                    try {
                      const mv = c.move({ from, to, promotion });
                      if (!mv) return false;
                    } catch {
                      return false;
                    }
                    const uci = moveToUci({ from, to, promotion });
                    setAttemptFen(c.fen());
                    setAttemptLastMove({ from, to });
                    setAttemptUci(uci);
                    const best = (currentPuzzle.bestMoveUci ?? "").trim().toLowerCase();
                    const played = uci.trim().toLowerCase();
                    const accepted = new Set(
                      [best, ...((currentPuzzle.acceptedMovesUci ?? []) as string[])]
                        .map((s) => (s ?? "").trim().toLowerCase())
                        .filter(Boolean),
                    );
                    const correct = accepted.has(played);
                    setAttemptResult(correct ? "correct" : "incorrect");
                    setSolvedKind(correct ? (played === best ? "best" : "safe") : null);
                    setLineKind(uci === currentPuzzle.bestMoveUci ? "best" : "best");
                    setLineStep(0);
                    return true;
                  }
                : undefined,
            }}
          />

          {tab === "puzzle" ? (
            <>
              <div className={styles.muted}>{currentPuzzle.label}</div>

              <div className={styles.puzzleToggles}>
                <label className={styles.toggle}>
                  <input type="checkbox" checked={showAllLegal} onChange={(e) => setShowAllLegal(e.target.checked)} disabled={!allowAttemptMove} />
                  <span>Show all legal moves</span>
                </label>
                <label className={styles.toggle}>
                  <input type="checkbox" checked={showBestArrow} onChange={(e) => setShowBestArrow(e.target.checked)} />
                  <span>Best-move arrow</span>
                </label>
                <label className={styles.toggle}>
                  <input type="checkbox" checked={showUserArrow} onChange={(e) => setShowUserArrow(e.target.checked)} />
                  <span>Your-move arrow</span>
                </label>
                <label className={styles.toggle}>
                  <input type="checkbox" checked={evalPerStep} onChange={(e) => setEvalPerStep(e.target.checked)} disabled={!exploring} />
                  <span>Eval per step</span>
                </label>
              </div>

              <div className={styles.actions}>
                <button
                  className={styles.secondaryButton}
                  onClick={() => {
                    setAttemptFen(currentPuzzle.fen);
                    setAttemptLastMove(null);
                    setAttemptUci(null);
                    setAttemptResult(null);
                    setShowSolution(false);
                    setLineKind("best");
                    setLineStep(0);
                    setAfterUserEval(null);
                    setEngineErr(null);
                    clearHints();
                  }}
                >
                  Reset
                </button>
                <button className={styles.secondaryButton} onClick={() => setShowSolution(true)}>
                  Solve
                </button>
                <div className={styles.muted}>
                  Best move:{" "}
                  <span className={styles.mono}>
                    {uciToSan(currentPuzzle.fen, currentPuzzle.bestMoveUci) ?? currentPuzzle.bestMoveUci}
                  </span>
                </div>
                {busy ? <div className={styles.muted}>Engine…</div> : null}
                {engineErr ? <div className={styles.error}>{engineErr}</div> : null}
              </div>

              {attemptResult && (
                <div className={attemptResult === "correct" ? styles.success : styles.warning}>
                  {attemptResult === "correct"
                    ? solvedKind === "safe"
                      ? currentPuzzle.mode === "avoidBlunder"
                      ? `Good save! (${attemptUci}) Best was ${
                          uciToSan(currentPuzzle.fen, currentPuzzle.bestMoveUci) ?? currentPuzzle.bestMoveUci
                        }.`
                        : `Correct! (${attemptUci}) Best was ${
                            uciToSan(currentPuzzle.fen, currentPuzzle.bestMoveUci) ?? currentPuzzle.bestMoveUci
                          }.`
                      : `Correct! (${attemptUci})`
                    : `Not best. You played ${attemptUci}.`}
                </div>
              )}
              {attemptSaving || attemptQueued > 0 ? (
                <div className={styles.muted} style={{ fontSize: 12 }}>
                  {attemptSaving ? "Saving attempt…" : null}
                  {!attemptSaving && attemptQueued > 0 ? `Attempts queued: ${attemptQueued}` : null}
                </div>
              ) : null}

              {exploring && (
                <div className={styles.lineExplorer}>
                  <div className={styles.actions}>
                    <button
                      className={lineKind === "best" ? styles.primaryButton : styles.secondaryButton}
                      onClick={() => {
                        setLineKind("best");
                        setLineStep(0);
                      }}
                    >
                      Best line
                    </button>
                    <button
                      className={lineKind === "afterUser" ? styles.primaryButton : styles.secondaryButton}
                      onClick={() => {
                        setLineKind("afterUser");
                        setLineStep(0);
                      }}
                      disabled={!attemptUci}
                    >
                      After your move
                    </button>

                    <button className={styles.secondaryButton} onClick={() => setLineStep(0)} disabled={lineStep === 0}>
                      Start
                    </button>
                    <button className={styles.secondaryButton} onClick={() => setLineStep((s) => Math.max(0, s - 1))} disabled={lineStep === 0}>
                      Back
                    </button>
                    <div className={styles.muted}>
                      Step {lineStep}/{Math.max(0, activeLineApplied.length - 1)}
                    </div>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setLineStep((s) => Math.min(activeLineApplied.length - 1, s + 1))}
                      disabled={lineStep >= activeLineApplied.length - 1}
                    >
                      Next
                    </button>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setLineStep(activeLineApplied.length - 1)}
                      disabled={lineStep >= activeLineApplied.length - 1}
                    >
                      End
                    </button>
                  </div>

                  <div className={styles.muted}>
                    {lineKind === "best" ? (
                      <>
                        PV: <span className={styles.mono}>{currentPuzzle.bestLineUci.slice(0, 12).join(" ")}</span>
                      </>
                    ) : (
                      <>
                        Line: <span className={styles.mono}>{lineAfterUserUci.slice(0, 12).join(" ")}</span>
                      </>
                    )}
                  </div>
                </div>
              )}

              {showSolution && (
                <div className={styles.solution}>
                  <div className={styles.muted}>
                    In-game move: <span className={styles.mono}>{playedMoveInGame?.san ?? "?"} ({playedMoveInGame?.uci ?? "?"})</span>
                  </div>
                  <div className={styles.muted}>
                    Best move:{" "}
                    <span className={styles.mono}>
                      {uciToSan(currentPuzzle.fen, currentPuzzle.bestMoveUci) ?? currentPuzzle.bestMoveUci}
                    </span>
                  </div>
                  {currentPuzzle.bestLineUci.length > 0 && (
                    <div className={styles.muted}>
                      Best continuation: <span className={styles.mono}>{currentPuzzle.bestLineUci.slice(0, 8).join(" ")}</span>
                    </div>
                  )}
                  {playedContinuationUci.length > 0 && (
                    <div className={styles.muted}>
                      Game continuation: <span className={styles.mono}>{playedContinuationUci.slice(0, 8).join(" ")}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ) : tab === "game" ? (
            <>
              <div className={styles.actions}>
                <button className={styles.secondaryButton} onClick={() => setGamePly(0)} disabled={!puzzleSourceParsed || gamePly === 0}>
                  Start
                </button>
                <button className={styles.secondaryButton} onClick={() => setGamePly((p) => Math.max(0, p - 1))} disabled={!puzzleSourceParsed || gamePly === 0}>
                  Back
                </button>
                <div className={styles.muted}>
                  Ply {gamePly}/{puzzleSourceParsed?.moves.length ?? 0}
                </div>
                <button
                  className={styles.secondaryButton}
                  onClick={() => setGamePly((p) => Math.min(puzzleSourceParsed?.moves.length ?? 0, p + 1))}
                  disabled={!puzzleSourceParsed || gamePly >= (puzzleSourceParsed?.moves.length ?? 0)}
                >
                  Next
                </button>
                <button
                  className={styles.secondaryButton}
                  onClick={() => setGamePly(puzzleSourceParsed?.moves.length ?? 0)}
                  disabled={!puzzleSourceParsed || gamePly >= (puzzleSourceParsed?.moves.length ?? 0)}
                >
                  End
                </button>
              </div>

              {gameAnalysis && (
                <div className={styles.accuracyBar}>
                  <span className={`${styles.accuracyBadge} ${styles.accuracyWhite}`}>
                    ♔ {gameAnalysis.whiteAccuracy?.toFixed(1) ?? "—"}%
                  </span>
                  <span className={`${styles.accuracyBadge} ${styles.accuracyBlack}`}>
                    ♚ {gameAnalysis.blackAccuracy?.toFixed(1) ?? "—"}%
                  </span>
                </div>
              )}
              <ol className={styles.moveList}>
                {(puzzleSourceParsed?.moves ?? []).map((m, idx) => {
                  const analyzedMove = gameAnalysis?.moves.find((am) => am.ply === idx);
                  const puzzle = gamePuzzleMap.get(idx);
                  const classificationClass = getClassificationClassName(analyzedMove?.classification);
                  const hasPuzzle = !!puzzle || analyzedMove?.hasPuzzle;
                  const symbol = analyzedMove ? getClassificationSymbol(analyzedMove.classification) : "";
                  const isPuzzlePly = currentPuzzle?.sourcePly === idx;
                  
                  // Build tooltip
                  const tooltipParts: string[] = [];
                  if (analyzedMove) {
                    tooltipParts.push(`${analyzedMove.classification}`);
                    if (analyzedMove.cpLoss > 0) {
                      tooltipParts.push(`-${analyzedMove.cpLoss}cp`);
                    }
                    if (analyzedMove.bestMoveSan && m.san !== analyzedMove.bestMoveSan) {
                      tooltipParts.push(`Best: ${analyzedMove.bestMoveSan}`);
                    }
                  }
                  if (puzzle) {
                    tooltipParts.push(`📋 Puzzle: ${puzzle.type}`);
                  }
                  if (isPuzzlePly) {
                    tooltipParts.push(`← Current puzzle`);
                  }
                  
                  return (
                    <li key={`${idx}-${m.san}`}>
                      <button 
                        className={`${idx + 1 === gamePly ? styles.moveActive : styles.moveButton} ${classificationClass} ${hasPuzzle ? styles.puzzleMove : ""}`} 
                        onClick={() => setGamePly(idx + 1)}
                        title={tooltipParts.length > 0 ? tooltipParts.join(" • ") : undefined}
                        style={isPuzzlePly ? { outline: "2px solid #7b61ff", outlineOffset: "2px" } : undefined}
                      >
                        {m.san}
                        {symbol && <span className={styles.classificationSymbol}>{symbol}</span>}
                        {hasPuzzle && <span className={styles.puzzleIndicator} />}
                      </button>
                    </li>
                  );
                })}
              </ol>
            </>
          ) : (
            <>
              <div className={styles.actions}>
                <button
                  className={styles.secondaryButton}
                  onClick={() => {
                    setAnalyzeEnabled((v) => {
                      const next = !v;
                      if (next) liveAnalyze.start();
                      else liveAnalyze.stop();
                      return next;
                    });
                  }}
                >
                  {analyzeEnabled ? "Stop" : "Start"}
                </button>

                <label className={styles.toggle}>
                  <span>MultiPV</span>
                  <select
                    className={styles.secondaryButton}
                    value={String(analyzeMultiPv)}
                    onChange={(e) => setAnalyzeMultiPv(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={String(n)}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  className={styles.secondaryButton}
                  onClick={() => {
                    setAnalyzeRootFen(displayFen);
                    setAnalyzePvStep(0);
                    setAnalyzeSelectedIdx(0);
                    setAnalyzeSelectedKey(null);
                    setAnalyzeEnabled(true);
                    liveAnalyze.start();
                  }}
                >
                  Analyze this position
                </button>

                <div className={styles.muted}>
                  {liveAnalyze.error
                    ? liveAnalyze.error
                    : liveAnalyze.running
                      ? `Thinking…${typeof liveAnalyze.depth === "number" ? ` d${liveAnalyze.depth}` : ""}${
                          typeof liveAnalyze.timeMs === "number" ? ` ${(liveAnalyze.timeMs / 1000).toFixed(1)}s` : ""
                        }`
                      : "Idle"}
                </div>
              </div>

              <div className={styles.lineExplorer}>
                <div className={styles.actions}>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setAnalyzePvStep(0)}
                    disabled={analyzePvStep === 0}
                  >
                    Start
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setAnalyzePvStep((s) => Math.max(0, s - 1))}
                    disabled={analyzePvStep === 0}
                  >
                    Back
                  </button>
                  <div className={styles.muted}>
                    Step {analyzePvStep}/{Math.max(0, analyzeApplied.length - 1)}
                  </div>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setAnalyzePvStep((s) => Math.min(analyzeApplied.length - 1, s + 1))}
                    disabled={analyzePvStep >= analyzeApplied.length - 1}
                  >
                    Next
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => setAnalyzePvStep(Math.max(0, analyzeApplied.length - 1))}
                    disabled={analyzePvStep >= analyzeApplied.length - 1}
                  >
                    End
                  </button>
                </div>

                <div className={styles.muted}>
                  PV:{" "}
                  <span className={styles.mono}>
                    {analyzeRootFen ? uciLineToSan(analyzeRootFen, analyzeLineUci, 12).join(" ") : ""}
                  </span>
                </div>
              </div>

              <div className={styles.lineExplorer}>
                {(liveAnalyze.lines ?? []).slice(0, analyzeMultiPv).map((l, i) => (
                  <button
                    key={i}
                    className={i === analyzeSelectedLine ? styles.primaryButton : styles.secondaryButton}
                    onClick={() => {
                      setAnalyzeSelectedIdx(i);
                      setAnalyzeSelectedKey((l.pvUci ?? []).join(" "));
                      setAnalyzePvStep(0);
                    }}
                    title={
                      analyzeRootFen ? uciLineToSan(analyzeRootFen, l.pvUci ?? [], 16).join(" ") : undefined
                    }
                  >
                    #{i + 1} {formatEval(l.score, analyzeRootFen)}{" "}
                    {analyzeRootFen ? uciLineToSan(analyzeRootFen, l.pvUci ?? [], 5).join(" ") : ""}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <div className={styles.moves}>
          <div className={styles.muted}>{currentPuzzle.type}</div>
          {openingText ? <div className={styles.mono}>Opening: {openingText}</div> : null}
          <div className={styles.mono}>From: {currentPuzzle.sourceGameId}</div>
          <div className={styles.mono}>Puzzle ply: {currentPuzzle.sourcePly + 1}</div>
          <div className={styles.mono}>Orientation: {userBoardOrientation} (user side down)</div>
        </div>
      </div>
    </>
  );
}

