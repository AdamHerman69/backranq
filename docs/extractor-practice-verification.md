# Extractor / Practice v4 — verification and release record

Status on 2026-09-07: implementation and independent code review are complete.
The application check passed 1,780 tests, lint, types, production build and bundle
budgets. Full DB-backed E2E passed73/5 skipped, offline19/1 skipped; the final
empty-pool correction also passed four actual Practice browser/persistence tests.
The final all-legal and desktop/mobile feedback gates passed. The final migration cleanup regression (3/3), fresh/upgrade migration chain,
RLS/privileges, schema shape, shadow diff, types and focused lint also passed.
No production release has occurred. Earlier failed audits below are historical.

Base: `e3c408a96392448ed41eeca0e43e94df4d0c0a1f` (`main`).
Working branch: `feature/extractor-practice-v4`.
Normative requirements: [target specification](extractor-practice-target-spec.md)
and [implementation plan](extractor-practice-implementation-plan.md).

## Review outcomes

Independent reviews covered engine evidence and chess semantics, immutable
revisions and causal attempts, migration/API/reanalysis, and the browser runtime.
Resolved findings have regressions for:

- Directional counterevidence, stale MultiPV slots and exact/mate reference drift.
- Full-scope confirmation budgets; singleton reference counterevidence invalidates
  every dependent assessment until a supported reference is available again.
- Coverage claims checked against both their cited proof and current evidence.
- Canonical negative reanalysis reaching the same persisted moment, with archived
  feed state, unchanged pinned historical attempts, and zero new Practice count.
- Local RULE terminal grading without unnecessary worker startup.
- Immediate causal invalidation and quality recovery independently of tier;
  both snapshot and completion-only paths stop after supported recovery.
- Continuation review preserving the root decision and its submitted move.
- Invocation-scoped caches keyed by actual request/position/history content;
  changed data cannot reuse an asserted ID as validation authority.

## Verification completed

- Full `pnpm check` on September 7: 1,575 tests passed, 39 explicitly skipped;
  ESLint, TypeScript, production build and all client bundle budgets passed.
  A subsequent narrow completion-only recovery fix passed 18 focused tests and
  independent review, followed by a fresh production build and browser checks.
- Fresh database-backed browser E2E: 73 passed / 5 optional live tests skipped;
  offline production E2E: 19 passed / 1 optional model live test skipped.
  Homepage handoff, terminal RULE grading and both performance tests passed.
  The offline harness binds the configured hostname, avoiding a localhost IPv6
  versus explicit IPv4 URL mismatch in the isolated runner.
- Practice initial JS: 196.4 KiB gzip / 250 KiB budget in that build.
- Real browser Stockfish smoke passed in the September 6 cycle. Compiled Queue
  bundle and actual compiled Queue callback launching Stockfish passed again
  on the September 7 production build.
- Real server/browser parity: five positions including ordinary MultiPV, a
  two-legal-move root, mate and stalemate. No adapter errors; terminal positions
  returned zero roots. This is protocol/behavior evidence, not a latency gate.
- Real FIRST_PUZZLE smoke passed again September 7: two injected unavailable
  full-root confirmations, a later valid moment, and exactly N+1 unique scan
  contexts. Both MISSING_REFERENCE and REFERENCE_DRIFT can trigger the fault.
- Disposable Postgres: fresh migration 47, seeded 46→47 upgrade, schema/shadow
  parity, RLS and ownership, attempt/reanalysis transactions, and the existing
  100k-row Progress performance gate passed. No shared database was changed.
- Production dependency audit passed again September 7, with no known findings.

## Current maturity-policy verification

- Fresh paired-maturity `pnpm check`: 1,607 passed / 39 opt-in skips, 248 test files passed;
  ESLint, TypeScript, build and all bundle budgets passed. Practice is 197.3 KiB
  gzip / 250 KiB. Log `/tmp/backranq-v4-check-paired2.log`.
- Current-policy isolated Postgres producer/reanalysis + causal attempts:
  four tests passed, no skips. Log
  `/tmp/backranq-v4-db/maturity-producer-attempt-db.log`.
- Real browser Stockfish protocol/cancellation smoke, native maintained-runtime
  smoke and FIRST_PUZZLE fault/recovery test passed. Fresh server/browser parity
  passed five positions with zero adapter errors; report
  `artifacts/extraction-quality-lab/practice-v4-final-sept7-runtime-parity/report.json`.
