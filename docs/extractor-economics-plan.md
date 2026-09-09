# Extractor economics: implementation and decision plan

> Historical proposal. The next experiment is now specified in
> [extractor-parameter-study.md](extractor-parameter-study.md) and
> [study.json](../experiments/extractor-economics/study.json). In particular,
> background server cost is the primary objective; no preliminary review UI is
> required. Admission and answer grading are separate experimental policies.
> The older staged A/B prerequisites and run counts below are not the current
> execution plan. Nothing in either document starts or authorizes a benchmark.

Status: proposed implementation plan; no runtime, defaults or production changes.
This supplements the existing Practice target contract and implementation plan;
it changes compute allocation and, conditionally, support policy rather than
reopening the completed v4 architecture.
Baseline: main `ea127c3f9e461297820c56dc070e4815a43b4bff`.

## Objective and decisions

Optimize ordinary local/server analysis for useful practice moments per unit of
compute. Landing is lower priority and needs one useful moment. Its current speed
is acceptable to the user; modest selection-quality loss for lower latency is
acceptable. Preserve one extractor and one definition of move quality.

Implement cost allocation first while keeping current assessment requirements.
Relax assessment support only in a separate experiment if cost allocation alone
does not meet the acceptance gates. Do not automatically implement every
experiment, combine unmeasured changes, or tune until the audit has zero errors.

Success is not exhaustive discovery of every mistake. Report what was scanned,
what was assessed, what was omitted by policy, and what remained uncertain.
Historical reanalysis needs its own explicit outcome: skipping a candidate never
proves that a previously stored mistake was good and never deletes that moment.

## Evidence and current costs

`artifacts/extractor-usecase-review/cost-breakdown.json` derives costs from the
final STANDARD capture: 21 player perspectives, 66 emitted moments, 543.3M
requested nodes. Perspectives are not necessarily independent games.

- Scan: 130.8M /24.08%.
- Confirmation of emitted moments: 95.8M /17.63%.
- Confirmation ending with original GOOD: 113.4M /20.87%.
- Confirmation ending unresolved: 187.2M /34.46%.
- Confirmed mistakes without selection signal: 15.6M /2.87%.
- Optional answer coverage: 0.5M /0.09%.

58.2% of all requested nodes went to confirmation of non-emitted candidates.
This is an optimization target, not a claim that all this work is removable.
The latest capture uses STANDARD, whereas the default preference is THOROUGH.
No current matched STANDARD/THOROUGH cost-benefit comparison establishes that
THOROUGH should be the default. Server credits are product units, not measured
cloud costs; changing this plan's compute profile does not change prices.

Current budgets (nodes): landing scan12k, confirmation ladder180k/360k/500k;
STANDARD scan100k, ladder200k/400k/800k; THOROUGH scan100k,
ladder200k/400k/800k/1600k. The current candidate reservation ceiling is twice
the sum of its ladder, not the largest single search: respectively2.08M,2.8M,6M.
Full-root reference support normally also requires a400k focused search.
The engine retains its transposition table between related searches: separate
search IDs are not statistically independent engine replications.

## Update: isolate the second-search requirement before the larger refactor

The confirmation-value review now adds a cheaper first live experiment. Offline
prefix replay of96 retained positions (86 finite,10 exact skipped) reconstructed
all66 emitted baseline decisions. Requiring one rather than two completed
supporting groups, while preserving the400k reference check and other current
checks, resolved62/85 positions earlier with identical decision statuses. All73
mutually resolved comparisons against the stored stronger comparator agreed.
This is a selected-success trace replay, not a representative false-admission
rate or fresh-engine cost benchmark. No rejected-candidate population was added.

