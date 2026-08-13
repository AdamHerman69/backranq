# Personal Mistake Trainer V2

Status: implementation charter

## Mission

Backranq turns practically every verified mistake or missed opportunity from a
player's own games into a fair, personalized, repeatable practice position.

Practice presents every position with the same neutral prompt:

> You are to move. Play the best move you can find.

Before the attempt, the UI must not reveal whether the player is:

- avoiding their own blunder;
- punishing an opponent's mistake;
- finding a quiet or defensive move;
- saving a draw;
- converting an advantage;
- solving a unique or multi-solution position.

The source, lesson, themes, original move, and explanation are revealed only
after the attempt.

## Product contract

1. **Coverage:** every legal, decisionful, stable mistake above the configured
   threshold becomes a saved practice position. Multiple good moves, quiet
   moves, and non-tactical positions are not rejection reasons.
2. **Correctness:** a mistake claim has reproducible engine evidence with an
   explicit point of view, score type, configuration, engine identity, and
   verification status.
3. **Fairness:** the player is not required to guess the exact engine
   `bestmove`. Every move that meets the practical outcome tolerance is
   accepted.
4. **Unified experience:** all positions share the same board flow. Differences
   in solution shape and grading are internal properties, not user-visible
   exercise modes.
5. **Personalization:** source kind, lesson, themes, severity, confidence, and
   attempt history remain available for scheduling, explanations, filters, and
   learning analytics.

## Domain language

### Practice position (`TrainingMoment`)

The user-facing name is **position**. `TrainingMoment` remains the persisted
domain entity: an immutable source-game decision point containing:

- the position before the player's decision;
- the original played move;
- evaluation before and after that move;
- the measured loss in centipawns and winning chances;
- source kind (`MY_MISTAKE` or `MISSED_OPPORTUNITY`);
- lesson and themes;
- verification evidence and confidence;
- the analysis run and generator configuration that produced it.

### Solution revision

A versioned solution contract for a saved position:

- canonical best move and principal continuation;
- known practically accepted alternatives;
- target outcome and grading tolerances;
- solution shape (`UNIQUE`, `MULTIPLE`, or `OPEN`);
- grading strategy (`PRECOMPUTED`, `OUTCOME_TOLERANCE`, or `DYNAMIC`);
- continuation shape (`SINGLE_DECISION` or `CONDITIONAL_LINE`);
- verification and termination reason;
- a stable solution hash.

Attempts belong to a solution revision. Reanalysis may reuse a revision only
when the solution hash is unchanged.

### Attempt evaluation

An attempt is graded by outcome, not only by UCI equality. The result can be:

- `BEST`: materially equivalent to the best known result;
- `GOOD`: the training objective was met;
- `IMPROVED`: better than the original move, but still inaccurate;
- `REPEATED_MISTAKE`: the original problem remains;
- `DIFFERENT_MISTAKE`: the original problem was avoided but another serious
  error was introduced.

`SKIPPED` and `REVEALED` are attempt lifecycle statuses, not grades.

Known alternatives are graded immediately in the browser. A legal move outside
the precomputed set is evaluated by local Stockfish before it is rejected.
Attempt persistence and analytics are asynchronous and never block feedback or
the next position.

## Extraction contract

Extraction is a two-stage pipeline:

1. A bounded, reproducible game scan records every qualifying decision loss.
2. A deeper candidate verifier produces solution evidence, alternatives,
   continuations, confidence, and termination reason.

The verifier validates chess truth; it must not impose a universal tactical,
capture, or check requirement. Quiet and defensive lessons remain first-class.

Scores use an explicit union:

- centipawn score;
- mate score;
- tablebase WDL result.

Mate is never encoded as an arbitrary centipawn sentinel for filtering.
Winning-chance loss is the primary practical severity signal; centipawn loss
remains evidence and may be used by configured policies.

## Configuration boundaries

Extraction and practice-feed selection are deliberately separate:

- analysis persists every confirmed decision loss above the configured
  coverage threshold; it never drops a valid position to make the current feed
  shorter;
- source kind, phase, theme, recency, severity, confidence, and attempt history
  are feed filters or scheduling signals;
- selecting only own mistakes or only missed opportunities changes what is
  practised now, not what was extracted and retained;
- grading tolerance changes a versioned solution revision, so historical
  attempts keep the policy under which they were graded;
- engine nodes, watchdogs, MultiPV width, verification depth, and tablebase
  policy are bounded analysis-quality settings, not user-facing exercise
  types.

The clean user-facing controls are therefore based on intent:

- coverage threshold (from nearly every confirmed inaccuracy to only larger
  losses);
- what to practise now;
- practical grading tolerance;
- analysis quality/cost where server credits matter.

The public quality contract has two profiles. Standard costs 7 server credits
and uses an 800k-node adaptive confirmation ceiling. Thorough is recommended,
costs 10 credits, and raises that ceiling to 1.6m nodes. Both use deterministic
node budgets; browser execution is free. Raw engine budgets are internal and
are never persisted as user preferences.

There is no extraction-type switch, tactical-only requirement, per-game puzzle
quota, opening skip, eval band, minimum PV length, endgame exclusion, or
cooldown. Those controls either silently lost training data or exposed
implementation details instead of user intent.