- Targeted fresh-extractor replays corrected three previous false BELOW and four
  previous false GOOD cases with valid runtime patches. Historical comparator
  evidence is labeled as such; this does not replace the new all-legal run.
  One remaining targeted discrepancy (index27/g1f2) was confirmed by a fresh stronger replay; it blocks release until the convergence fix is verified.
- The first maturity capture omitted game0/ply72 as NOT_A_MISTAKE. The later
  paired-maturity producer re-emits it after further confirmation; it is undergoing
  a new targeted replay. The earlier omission is historical, not a current claim.

The first maturity revision still allowed an immature convergence anchor.
A fresh full-root/singleton/root-refresh comparator (5.6M actual nodes) found
index27/g1f2 BELOW_STANDARD: expected-score loss .3685, well beyond .10.
The local false GOOD used depth11/3,187 nodes as its convergence anchor for
depth13/39,528 nodes. A bounded 25/50/100/200/400k ladder withdrew GOOD at the
100k pass and found supported BELOW at the 200k pass. The implemented paired refinement requires both convergence points to meet
actual-node maturity; its exact trace regression now withholds early GOOD and
later returns supported BELOW.

Rebuilt E2E under that first maturity revision passed 72 / skipped 5, with one
real-WASM failure. The same single test failed in isolation. Actual worker
messages prove deterministic MATE starvation: the solved root finishes at
maximum depth245 / 6,373 nodes and Qe7 mate-in-two at depth245 / 736 nodes.
Repeatedly requesting more nodes cannot meet a universal25k floor. A narrow
consistent-MATE convergence rule has been added and independently reviewed; it does not label engine mate
as RULE evidence and does not relax finite CP/WDL thresholds.

The 65-positive / eighteen-perspective capture under the first maturity revision
completed (1,565 searches /243,220,936 requested nodes). It is diagnostic for the
next convergence revision. Its full quality-lab run was stopped before completion;
no all-legal or final latency pass is claimed. The smoke lab completed and remains
an explicitly smaller diagnostic, not a release gate.

## Performance and corpus limits still being verified

The September 7 all-legal run was deliberately stopped after 29 completed
positions / 792 moves: 14 false GOOD and 8 false BELOW_STANDARD against supported
finite-engine comparator results, with 14 runtime UNKNOWN and 123 comparator
UNKNOWN. All patches were structurally valid; no node-budget violations were
observed. These measurements exposed insufficient evidence maturity, not a
passing release gate. Diagnostic rows and all 22 differences are retained in
`artifacts/practice-v4-sept7-alllegal/superseded-discovery.json`.

Two observed causes have been corrected: local singleton searches could stop
after only 10–601 reported nodes, and a retained alternative could use snapshots
4/5/6 although it had disappeared from later completed root bundles 10/11/12.
The current policy requires actual evidence maturity and current membership within
the originating physical search. CP/WDL quality thresholds are unchanged.

A real local-grade CPU profile also found repeated validation of the same PVs
in separate assessment and reference-drift contexts: 5.51 seconds in
`validObservation` within a 6.46-second loaded diagnostic call. Sharing the
context and caching bounded, content-keyed chess facts have been implemented and independently reviewed.
The broader correctness and isolated browser benchmarks must be rerun after
these changes; earlier positive build/E2E results do not supersede this failure.

- Same standalone 29-assessment parse fixture, 5 warmups and 30 samples:
  p50 39.04→17.84 ms; p95 40.46→18.85 ms. Full validation remains enabled.
  This result alone does not establish browser paint improvement.
- Rebuilt browser document paint: p75 304.5 ms / p95 322.1 ms; Home→Practice
  p75 99.9 ms / p95 106 ms. Both existing gates passed. Feed API warm p50/p95
  51.13/60.70 ms. Each warm navigation/API series contains twenty samples.
- The earlier 16-game capture emitted 49 valid positive moments, below the
  60-moment target. Fresh `practice-v4-sept7-extraction` reached exactly 60 valid
  moments after eighteen player perspectives across the original sixteen games.
  PGNs, IDs and engine budgets remain unchanged; both perspectives are labeled,
  deduplicated by actual position context, and source-hashed. Work totals:
  1,518 physical searches / 228,500,632 requested nodes; optional coverage used
  1,000,632 nodes. This capture alone does not prove every move's quality.