Before implementing the two-phase checkpoint/profile refactor, run the frozen
12-game development comparison of current STANDARD vs a single-factor policy
with minimumCompletedSupportingSearches=1. Keep400k reference probing, margins,
scan, all budgets, candidate selection, runtime and every other rule unchanged.
Capture every candidate, including rejected and unresolved ones. Inspect earlier
correct answers, earlier wrong answers, new admissions, dropped moments and work
spent after the first decisive comparison. Compare against retained/fresh bounded
stronger evidence. Charge matching baseline runs to the experiment matrix once,
reuse them if source/runtime/options are unchanged, and document any additional
candidate run rather than silently expanding the budget.

Promising results proceed to the same frozen12-game holdout before activation.
A standalone one-group change needs at least10% total extraction-node savings,
no worse wall time, the existing recall/availability/UNKNOWN gates, and the B
quality-error gates; selected-context prefix savings do not meet this criterion.
If it passes, it may ship as a smaller first improvement, separately from A.
Do not remove the reference probe simultaneously. Removal produced one premature
NOT_A_MISTAKE which later became UNKNOWN in the replay, with the comparator also
UNKNOWN. That does not prove an error, but reinforces isolating the two controls.

Evidence: `artifacts/confirmation-value-review/README.md`, replay-results.json,
provenance.json and historical-evidence.json. The remainder of this plan describes
subsequent economics work; it is no longer a prerequisite for measuring this
single-factor hypothesis.

## 1. Freeze comparison inputs and add accounting

Extend the existing quality lab rather than build a new benchmark framework.
Freeze12 distinct existing PGNs for development (3 per provider/time-class cell:
Chess.com/Lichess x blitz/rapid). Select by source identity before examining new
variant outcomes. One fixed player perspective per game. All positions and both
perspectives of the same PGN belong to the same split.

Freeze12 additional distinct PGNs from the existing authorized public source
accounts for holdout, with the same cell balance, before evaluating variants.
Do not overwrite the historical corpus. Preserve source metadata, PGN hashes,
engine artifact/options hashes, profile/config IDs and exact compiled source.
If a cell lacks games, report and fill it with the next eligible game from those
accounts; do not silently substitute another population. This measures the
current sources, not broad rating-population performance.

Record per game and per candidate:
- scan, screen, reference, original, drift and optional nodes; actual nodes,
  requested reservations, search IDs and reasons; cached evidence reuse;
- elapsed engine work, engine startup, transport/wait, projection/validation and
  checkpoint serialization/persistence spans, with overlap accounted for;
- candidate disposition and reason; emitted moment and answer-index coverage;
- total wall time, first usable moment time, peak process memory, checkpoint and
  manifest bytes; worker invocations and DB writes on a bounded hosted smoke.

Engine-reported time was about60% of extraction wall time in the historical run.
The remainder is not automatically JS CPU overhead. Profile it before changing
validators or attributing savings. Dollar savings require actual billed compute
and memory measurements; do not infer them from nodes alone.

## 2. Introduce explicit execution profiles and resumable phases

Add `src/lib/analysis/extractionExecutionProfile.ts` for versioned execution
choices. Keep assessment/quality semantics in the existing training policy.
A profile selects scan budget, screening, confirmation allocation, candidate
cap/deadline and optional work. Include the resolved profile in config hashing.

Refactor the shared extractor into resumable SCAN and ASSESS phases. Reuse the
existing FIRST_PUZZLE scan/rank logic and scan evidence. A FULL_GAME still scans
every legal source position needed by move review; assessment is separately
budgeted. Keep the N+1 scan/reuse property. No whole-game scan is rerun when a
checkpoint resumes or a candidate is skipped.

Checkpoint persists phase, scan cursor, frozen ordered candidate IDs, candidate
cursor, physical evidence, screening dispositions, requested budget ledger and
remaining budget. Deduplicate physical search IDs. Resume has the same total
allowance as uninterrupted execution. A new worker does not grant a new budget.

