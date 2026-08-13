# Personal Mistake Trainer V2 — Audit Remediation Tracker

Nothing is considered complete until its regression test and integrated
verification gate pass. Checkboxes are intentionally conservative.

## Engine/runtime

- [x] Replace the broken Node `stockfish.wasm` server runtime.
- [x] Prove startup and one real search on the supported production Node 24 runtime.
- [x] Prefer fixed nodes/depth with a wall-clock watchdog.
- [x] Parse exact MultiPV lines coherently and ignore bound-only scores.
- [x] Preserve hash between related scan positions where safe.
- [x] Persist engine/version/network/options/nodes/depth/time provenance.
- [x] Keep browser and server on one compatible engine contract.

## Extraction and verification

- [x] Use explicit cp, mate, and tablebase WDL score semantics.
- [x] Use winning-chance loss as the primary practical signal.
- [x] Preserve mate-in-one and missed mate-in-one.
- [x] Produce one canonical moment per user decision.
- [x] Merge own-mistake and missed-opportunity metadata at that decision.
- [x] Evaluate the user's actual response instead of exact best-move equality.
- [x] Store every stable user loss above the configured threshold.
- [x] Remove tactical, eval-band, PV-length, endgame, cooldown, and quota gates
      as silent reasons to lose otherwise valid moments.
- [x] Confirm both before/after loss and practical alternatives.
- [x] Verify all important solver decisions and best defenses.
- [x] Record explicit continuation termination reasons.
- [x] Handle repetition, stalemate, 50-move, promotion, en passant, and mate.
- [x] Use tablebase evidence for eligible positions.
- [x] Keep lesson/theme tagging separate from chess validity.
- [x] Correct sacrifice/hanging-piece and quiet/defensive theme semantics.
- [x] Rank/feed-sample positions without dropping persisted coverage.

## Identity and persistence

- [x] Persist a stable moment key based on game, PGN hash, and decision ply.
- [x] Remove ephemeral extractor puzzle IDs from persisted analysis JSON.
- [x] Use one DB marker at the actual user decision ply.
- [x] Add immutable solution revisions and a solution hash.
- [x] Pin every attempt to the revision it was graded against.
- [x] Cache precomputed and dynamically evaluated move assessments.
- [x] Preserve historical attempts without reinterpreting their correctness.
- [x] Use immutable enqueue-time configuration and input PGN hash.
- [x] Make `analyzedAt` a completion-only field.
- [x] Invalidate current analysis and moments on PGN change.
- [x] Remove raw/legacy puzzle read and write paths.
- [x] Validate ownership as an API and persistence invariant.

## Queue, concurrency, and credits

- [x] Drain queued work without another user or sync request.
- [x] Give every dispatch generation a unique delivery/idempotency key.
- [x] Fence start, completion, failure, and retry against stale workers.
- [x] Reset manual retry attempt lifecycle.
- [x] Settle run and reserved credit on max-attempt recovery.
- [x] Make product completion and job transition atomic.
- [x] Never swallow consume/release failures; reconcile durable pending
      settlements.
- [x] Block or safely cancel active analysis before game deletion.
- [x] Make queue-disabled behavior truthful and executable.
- [x] Track batches larger than 100 jobs.
- [x] Expose queue age, retry, stale delivery, and credit invariant metrics.

## API and configuration safety

- [x] Bound all extraction/runtime preferences at write and execution time.
- [x] Bound analysis, moment, config, PV, tag, and accepted-move payloads.
- [x] Validate integer/date/FEN/UCI/PGN/line relationships before writes.
- [x] Reject duplicate decision items instead of last-write-wins behavior.
- [x] Ensure malformed payloads cannot archive valid data.
- [x] Ensure imported analysis cannot bypass run completion.
- [x] Ensure browser manual analysis uses the resolved run configuration.

## Unified trainer and grading

- [x] Return a self-contained local grading manifest with each position.
- [x] Always show the same neutral “find the best move” prompt.
- [x] Hide source, lesson, themes, original move, shape, and length until review.
- [x] Grade known moves synchronously in the browser.
- [x] Grade best, good, improved, repeated mistake, and different mistake.
- [x] Treat multiple good moves as a normal solution shape.
- [x] Dynamically grade unknown legal moves with bounded local Stockfish.
- [x] Never show an unresolved move as automatically wrong.
- [x] Support conditional continuations without revealing their length.
- [x] Compare feedback with both the best outcome and the original move.
- [x] Replace extraction-type presets with coverage/sampling/tolerance presets.
- [x] Use Practice/position/Focus as the user-facing language while retaining
      `TrainingMoment` only as the persisted domain name.
- [x] Keep Practice continuous rather than introducing finite sessions, goals,
      rounds, or end summaries.
- [x] Prefetch self-contained cursor pages at a low-water mark with one in-flight
      request, deduplication, filter-reset invalidation, and buffered fallback.

## Tests and rollout

- [x] Add a golden positive/negative training-moment corpus.
- [x] Cover quiet defense, equivalent alternatives, mates, en passant,
      promotion/underpromotion, sacrifice, repetition, stalemate, and
      tablebase.
- [x] Cover queue drain, dedup, fencing, crash boundaries, settlement, delete,
      and retry.
- [x] Cover revision changes and historical attempt preservation.
- [x] Cover spoiler safety and every attempt grade.
- [x] Compare V2 coverage and stability against a representative fixture
      corpus by canonical moment key.
- [x] Run lint, typecheck, full unit/route tests, production build, and browser
      smoke on the integrated branch.