- Earlier direct-position/all-legal and one-position browser measurements are
  discovery results. They do not substitute for the final stratified corpus.
- Correctness audits may run beside builds and are reported by physical work.
  Browser latency runs must exclude task-owned competing engine/build workloads.
  A pre-existing unrelated local Next server is recorded as ambient load.
- Browser benchmark semantics and CDP emulation limitations are documented in
  [Practice feedback benchmark](practice-feedback-benchmark.md).

## Asymmetric convergence revision — verification in progress

The current policy is `practice-v4-2026-09-07-asymmetric`: finite CP/WDL
support needs an earlier point with at least 25,000 actual nodes and a latest
point with at least 100,000, checked against both observation and physical
search counters. The narrow consistent-MATE exception remains. Local scheduling
starts at 100k and doubles to 200k/400k within the existing cumulative limit.
Quality thresholds and confirmation profiles have not changed.

Fresh first-choice traces exposed false GOOD under the preceding policy for
d2b1 and d2f1. The actual evidence is retained as regression fixtures; the
current policy withholds those early conclusions and accepts later supported
BELOW_STANDARD. Independent policy/scheduler reviews are clean. This fixes
the recorded failures without claiming a universal guarantee against deeper
tactical discoveries. Empirical score intervals are not certified error bars.

The prior paired all-legal run was stopped at 27 positions / 824 moves after
discovering that its local engine retained TT across hypothetical answers.
Its one false GOOD, zero false BELOW, 52 runtime UNKNOWN and 129 comparator
UNKNOWN remain diagnostic. Harness v6 now uses a fresh initialized engine and
evidence session for each hypothetical answer, records startup separately and
includes final patch validation in resolution time. Unsupported comparator
references cannot supply finite classification ground.

The completed paired quality lab emitted 57 product and 53 stronger-profile
moments, with 49 shared. Three product-only decisions had explicit stronger
ORIGINAL_MOVE_QUALITY_CONFIRMED receipts (0f8e42f0 ply42, 591205b6 ply74,
Kqm8tLd3 ply35). Those are substantive finite-engine conflicts, not just tier
differences or scan omissions. Current capture and full quality comparison
are rerunning; these historical conflicts are not reported as passing gates.

Current completed checks:

- `pnpm check`: 1,628 tests passed in 250 files; 39 opt-in tests skipped.
  Lint, typecheck, production build and all client bundle budgets passed.
  Practice is 197.3 KiB gzip against 250 KiB. Log:
  `/tmp/backranq-v4-check-asymmetric2.log`.
- Current producer/reanalysis and attempt PostgreSQL integration: 4/4 passed
  against the isolated loopback database. Log:
  `/tmp/backranq-v4-db/asymmetric-producer-attempt.log`.
- Optional coverage skips an incapable CP/WDL allowance, retains its MATE
  exception and existing hard cap. Three regression tests and independent CR
  passed. Known/root projection still perform no extra engine search.

- Rebuilt DB-backed E2E: 73 passed, five optional scenarios skipped; offline:
  19 passed, one optional scenario skipped. Logs:
  `/tmp/backranq-v4-db/e2e-asymmetric.log` and
  `/tmp/backranq-v4-db/e2e-offline-asymmetric.log`.
- Real FIRST_PUZZLE fallback: 1/1 passed. Compiled Queue bundle and actual
  compiled callback/Stockfish loopback smoke passed. Logs:
  `/tmp/backranq-v4-first-asymmetric.log`, `/tmp/backranq-v4-queue-asymmetric.log`,
  `/tmp/backranq-v4-queue-callback-asymmetric.log`.
- Fresh producer capture completed with 66 valid trainable moments from eighteen
  labeled player perspectives. Exact paid manifests were imported into the v6
  all-legal audit unchanged, with ten additional curated RULE edge positions.
  All 76 imported/curated manifests passed source/hash/contract validation.

The current full all-legal and quality comparisons are running; isolated browser
latency remains pending. A bounded fresh-engine adjudication of Kqm8tLd3 ply35
used four searches / 4.8M requested nodes. The reference is supported GOOD with
no drift; the original remains UNKNOWN because its evidence interval crosses
the quality boundary. This neither confirms nor erases the earlier stronger
whole-game GOOD discrepancy. Full paid and comparator evidence is retained in
`artifacts/practice-v4-asymmetric-adjudication/`. No release has been performed.