New explicit receipt reasons: LOW_PRIORITY_CANDIDATE, SCREENED_LOW_SIGNAL,
SKIPPED_COMPUTE_BUDGET, SKIPPED_LATENCY_BUDGET. These are selection omissions,
never NOT_A_MISTAKE. Completion distinguishes scanComplete,
assessmentPassComplete and assessmentCoverageComplete. Finishing a bounded pass
must not mean that every position was deeply resolved, and must not cause queue
retries just because its declared compute allowance ran out. Interruptions and
engine failures remain separately resumable/error outcomes.

Candidate priority is frozen from scan evidence: rule/tablebase outcome changes
and mating transitions first; then estimated loss normalized by the current
policy's relevant tolerance (matched expected score when available, CP otherwise),
then source ply. These are search priorities, never final grade certificates.
Do not add inferred lesson types. Explicit reanalysis targets remain mandatory
work items; if their allowance ends, preserve their previous revision and record
unresolved reanalysis, never silently archive them.

Persist support/quality separately from execution profile. Validate the exact
profile/policy snapshot in the browser, server and attempt endpoints. New clean
checkpoint/receipt shapes replace old shapes; no compatibility readers, flags,
backfills or dual writes. Bump affected contract/config versions when required.

## 3. Candidate A: economical selection with unchanged quality support

Initial settings are concrete experiment inputs, not claimed optima.

Ordinary STANDARD:
- Keep scan100k so move review and candidate detection do not change together.
- Keep current grading thresholds,400k reference proof and two-search support.
- Before full confirmation, reuse comparable paid evidence for a cheap screen.
  If missing, allow at most one50k original-move search from the same root.
  Charge it to the candidate and game budgets and retain all observations.
- Screen out only finite, non-bound, non-contradictory cases with at least two
  observed depths separated by2, where every compared point has CP loss at most
  half the adaptive CP tolerance AND matched expected-score loss <=0.04 when WDL
  is present. In CP_ONLY use the CP condition. No available screen proof means
  continue to confirmation, not rejection. No mate, exact-outcome transition,
  or explicit reanalysis target is removed by this screen.
- Screening does not assert supported GOOD; it omits a low-priority candidate.
  Its correctness risk is lost useful moments, measured explicitly below.
- Limit total newly requested confirmation/screen work per candidate to1.6M.
  Dispatch only missing dependencies, using existing200k/400k/800k stages.
- Game confirmation allowance = min(30M, max(4M, 2 x S)), where S is the unique
  nominal100k-per-required-scan-position allowance for that game. All screens,
  focused probes, drift repairs and optional coverage consume this allowance.
  Exact/terminal zero-work decisions remain available after the allowance ends.
- No arbitrary maximum number of emitted moments. Prioritize candidate work;
  do not spend the entire game allowance on the earliest unclear position.
- Keep current tiny optional-coverage allowance, subordinate to submitted/required
  work and the cumulative game cap; do not optimize the0.1% cost first.

THOROUGH retains the existing deeper candidate ladder as an explicit user choice.
It shares evidence machinery, correctness fixes and accounting; the cheap
omission screen and new STANDARD game cap do not silently reduce its coverage.
No automatic background upgrade of every STANDARD result to THOROUGH.

Only switch the new-user/automatic default to STANDARD when the measured variant
passes. Respect an explicit user THOROUGH selection; changing a default is not
permission to overwrite deliberately stored preferences. Keep server credit
pricing unchanged in this work; display the chosen profile and existing price.

Why: cheap rejection addresses the113.4M-node good-original bucket; ranked,
bounded confirmation addresses the187.2M-node unresolved bucket. Current quality
support remains unchanged, so we can isolate selection loss from grading changes.

## 4. Landing: small bounded adaptation after ordinary extraction

Keep scan12k, current complete-game scan then ranked confirmation, engine handoff,
existing warm-up and stop-on-first behavior. Do not rewrite it into streaming
window selection in this iteration.

