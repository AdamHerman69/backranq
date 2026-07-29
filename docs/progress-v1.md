# Progress v1

## Product contract

Progress is a decision coach, not an activity dashboard. It answers, in order:

1. Is the selected game sample complete and comparable?
2. Where are costly Positions being found?
3. How do first recorded and full-Position Practice outcomes differ?
4. Which already-seen Positions need another look?
5. What is the single best next action?

The canonical route and product label are `/progress` and **Progress**. There is
no `/stats` or `/insights` compatibility surface.

Progress must not introduce Practice sessions, goals, streaks, ratings, a
composite progress score, peer comparison, or a speed score.

## Time and scope

- Default scope: the last 90 days.
- Alternate scopes: 28 days and all retained data.
- Game-derived metrics use the source game's `playedAt`.
- Practice-derived metrics use the terminal attempt's `completedAt`.
- A finite trend compares the selected window with the immediately preceding
  equal-length half-open window.
- Provider and coarse time-class filters apply to both source-game and joined
  Practice data.

Every response includes an `asOf` timestamp, definition version, filters,
sample sizes, strict analysis coverage, and comparability disclosures.

## Strict analyzed-game validity

A game is analyzed only when it has a current analysis run, that run succeeded,
and the run's input PGN hash matches the game's current source PGN hash. A
successfully analyzed game that produced zero eligible Positions remains in the
analysis denominator.

The same result is persisted as `currentAnalysisValid` for exact Games
filtering. Every PGN mutation path clears it atomically; a database trigger also
clears it whenever the source hash changes or the current run is removed.
Progress still verifies the run and source hash defensively.

## Metric definitions

- **Analysis coverage:** strict analyzed games / imported games in the same
  source-game scope.
- **Games with a Position:** strict analyzed games with at least one current,
  active, unarchived, trainable, verified-or-ambiguous Position / strict
  analyzed games.
- **Positions per analyzed game:** distinct eligible Positions / strict
  analyzed games. This is incidence, not a complete chess error rate.
- **First recorded outcome:** the earliest `GRADED` or `REVEALED` terminal
  attempt per Position. A reveal is its own outcome and is never a solve.
- **Unresolved completions:** reported as a separate count. They are neither
  assessed outcomes nor failures; an unresolved-only cohort has no assessable
  rate.
- **Full-Position solve:** `BEST` or `GOOD` graded attempts / all graded
  attempts. `IMPROVED` is not accepted.
- **Root-decision success:** `BEST` or `GOOD` root user steps / all graded root
  user steps.
- **Original move repeated:** root user steps graded `REPEATED_MISTAKE` / all
  graded root user steps. This means the exact move from the source game, not a
  cross-game pattern.
- **Needs another look:** the latest terminal result for the same solution
  semantics is a reveal or a non-accepted grade.
- **Persistent original repetition:** at least two original-move repetitions
  on the same Position and solution semantics at least 24 hours apart.
- **Observed delayed recheck:** after the first accepted result, take the first
  subsequent terminal result with the same frozen solution and configuration
  semantics; it is an observed delayed recheck only when it occurred 7–30 days
  later. An intervening earlier retry disqualifies that baseline. Report
  observed coverage separately; unobserved rechecks are not failures and this
  is not a retention claim.

Impact uses winning-chance loss when present and centipawns only as a fallback:

- major: at least 12 percentage points, or 150 cp fallback;
- meaningful: 8–under 12 percentage points, or 100–149 cp fallback;
- lower: below those thresholds;
- unknown: neither measure is available.

The two impact scales are never averaged together. Source and future theme
breakdowns are multi-label and therefore must not be rendered as parts of a
single whole.

## Sample and trend guardrails

- Below 10 observations: counts only.
- 10–49 observations: percentage with a 95% Wilson interval and an
  **Early signal** label; no trend arrow.
- At least 50 observations in both equal-length periods: trend eligibility.

An eligible Practice trend is still hidden when the frozen attempt-context
distribution of analysis/grading configuration, provider, time class, source,
phase, or impact changes by more than 15 percentage points. Each dimension is
compared as its own marginal distribution; sparse joint cells cannot conceal a
large provider, time-class, source, phase, or impact shift. Game-analysis
coverage is disclosed separately and does not gate a Practice trend. A visible
trend includes a 95% Newcombe-Wilson interval for the difference of two
independent proportions; an interval containing zero is rendered as no clear
change.

## Spoiler boundary

Before an attempt, a Practice Position continues to reveal only its FEN,
side-to-move, Position ID, and solution-revision ID. A fresh-Position CTA from
Progress is generic and opens a mixed recommendation. It never transmits a
theme, source, phase, impact bucket, original move, expected solution shape, or
other hint.

Progress may deep-link to a specific Position only when that Position has
already had a terminal Practice interaction. The entry surface may be recorded
as `PROGRESS`, but it is not visible as a hint in Practice.

## Data semantics

Practice exposure, attempt lifecycle, review scheduling evidence, and Progress
product interactions are append-only event data. Mutable attempt and review
state is a current projection, not the historical source of truth.

Attempt context freezes the joined game, Position, taxonomy, and analysis
configuration used at the time of the attempt so later reanalysis cannot
rewrite historical breakdowns. Practice history is read from user-owned
terminal Attempts independently of whether the source Position remains in the
current eligible library; only inventory and next-action links require current
eligibility. Inventory uses every same-semantics terminal Attempt for the
currently eligible Positions, even when frozen provider or time-class metadata
differs from corrected current game metadata.

Progress analytics accepts only a bounded scalar vocabulary and at most 60
recorded events per user in each server-clock minute. An atomic, one-row-per-user
database bucket grants an insertion slot, so parallel requests cannot bypass
the cap. Excess events are acknowledged and dropped; client UUID uniqueness
remains an idempotency guard, not the storage-growth control.

Deleting a source game currently deletes its dependent Position and Practice
history. Therefore **All time** means all currently retained data, not an
immutable lifetime record.

The v1 reader fails closed rather than returning partial metrics when a single
snapshot exceeds 25,000 games, 25,000 current Positions, or 100,000 terminal
Attempts. Current observations are bounded to the eight newest records per
Position. A later database-side projection can raise these operational limits
without changing metric definitions.

## Accessibility

Every visualization has a text conclusion, absolute numerator and denominator,
and a semantic list/table equivalent. Meaning is never carried by color or a
hover-only tooltip. The page reflows without horizontal page scrolling at
320 CSS pixels, reports filter updates as status messages, reports failures as
alerts, respects reduced motion, and exposes one dominant next action.