## Production target and cutover

Read-only verification on September 7 confirmed:

- Vercel project `prj_wUNzEYWPsn8hF2SoYkAF9D3WQr1r`, configured production branch
  `main`, current deployment `dpl_3caVXoQeRoqQXDVGtL38HPNfxUdL`, source commit
  `e3c408a96392448ed41eeca0e43e94df4d0c0a1f`.
- Supabase project `ftjblndngplzagbjmxsh`: 46 completed Prisma migrations,
  zero active analysis jobs, one source game and eleven old Practice moments.
  Every completed migration checksum matches local SQL; two historical
  rolled-back attempts are recorded separately. Only migration 47 is pending.

Migration 47 replaces the incompatible training/publication graph and derived
game projections, stops incompatible jobs/checkpoints and settles reservations.
It preserves source games and unrelated records without introducing legacy
readers or backfills. This migration has only been executed against disposable
local databases. Final migration/application cutover, main SHA, deployed SHA
and production health checks must be appended after they actually complete.

## Completed asymmetric audit and corroboration correction

The v6 asymmetric all-legal run completed: 76 positions / 2,395 legal moves;
333 immediate answers, 125 runtime UNKNOWN, 308 comparator UNKNOWN and 2,062
mutually resolved comparisons. There were two false GOOD and four false BELOW
results, zero invalid patches and zero known-answer search or requested-node
budget violations. Five errors occurred during local evaluation; a5c7 at index49
was already precomputed. Raw reports in `practice-v4-asymmetric-alllegal` are
retained unchanged. This was a failed accuracy gate, not a release result.

The complete quality lab found 51 product / 53 strong-reference moments across
16 unchanged PGNs, with 47 shared, four product-only and six reference-only.
Three product-only confirmations remained unresolved under the strong profile;
Kqm8tLd3 ply35 instead had strong ORIGINAL_MOVE_QUALITY_CONFIRMED and remains
an explicit selection regression to check in the new producer run.

The correction requires two latest consecutive completed physical search groups
for finite non-self quality. Each independently supports the same quality against
the current reference; an intervening contradictory/incomplete/immature group
cannot be skipped. MATE, RULE and reference-self exceptions remain. These are
corroborating measurements, not statistically independent samples. Historical
offline reprojection withdraws all six errors, but its 340 supported / 2,055
UNKNOWN outcomes do not estimate the new runtime because most old searches
stopped before a second physical group. Fresh runtime evidence is required.

Server/browser compute identity now contains pinned JS/WASM artifact hashes,
NNUE and options, separately from provenance. Identical runtimes reuse paid
references; incompatible artifacts/options do not. Mixed personal evidence is
CLIENT_ENGINE. A separate merge bug is fixed: canonical physical-search sequence
is immutable regardless of JSON dictionary key order. New incoming groups append
in explicit sequence order. Independent CR of both changes is clean.

Current corroborated verification:

- `pnpm check`: 1,674 passed, 39 opt-in skipped; 255 test files passed. Lint,
  TypeScript, production build and bundle gates passed. Practice 198.1 KiB gzip
  against 250 KiB. Log `/tmp/backranq-v4-corroborated-check2.log`.
- A later test-only clarification confirms optional CP coverage retains a paid
  anchor but cannot immediately classify an unseen move: three tests passed.
  Log `/tmp/backranq-v4-corroborated-coverage-test2.log`.
- Two isolated PostgreSQL producer/attempt suites: four tests passed. Log
  `/tmp/backranq-v4-db/corroborated-producer-attempt.log`.
- Actual FIRST_PUZZLE fallback: one test passed, preserving exactly N+1 scan
  contexts. Log `/tmp/backranq-v4-corroborated-first.log`.
- Real native/browser parity completed for all five positions without adapter
  errors, including zero-work checkmate/stalemate. Report
  `artifacts/extraction-quality-lab/practice-v4-corroborated-parity/report.json`.
- New producer capture and DB E2E are still running. New all-legal v7 comparator
  uses its own 800k + 1.6M singleton searches for EVERY legal move. Current
  browser latency and full accuracy gates remain pending. No release yet.