Use the same cheap screen, no optional coverage, and an initial limit of3 full
confirmation candidates per game,1.2M new nodes per candidate and3M per game.
The screen may examine additional candidates, but its nodes count toward3M.
Use a cumulative45s analysis deadline per lookup, including scan and engine
startup, across all fetched games; fetch time is measured separately. This is an
initial usability ceiling to validate, not a guaranteed time-to-puzzle. When it
expires, cancel that generation and expose the existing playable warm-up and an
explicit retry path. Do not spin indefinitely or publish an unverified candidate.

Keep existing quality support first. If this lowers the playable-puzzle yield
beyond the gate, retain today's landing profile rather than spend another large
optimization iteration. Landing's current latency is acceptable to the user.

## 5. Candidate B: conditional relaxation of repeated confirmation

Run this experiment only if A misses the ordinary-analysis cost gate while
preserving useful coverage, and accounting still points to repeated support work.
Do not combine it with a weaker scan or another threshold sweep.

Keep the definition of GOOD, selection signal and all history/score/bound/identity
checks. Change support policy under a new policy ID, consistently across producer,
manifest validator and local grading:
- Permit a clear-margin route from one completed full-root search plus one
  completed focused original/submitted-move search. Both must have >=200k actual
  nodes and two current unbounded observations at depths separated by>=2.
- Require all relevant comparisons to agree, no conflicting bound/mate/outcome
  evidence, and the conservative loss interval to be at least40cp away from the
  CP quality boundary and0.04 expected-score units away from the WDL boundary.
  GOOD must clear both applicable conditions. BELOW must clear the rejecting
  dimension consistently. Mate and rule/tablebase cases keep existing handling.
- For this finite clear-margin route only, omit the additional400k reference
  singleton and the second completed original/submitted-move search. A mature
  competing GOOD move or conflicting current reference evidence disables it.
- Every other case uses the current support requirements within its budget.
  Best-move identity, tier and exact loss can remain provisional even when the
  broad quality category is supported under this policy. Do not advertise
  statistical independence or proof of global best.

This is a measured product tradeoff, not a safety-invariant exemption. It may
produce some additional classification mistakes. Freeze the thresholds before
holdout; tighten/loosen only in a new explicitly reported experiment.

## 6. Experiment matrix and acceptance gates

Development:12 games x current STANDARD, current THOROUGH, A =36 fresh runs.
If B is necessary, add12, not a combinatorial profile sweep. Run serialized on
one engine host with identical artifact/options and cold game sessions; retain
normal within-game transposition-table reuse. Interleave profile order by game.
No simultaneous owned heavy jobs during latency tests. Existing raw strong
references can be reused for comparison where compatible; product runtimes and
latency cannot be claimed fresh from cached projections.

Freeze the winner, then holdout12 games x current STANDARD, current THOROUGH and
winner =36 fresh runs. Maximum ordinary full-game runs:72 without B,84 with B. The12 landing bundles
and fixed answer suite are additional bounded checks, not included in this
whole-game count. Comparator work is limited to changed/disputed cases; if
coverage denominators cannot be met from these inputs and compatible retained
evidence, report the shortfall before expanding the corpus.
If A loses clearly on development, stop and report its failure before holdout.
Do not rerun unchanged complete batches after unrelated docs/test edits.

Measure selection recall against the current baseline's emitted moments which
are not contradicted by stronger evidence. Report exact moment overlap and
per-game availability separately; same-position replacements do not erase a
lost-moment count. Adjudicate new/dropped/contradictory cases with bounded stronger
searches and preserve UNKNOWN. A stronger engine is a comparator, not ground truth.

Recommended release decision thresholds:
- Ordinary winner: >=25% lower total requested nodes vs current STANDARD and
  >=15% lower total native wall time, with p95 wall time no worse than+10%.
  Also report actual savings vs current THOROUGH; do not substitute this easier
  comparison for the STANDARD gate. Report requested and actual-node results.
- Preserve >=90% of comparable baseline moments and a playable moment in >=95%
  of baseline-positive games, on development and holdout separately. With small
  denominators show counts: e.g.95% of12 positive games permits zero lost games.