## Non-negotiable audit invariants

### Engine and verification

- The server engine starts on the supported production Node 24 runtime.
- Search uses fixed nodes with bounded depth/time safety limits.
- Browser and server implement the same analysis contract.
- Engine name, version, source, network hash, options, nodes, depth, and
  generator version are persisted when available.
- Mate-in-one and missed mate-in-one survive candidate validation.
- Confirmation rechecks the before/after result and alternatives, not just the
  root best move.
- `MISSED_OPPORTUNITY` evaluates the user's actual response; it never relies on
  exact equality with the engine's first move.
- Solver continuations use best defense, legal-line validation, repetition and
  terminal-state handling, and explicit stop reasons.
- Positions eligible for tablebase verification are not globally discarded as
  trivial endgames.

### Data and APIs

- A source-game decision has exactly one canonical moment identity. Own-mistake
  and missed-opportunity findings merge into metadata on that moment.
- Temporary extractor IDs never become persistent foreign references.
- `analyzedAt` has a single writer: successful product-level completion.
- The enqueue-time configuration is immutable for the run.
- A PGN mutation invalidates dependent current analysis state.
- Payloads have shape, size, integer, date, FEN, UCI, and legal-line bounds
  before any replacement or archival write.
- Legacy raw puzzle writes cannot bypass the validated completion contract.

### Jobs, credits, and concurrency

- The queue drains without another user request.
- Retry delivery identity includes run and dispatch generation.
- A claim has a fencing token; a stale worker cannot complete or overwrite a
  newer claim.
- Success atomically settles game analysis, moments, solution revisions, run,
  job, and credit, or uses an explicit durable outbox/reconciler.
- Terminal failure, cancellation, deletion, and max-attempt recovery settle
  both run and credit.
- Credit settlement failures are never swallowed.
- Manual retry starts a new bounded attempt lifecycle.
- Queue-disabled behavior either runs a real fallback worker or reports that
  server execution is unavailable.

### Practice

- The prompt is neutral and identical for every position.
- Lesson, source, themes, and original move stay hidden until the attempt.
- Multiple acceptable moves are normal, not a separate mode.
- Unknown legal moves can be dynamically evaluated when enabled.
- Continuation length is not disclosed in advance.
- Feedback compares the new move with both the best outcome and the original
  mistake.

### Local practice boundary

Each fetched position is self-contained: it includes the pinned solution
revision, grading policy, known move assessments, continuation tree, original
decision evidence, and review metadata. The interface still presents the same
neutral prompt and withholds explanation/review UI until the player moves or
reveals, but inspecting one's own downloaded practice data is not treated as a
security threat.

Known moves, including the original game move, are graded synchronously without
a request. An otherwise unknown legal move is evaluated by the browser
Stockfish worker using the pinned policy. Missing, timed-out, or unstable local
evidence produces `UNRESOLVED`, never an automatic wrong answer. Conditional
continuations advance from the downloaded tree and never display the remaining
line length.

After a terminal grade or reveal, the client sends an idempotent record-only
write in the background. The server validates ownership, revision, line
legality, and payload consistency, but does not re-grade or run an engine.
Offline writes queue as history synchronization and never block solving.

### Practice feed

- Practice is continuous: there are no implicit goals, rounds, summaries, or
  finite sessions.
- The client keeps a self-contained position buffer and proactively fetches
  the next cursor page at a low-water mark.
- Only one page request may be in flight. Position identity is deduplicated by
  moment ID plus pinned solution revision.
- Changing Focus aborts or invalidates older requests so results from different
  filters cannot mix.
- A failed prefetch never discards positions already in the buffer. Exhaustion
  is presented as being caught up, not as completing a session.

## Verification gates

Implementation is not complete until the integrated branch has:

- engine startup smoke tests on supported Node runtimes;
- golden positive and negative extraction fixtures covering mate-in-one,
  equivalent moves, quiet defense, en passant, promotion, repetition,
  stalemate, and tablebase behavior;
- queue drain, retry generation, fencing, recovery, credit settlement, and
  crash-boundary tests;
- solution revision tests proving that changed solutions do not reinterpret
  historical attempts;
- payload tests proving malformed replacement cannot archive valid data;
- trainer tests for best, equivalent, improving, repeated-mistake, and
  different-mistake outcomes;
- passing lint, typecheck, unit/route tests, production build, and relevant
  browser smoke.

## Clean replacement

There are no production users and no backward-compatibility requirement. V2 is
the sole domain model, not an adapter around the old puzzle model:

- `TrainingMoment`, `SolutionRevision`, move assessments, and revision-pinned
  attempts are the canonical persisted entities;
- legacy puzzle write/read contracts, compatibility fields, dual-write paths,
  and old client-side correctness logic are removed rather than preserved;
- the schema may use a clean baseline migration and the development database
  may be rebuilt instead of backfilling unused data;
- historical compatibility is never allowed to weaken identity, provenance,
  spoiler safety, grading, or transaction boundaries.

Before replacement is accepted, V2 is still compared against a representative
fixture corpus for coverage, stability, and extraction cost. This is a quality
gate, not a production shadow-mode or migration requirement.