- Current DB-backed E2E completed: 73 passed / five optional skips. Offline
  completed: 19 passed / one optional skip. Logs
  `/tmp/backranq-v4-db/e2e-corroborated.log` and
  `/tmp/backranq-v4-db/e2e-offline-corroborated3.log`. The first offline run
  was stopped after its mocked engine omitted mandatory artifactId; the next
  exposed a Playwright JSON-module loader issue. The test fixture now reads
  canonical artifact pins through fs; no production change or timeout increase.
  Preserved original trace: `artifacts/practice-v4-corroborated-offline-diagnostic/`.
- Compiled Queue bundle and callback/real Stockfish loopback passed. Logs
  `/tmp/backranq-v4-corroborated-queue-{bundle,callback}.log`. Real browser
  protocol, MultiPV and cancellation smoke passed again, log
  `/tmp/backranq-v4-corroborated-browser-smoke.log`.
- Fresh producer capture completed: 63 trainable moments, all source/hash/schema
  valid. Fingerprint `ebf1fbd933df2c052fe19b5179c5256f666673cebba9521ba28cbc97b4534c13`.
  The first same sixteen perspectives produced 48 moments / 272.7M requested
  nodes / 1,444 physical searches, versus 51 / 203.1M / 1,288 previously.
  This is a 34.3% increase in requested work; it must be weighed alongside
  measured accuracy and actual browser feedback latency.
- Kqm8tLd3 ply35 now remains UNRESOLVED and is omitted, with its final loss
  0cp / 0 expected score; it is not falsely called a confirmed mistake.
  Prior failed context64 (f7f6/h7h6) is also omitted as unresolved by the new
  producer. The other four previously wrong moves remain in emitted contexts
  and will receive new runtime/strong comparator measurements.
- All 73 audit inputs (63 emitted + ten curated RULE) validated for v7.
  Complete all-legal comparison and whole-game stronger-profile comparison
  remain running. Browser latency remains pending until engine work finishes.

### Completed corroborated v7 baseline; reference implementation started

- All three audit ranges exited0. Final report at2026-09-07T13:07:10Z:
  artifacts/practice-v4-corroborated-alllegal/comparison-summary.json.
  Fingerprint f6720cc89b21e2ed8141a2e659d25b171f1ca2f4a1fc813cb7925a970e5ec913.
- 73positions /2,341legal moves,63actual emitted moments +10RULE. 179immediate;
  219runtimeUNKNOWN,350comparatorUNKNOWN,1,922mutuallyresolved.
  2falseGOOD +8falseBELOW across11/16/20/59, noadditional late failures.
  Zero invalidpatches, knownsearchviolations and requestednodebudgetviolations.
- Strict categories: narrow6,broad20,boundary42,tactical26,saturated10,exactRule10.
  The ten-per-stratum gate is INCOMPLETE. Native loaded timings are diagnostic
  only; isolated browser paint/mobile measurement remains unrun.
- Source freeze released after the final run completed. V4 now owns shared
  reference readiness/policy/schema/fixture/spec; engine_pool owns local planner;
  integrate_core owns bounded extractor scheduling. No external release writes.

## Verified-reference verification (current source, in progress)

The canonical check passed1,722tests with39opt-in skips, lint, typecheck, build
and bundle budgets (`/tmp/backranq-v4-verified-reference-check2.log`). The later
presentation-only root-score projection passed49affected tests and lint.

Targeted whole-game capture emitted16valid moments from four perspectives
(previously21), using131.6Mrequested nodes (previously99.9M). This is a measurable
31.7%requested-node increase in that targeted sample, not a full-corpus estimate.
Case11 is now positively classified NOT_A_MISTAKE. The other formerly disputed
contexts still need a fresh alllegal runtime comparison.

The case16 adjudication stayed UNKNOWN after43.2Mtotal requested nodes across
explicitly separate sessions. Its reference changed materially between root and
focused searches; neither the old comparator GOOD nor producer BELOW is proven
by this diagnostic. See `artifacts/practice-v4-reference-adjudication/README.md`.
The final actual-producer, current-reference comparator and browser latency
verification are in progress/unrun; no release has occurred.

## Completed verified-reference baseline and final correction

The full frozen baseline check passed 1,746 tests (39 opt-in skips), lint,
types, production build and bundle budgets. DB-backed E2E passed 73/5 skipped;
offline E2E 19/1 skipped; actual producer/causal-attempt PostgreSQL 4/4, real
FIRST 1/1, real browser engine protocol/cancellation and compiled Queue callback
checks passed. No production changes have been made.