- B needs >=10% additional node saving vs A to justify changed support rules.
  Recommended grading tolerance: <=1% supported GOOD/BELOW opposition across at
  least200 mutually resolved played-move comparisons; report all errors and raw
  denominators. <=2% contradicted original-mistake admissions across at least50
  mutually resolved emitted moments. These are empirical release tolerances,
  not population guarantees or a requirement to drive errors to zero.
- A keeps existing support rules; any new quality opposition triggers focused
  investigation of execution/selection changes, not automatic endless retuning.
- Compare the fixed96-position answer suite using a preselected small answer set
  (reference, original, boundary alternative, previously unknown legal move),
  deduplicated. Include all existing adversarial regression fixtures. Avoid a
  fresh exhaustive search of every legal move for every profile.
- Preserve supported-answer coverage: final UNKNOWN share may not grow by more
  than2 percentage points on the same selected-answer workload. This prevents
  cheaper production evidence from moving unmeasured costs into Practice.
- Warm grading p95 <=2s desktop and<=3s CDP4 on supported answers; report timeouts
  and UNKNOWN separately. Known-answer fast path does no new engine search.
  Confirm actual React behavior, cold artifacts/network and one physical mobile
  separately; lack of a physical device must be reported, not called a pass.
- Landing: test12 fixed username/game bundles, >=90% of baseline puzzle-found
  yield and no slower median/p95 first playable result. Include warm-up fallback
  in the outcome table, never count it as a personally extracted puzzle. Keep
  current landing settings if the proposed bounds fail these gates.

If no variant passes, keep the deployed policy/defaults and report the measured
frontier. Do not weaken gates after seeing holdout, add source-specific rules,
or continue an open-ended benchmark loop. A failure yields a narrow next proposal.

## 7. Implementation ownership, review and release

Dependency order and file ownership:
1. Lab/accounting: `scripts/extraction-quality-lab.ts`, quality comparison,
   cost ledger and new frozen experiment fixtures/report. No policy changes.
2. Execution/profile/checkpoint: new extractionExecutionProfile.ts,
   `extractTrainingMoments.ts`, `positionAnalysisPool.ts`, extraction receipts,
   game analysis types and server checkpoint consumers. One coherent owner.
3. A screening/allocation: new candidate screening helper, shared extractor and
   focused real-evidence tests. Assessment policy unchanged.
4. Conditional B: `assessmentPolicy.ts`, `practiceContract.ts`, shared policy
   normalization, `localGrading.ts` and API validators; review as one contract.
5. Selected profiles: `quality.ts`, `preferences.ts`, server run config/billing
   binding, `onboarding/personalPuzzleFinder.ts` and fallback UI only as needed.

Focused tests must cover cumulative budgets across yield/retry, deterministic
candidate order, pool evidence retention, negative/UNKNOWN receipt semantics,
reanalysis preservation, exact endings, known-response no-search, interruption,
and late engine updates. Reuse the real failures already captured by v4.

Independent CR after each coherent change; final review includes checkpoint
completion, authorization, billing consistency, corpus leakage and denominator
integrity. Run repository canonical checks and affected DB/queue/browser/offline
lanes once on the final code; repeat only after relevant changes or failures.

On implementation authorization, integrate only the measured winner into main,
wait for required CI, apply any precisely scoped contract migration, and deploy
that exact main commit directly. No feature-branch production deployment,
compatibility rollout, flags or canary. Verify production branch/SHA, health,
one actual local extraction/attempt and one bounded actual server queue job.
Use supported authenticated entry points; an unverified queue run remains an
explicit release-verification gap. The unrelated Weekly Master refill is tracked
separately and must not expand this optimization scope.

Deliver one results table: baseline STANDARD, baseline THOROUGH, selected regular
profile and landing profile; costs, moments, omissions, errors, UNKNOWN, timings,
source SHA and limitations. No claim of a universal optimum from24 games.
