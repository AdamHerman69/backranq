## Agent prompts: analysis + puzzle improvements

This file contains **separate, well-scoped prompts** for agents to implement analysis/puzzle improvements.

### Ground truth references

-   **Chess.com move classifications (Expected Points Model)**: [Chess.com Help Center article](https://support.chess.com/en/articles/8572705-how-are-moves-classified-what-is-a-blunder-or-brilliant-etc)
-   **Lichess puzzle tagging reference implementation**: `https://github.com/ornicar/lichess-puzzler/tree/master/tagger`
-   **Lichess puzzle themes taxonomy** (useful for tag naming): [Lichess training themes](https://lichess.org/training/themes)

### Current code hotspots (BackRank)

-   **Move classification**: `src/lib/analysis/classification.ts`
-   **Puzzle extraction**: `src/lib/analysis/extractPuzzles.ts`
-   **Background analysis job**: `src/lib/analysis/backgroundAnalysisManager.ts`
-   **Analyze games modal (missing settings UI)**: `src/components/analysis/AnalyzeGamesModal.tsx`
-   **Defaults & persistence**: `src/lib/preferences.ts`, `src/app/api/user/preferences/route.ts`
-   **Puzzle trainer correctness logic** (currently single-best-move): `src/components/puzzles/PuzzleTrainerV2.tsx`
-   **Puzzle attempt API** (currently trusts client `wasCorrect`): `src/app/api/puzzles/[id]/attempt/route.ts`
-   **DB schema**: `prisma/schema.prisma`

## Prompt 2 — Restore “puzzle analysis settings” in Analyze Games modal + add saved defaults in Settings

### Goal

Bring back the old UX: when starting analysis, users can **configure puzzle extraction settings** and **save defaults**.

### Current state

-   `AnalyzeGamesModal.tsx` only selects games and starts background analysis.
-   Preferences defaults exist in `src/lib/preferences.ts` and are persisted in DB via `/api/user/preferences`.
-   Background analysis currently hardcodes options in `src/lib/analysis/backgroundAnalysisManager.ts`.

### Deliverables

-   Add a **settings section** to `src/components/analysis/AnalyzeGamesModal.tsx`:
    -   Puzzle mode: `avoidBlunder` / `punishBlunder` / `both`
    -   Engine move time (`engineMoveTimeMs`)
    -   Extraction gates already supported by `ExtractOptions`:
        -   `openingSkipPlies`, `minPvMoves`, `skipTrivialEndgames`, `minNonKingPieces`
        -   `evalBandMinCp`, `evalBandMaxCp`
        -   `requireTactical`, `tacticalLookaheadPlies`
        -   `maxPuzzlesPerGame` (allow unlimited)
        -   `blunderSwingCp`, `missedTacticSwingCp`
        -   `confirmMovetimeMs`
        -   (optionally) `uniquenessMarginCp`
    -   Use `GET /api/user/preferences` to prefill.
    -   Add “Save as defaults” (PUT preferences patch) and “Reset to defaults”.
-   Add an “Analysis defaults” card in `src/app/settings/page.tsx` (or a new component), letting users edit the same fields.
-   Modify `BackgroundAnalysisManager.analyzeOneGame` to **use stored preferences** (fall back to defaults) instead of hardcoded options.

### Acceptance criteria

-   Starting analysis uses the modal-selected settings.
-   Saved defaults persist across sessions and apply to background analysis.

---

## Prompt 3 — Improve puzzle extraction quality gates (reduce junk, reduce duplicates)

### Goal

Make extracted puzzles consistently “tactical and unique”, reducing positions where “anything wins” or where the PV is trivial/noisy.

### Current state

`src/lib/analysis/extractPuzzles.ts` already contains:

-   Eval band filter (`evalBandMinCp`/`evalBandMaxCp`)
-   Tactical requirement gate (`requireTactical`, `tacticalLookaheadPlies`)
-   Opening skip, endgame skip
-   Candidate confirmation hook (`confirmMovetimeMs`)
-   A placeholder for uniqueness (`uniquenessMarginCp`) but it’s not implemented.

### Deliverables

-   Implement `uniquenessMarginCp` using `StockfishClient.analyzeMultiPv`:
    -   At puzzle start, fetch MultiPV 2 (or 3).
    -   Compute cp (or expected-points) margin between #1 and #2 from solver POV.
    -   If margin < threshold, discard OR turn into multi-solution puzzle (see Prompt 4).
-   Add de-duplication across a single game and across games:
    -   Within a game: already has cooldown; improve by also skipping repeated FEN patterns.
    -   Across games: add stable hash key (e.g. normalized FEN without clocks + side-to-move) and avoid creating puzzles already in DB.
-   Add a “non-triviality” gate:
    -   PV length already exists (`minPvMoves`), but also require the first move to be meaningfully forcing (check/capture/promotion) OR the eval swing to exceed a higher threshold.

### Acceptance criteria

-   Fewer puzzles where 5+ moves are equally good.
-   Fewer near-duplicate puzzles across the library.

---

## Prompt 4 — Multi-solution puzzles + “avoid blunder” UX that accepts multiple safe moves

### Goal

Support puzzles where **more than one move is correct**, especially for “avoid blunder” scenarios.

### Motivation

For user blunders, there are often multiple “don’t blunder” moves that are all acceptable. We want a new puzzle subtype/UX:

-   “Avoid the blunder”: accept any move that keeps you above a threshold.

### Required changes

-   **Data model**:
    -   Extend `Puzzle` model to include `acceptedMovesUci: string[]` (or similar) and persist to DB (Prisma migration).
    -   Keep `bestMoveUci` as the primary solution for review arrows.
-   **Extraction**:
    -   For `avoidBlunder` candidates, compute acceptable moves:
        -   Use MultiPV (N=3..5) and accept moves whose eval is within a configured threshold (cp or expected points) of the best.
        -   Alternatively accept moves that keep expected points above X (e.g. >= 0.45) even if not best.
    -   Add settings:
        -   `avoidBlunderAcceptableLossEp` (or `acceptableMarginCp`) and `maxAcceptedMoves`.
-   **Trainer UX** (`PuzzleTrainerV2.tsx` and `PuzzlePanel.tsx` if still used):
    -   Correctness should be `acceptedMovesUci.includes(userMove)`.
    -   If user plays a “safe but not best” move:
        -   Show “Good save” and optionally reveal the best continuation.
-   **Server-side correctness**:
    -   Update `/api/puzzles/[id]/attempt` to compute `wasCorrect` server-side.
        -   Do **not** trust the client-provided boolean.

### Acceptance criteria

-   A puzzle can specify multiple accepted moves.
-   Attempts are graded correctly even if client lies.

---

## Prompt 5 — Lichess-style puzzle motif tagging (classification improvements)

### Goal

Improve `Puzzle.tags` so the library can be filtered by meaningful tactical motifs (fork, pin, skewer, back rank mate, etc.).

### Inputs

-   Reference implementation: `https://github.com/ornicar/lichess-puzzler/tree/master/tagger`
-   Taxonomy: [Lichess training themes](https://lichess.org/training/themes)

### Current state

`extractPuzzles.ts` adds a couple tags (`mateThreat`, `hangingPiece`, opening tags, `avoidBlunder`/`punishBlunder`).

### Deliverables

-   Implement a lightweight tagger that works from:
    -   puzzle start FEN
    -   best line PV UCI (already stored)
    -   chess.js legality + board inspection
-   Start with a pragmatic subset of motifs that are detectable cheaply:
    -   `mate`, `mateInN`, `backRankMate`
    -   `fork`, `pin`, `skewer`
    -   `discoveredAttack`, `discoveredCheck`
    -   `deflection`, `attraction` (approximate)
    -   `sacrifice` (material drop but eval stays high)
    -   `hangingPiece` (already exists)
    -   `check`, `capture`, `promotion`
-   Keep tags stable and low-cardinality; mirror Lichess naming where possible.

### Acceptance criteria

-   Each puzzle gets 0..N motif tags.
-   Tagging is deterministic and does not require additional engine calls (beyond what extractor already did).

---

## Prompt 6 — Make puzzle attempts trustworthy (server-side grading + optional re-eval)

### Goal

Stop trusting client grading and make attempts auditable.

### Current bug

`POST /api/puzzles/[id]/attempt` accepts `wasCorrect` from the client and stores it, which is insecure and causes data quality issues.

### Deliverables

-   Update the attempt endpoint to:
    -   Load puzzle from DB including `bestMoveUci` and (if Prompt 4 is done) `acceptedMovesUci`.
    -   Compute correctness server-side.
    -   Ignore/omit `wasCorrect` from request.
-   (Optional) If accepted moves are not stored, compute correctness by comparing to `bestMoveUci` only.

### Acceptance criteria

-   Attempts are graded the same regardless of client implementation.

---

## Prompt 7 — Add puzzle difficulty estimation + better sampling

### Goal

Make “Random puzzle” feel more like a trainer: balanced difficulty and better progression.

### Deliverables

-   Estimate a puzzle rating using cheap features:
    -   PV length, presence of quiet move, uniqueness margin, mate distance, eval swing, number of accepted moves.
-   Store `estimatedRating` on puzzle.
-   Update `/api/puzzles/random` selection logic to support:
    -   target rating band
    -   spaced repetition weighting (prefer near-misses/failed puzzles)

### Acceptance criteria

-   Users can request “easier/harder” puzzles and it actually changes what they get.

---

## Prompt 8 — Instrumentation: measure puzzle quality + iteration loop

### Goal

Make puzzle generation improvements measurable.

### Deliverables

-   Add metrics collected during extraction:
    -   candidate count, accepted count, rejected-by-reason counts
    -   distribution of swings, uniqueness margins, PV lengths
-   Store summary per analysis run (DB or logs).
-   Add a simple internal dashboard page to visualize these (behind auth).

### Acceptance criteria

-   We can answer “did this change improve puzzles?” with data.

---

## Prompt 9 — Performance & UX improvements for analysis

### Goal

Make analysis faster and less disruptive.

### Ideas

-   Cache Stockfish evals across games by FEN key.
-   Run analysis in a dedicated Web Worker (so UI stays responsive).
-   Support “analyze X games” batch with pause/resume and show ETA.
-   Allow per-time-control defaults (bullet vs rapid have different depth/time).

### Acceptance criteria

-   Background analysis feels stable and predictable for large batches.