The completed v8 all-legal audit contains 83 positions / 2,295 legal moves:
63 actual emitted moments, ten RULE cases and ten additional real source
positions. It found zero supported disagreements, invalid patches, known-answer
searches or requested-node budget violations. Both sides resolved 1,773 rows;
runtime UNKNOWN 205, comparator UNKNOWN 469. These unknowns remain outside the
accuracy denominator. Categories: narrow 9, broad 20, boundary 42, tactical 33,
saturated 17, exact RULE 10. The ten-per-category gate is still incomplete.
Evidence: `artifacts/practice-v4-verified-alllegal/comparison-summary.json`,
fingerprint `b4486dbbbb1f125d5adb675a5eee67d9fcd7f8e09c4e1bbf8eed00db675b49c6`.

Whole-game quality comparison completed both 16/16 profiles: 40 product and
46 reference moments, 37 shared (36 compatible, one UNKNOWN, zero incompatible).
All twelve one-profile-only cases are unresolved in the other profile; none
positively contradicts the decision. Report: `artifacts/extraction-quality-lab/
practice-v4-verified-quality/full.json`.

One subsequent narrow correction retires an unbounded intermediate counter only
when its own completed physical search withdrew it from the latest valid bundle.
It preserves bounds, unfinished searches and earlier stronger singleton evidence.
Eight regression cases include an unchanged five-search subset of actual index30;
44 affected policy tests passed. Indices13/38 remain honest reference uncertainty.
The next canonical check passed 1,776 tests /39 skips, lint, types, build and bundle
budgets (`/tmp/backranq-v4-release-check.log`). A later cache protocol regression
passed separately (five tests). Final new producer/runtime comparison, isolated
browser latency and the local review-score display correction are in progress.

Final source checks: `/tmp/backranq-v4-final-check-stable.log`,
`/tmp/backranq-v4-db/e2e-final.log`,
`/tmp/backranq-v4-db/e2e-offline-final.log`. The migration timeout regression
once failed to start its Node grandchild before the unchanged one-second deadline
under load. Its fixture now uses a separate shell grandchild that installs SIGTERM
ignore and publishes its PID using builtins; actual group SIGKILL/dead-PID checks
remain unchanged. Independent test-only review and the full canonical rerun passed.

Final producer emitted 66 valid moments from 21 perspectives. The same first
sixteen perspectives yield 42 moments /348.5M requested nodes, versus 40/342.5M
in the verified-reference baseline. No search budget was increased for the final
stale-counter correction. The subsequent presentation-only helper generalization
has byte-identical producer bundle contents outside its function block and pure
output parity on all 66 manifests (`practice-v4-final-extraction/bundle-provenance`).

Final all-legal capture: 96 valid inputs =66 extractor moments +20 real-source
positions +10 curated RULE cases. Fingerprint
`a883523083276d5f8957156a6cbbf2f4fa5e1ffc134cb9b16b9e303131097b26`.
Four one-legal-move controls are excluded from the strict narrow quota.

## Final v9 all-legal result

All 96 positions /2,419 legal moves completed. There are 1,965 mutually resolved
comparisons, zero false GOOD, zero false BELOW_STANDARD, zero diagnostic
disagreements, zero invalid patches and zero requested-budget or known-search
violations. Runtime UNKNOWN:219; stronger comparator UNKNOWN:394. Unknowns are
not counted as correct answers. Strict strata passed: narrow14, broad20,
boundary46, tactical37, saturated24 and exact RULE10. Four forced one-legal-move
controls do not count as narrow positions.

The stronger reference reused complete raw evidence in 81 positions, ran fresh
bounded fallbacks for two unready cached references and fresh searches for
thirteen new source contexts. This cost 444 new physical searches /573.6M new
requested nodes, separately from 5.6B previously requested nodes retained in
the reused evidence. Every actual producer and runtime answer was newly run.
This is current-policy reprojection of paid stronger evidence, not a second
independent engine replication.

Evidence: `artifacts/practice-v4-final-alllegal/comparison-summary.json`. The
native artifact deliberately leaves browser paint/mobile as NOT_MEASURED; those
measurements belong to `artifacts/practice-v4-final-browser/report.json`.

Desktop browser completed 96 positions /802 selected answers. Harness paint
p50/p95:11.7/46.1ms; warm unknown supported feedback:602.6/1662.6ms (524 answers);
cold startup:138.8/148.9ms. Final UNKNOWN:61; timeouts, startup failures and
invalid patches:0. Artifact-only join to the stronger native reference found
zero initial, first-supported or final disagreements, with respectively
196/653/652 mutually resolved comparisons. The final verdict denominator differs
from the first-supported denominator when later evidence withdraws support.
This is a minimal DOM paint harness, not full React input-to-photon timing.
All owned heavy work was stopped; an unrelated existing next-server process
remained active and was not terminated. Full React flow timings are recorded
separately in the E2E evidence. Mobile CDP CPU4 is still in progress.

## Empty-pool first-response correction

The first mobile CPU4 run was stopped after24/96 positions because first-known
lookups exceeded the100ms paint target: an empty `PositionAnalysisPool.find`
normalized and replayed full position history before returning no matches.
The same call preceded React feedback updates, so this was real application
work, not a measurement boundary error. One early empty-map return removes it;
no verdict, threshold, budget, evidence or populated-pool behavior changed.
The regression verifies zero replay for an empty pool, then unchanged malformed
history rejection and retained contradictory evidence after the pool is populated.
Focused16/16 and independent root review passed.

Reconstructing the pre-fix source by removing only that three-line block exactly
reproduces the completed all-legal audit's entire recursive code fingerprint.
See `artifacts/practice-v4-release/empty-pool-audit-provenance.json`. The native
correctness/producer audit remains evidence for unchanged grading semantics; it
is not represented as a fresh run of the optimized source. Full canonical checks
and the isolated desktop/mobile benchmark are repeated for the actual final code.
The original desktop96/mobile24 report and accuracy join are retained with
`before-empty-pool-fix` filenames, including the failed mobile performance result.

## Final browser feedback gates

Both desktop and mobile CDP CPU4 completed all96 positions /802 selected answers.
The executable final gate check passed; raw reports, exact native-ground joins
and denominators are in `artifacts/practice-v4-release/final-gates.json`.

| Measurement | Desktop | Mobile CDP CPU4 |
|---|---:|---:|
| Immediate harness paint p50/p95 |10.5/16.7ms|10.9/16.9ms|
| Warm unknown first supported p50/p95 (524 answers) |608.1/1664.2ms|1116.3/2282.0ms|
| Cold startup p50/p95 (590 workers) |137.5/147.0ms|141.9/152.3ms|
| Final UNKNOWN |61/802|61/802|
| Bounded timeouts |0|1|
| Errors /invalid patches |0/0|0/0|

Each mode has196 initial,653 first-supported and652 final mutually resolved
comparisons with the stronger reference, all with zero disagreements. The one
mobile8s timeout remained UNKNOWN, not an incorrect verdict. These are selected
hypothetical answers, not measured frequencies of future users' played moves.
CPU throttling does not establish physical-mobile performance or first-download
network cost; the minimal DOM paint measurement is separate from React E2E.

The final migration additionally resets MasterPipelineRun after its derived
candidates/receipts. Otherwise an old completed daily key would prevent same-day
rebuilding, and obsolete queued work could block fresh pipeline runs. Source
snapshots retain their content and current-source pointer; only the removed
pipeline relation becomes null. A PostgreSQL regression verifies both old-run
removal and same-day creation using the real current pipeline configuration.

Final migration gates: `/tmp/backranq-v4-db/release-migration-gates-final.log`.
The upgrade retained nine source/account table inventories (snapshot pipeline
lineage deliberately detached) and reset ten derived tables. An earlier inventory
assertion expected MasterPipelineRun to be preserved; it was updated to assert
the newly intended reset, with explicit source-snapshot lineage checks, and the
entire fresh/upgrade sequence was rerun successfully. Final migration SHA256:
`0f69031a399c7927e02a22dbe1c80fa253bee2052dd726befa0dfd92d5d8193d`.
Application check: `/tmp/backranq-v4-empty-pool-check.log`; focused post-fix
Practice E2E:`/tmp/backranq-v4-db/e2e-empty-pool.log`; latest types/lint:
`/tmp/backranq-v4-release-types.log`, `/tmp/backranq-v4-release-migration-lint.log`.
