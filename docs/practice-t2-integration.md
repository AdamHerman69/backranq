# Practice T2 integration

T2 selects useful Practice decisions independently from how many answers can be
immediately graded. It uses the same shared extractor on the server and in the
browser. The landing page invokes its `FIRST_PUZZLE` mode; ordinary extraction
uses `FULL_GAME`. STANDARD and THOROUGH remain explicit corroborated research
profiles. T2 replaces the previous THOROUGH default at the same 10 credits/game;
the explicit STANDARD profile remains 7 credits/game.

## Paid work and selection

The frozen T2 policy is `practice-selection-t2-v1`:

- Scan the training side's decisions and their adjacent child positions at 100k
  nodes, MultiPV 1, preserving canonical replay history.
- Retain both parent and child observations. If the played move is missing from
  the root bundle, compare the child's best reply from the training side's POV.
- Verify only admitted WDL-only differences or admission disagreement between
  the last two usable scan points. Prioritize admitted decisions nearest the
  expected-score-loss boundary; do not spend work rescuing every UNKNOWN.
- Targeted work is a 200k MultiPV 3 root plus, when necessary, a 200k focused
  original move. Caps are 400k per decision and 2M post-scan nodes per game.
- Freeze the exact selected search identities. A partially spent verification
  that cannot complete its pair may retain its original scan comparison.

The cp tolerance is `min(300, max(100, 0.6 * max(0, bestCp)))`. A point is below
standard when its loss exceeds that tolerance or 0.10 expected score. Selection
also requires a meaningful signal: expected-score loss at least 0.08, or without
WDL at least 100cp loss in a nonsaturated reference position (`abs(bestCp)<300`).
Mixed cp/mate comparisons use compatible real WDL rather than a fabricated mate
cp value. Mandatory rule outcomes retain exact provenance. These are empirical
selection rules, not a proof of objective chess correctness.

## Practice contract v5

Every revision carries two separate records:

- `selection`: registered selection policy, INCLUDED/OMITTED, reason and the
  selected comparison. It decides eligibility for persistence, feed and solving.
- `decision`: assessment-derived diagnostic. It may remain UNRESOLVED while the
  selected moment is usable. It does not block a T2 moment from Practice.

A comparison includes both moves, scores and WDL normalized to the training side,
its SAME_ROOT/PARENT_CHILD/EXACT_OUTCOME basis, and the actual observation or exact
certificate IDs. Validation reconstructs the comparison from those records.
Child evidence keeps its own full FEN, history, side-to-move and physical search;
it is never relabeled as a focused parent search. Exact outcomes never become
fake engine observations. Hashes include selection semantics independently of
arbitrary physical ID allocation.

Derived assessment metrics use 12 decimal places in the serialized contract.
Grading and support decisions use the original evidence before this formatting.
This prevents Prisma JSON transport from shortening binary floating-point tails
and making an otherwise unchanged stored revision fail exact validation.

The current reader accepts v5 only. No compatibility reader, backfill or dual
write is introduced. Existing pre-user revisions need reanalysis. The database
migrations add the T2 AnalysisQuality enum and then update the database's price
constraint to admit server T2 at 10 credits (local/external execution remains
zero). A separate clean-cutover migration removes incompatible derived Practice
and Master graphs, invalidates old current analysis, and settles/cancels obsolete
queued work. Games, accounts, source snapshots and historical billing remain.
Current v5 graphs are preserved. This is a clean pre-user contract replacement.

## Answer grading and feedback

The registered `practice-v5-point-first` policy accepts a usable completed root
point as its recommendation, with a 25k observed-node floor for finite scores.
It does not demand an additional 400k reference probe or two physical searches.
Alternate answers can use one compatible completed point; 20cp and 0.02 expected
score margins keep genuinely boundary-sensitive results pending. Strict/lenient
answer tolerances retain the same point-first evidence rules. Meaningful newer
counterevidence, incompatible models, invalid bounds or missing usable evidence
still prevent a definitive grade.

Supported answers get immediate feedback. An unknown answer can show its observed
rank (or absence from the current lines) and a pending indicator. Absence from
MultiPV is never itself a bad-move certificate. Local analysis prioritizes the
submitted move, can stream its changing evaluation, and returns neutral uncertainty
when its budget expires. Optional active-position preparation is at most 100k
nodes/2 seconds and is cancelled when the user submits or leaves.

A user who followed a supported recommendation keeps their earned success if
later analysis corrects it. The analytical correction remains in the immutable
assessment history; the correction does not turn that attempt into a lapse.
Single-decision explanation lines are not certified multi-move combinations.

## Verification record

The initial offline v5 projection reused all paid evidence from the unchanged
72-game T2 holdout (nine accounts, ratings 1323–2775):

- 306/306 revisions passed validation, were eligible for Practice and supplied
  both display scores; previous strict projection admitted 0/306 to Practice.
- Recommended moves matched T2 in 306/306; 299 were directly indexed, seven
  remained pending. Reference readiness was READY for 304/306.
- Original answers were indexed in 102 cases and pending in 204. This is answer
  coverage, not moment quality and not a predicted frequency of user submissions.
- 174 comparisons reused child evidence; 132 were from the same root.
- No additional engine searches. Projection cost includes repeated builder,
  parser and candidate validation, so it is not a production extraction benchmark.

Detailed reproducible artifacts: `artifacts/extractor-practice-v5-integration/`.
The original holdout, audits and old strict projection remain unchanged. T2's
previous measured extraction average was about 10 CPU seconds/game on the study
machine; this is not a browser latency or production SLA. The stronger audits
still contain false admissions and disagreements. Integration does not erase
that measured limitation.

The bounded real-engine grading diagnostic covered 22 conditions in four chosen
positions: six instant answers made no engine queries; eight cold evaluations
had a 541 ms median, and eight prepared evaluations had a 225 ms median plus
178 ms median preparation. Both sets resolved seven answers and left the same
boundary-sensitive answer neutral. Total work was 3.575M nodes / 14.024 CPU
seconds. This ran the local grader with server WASM; it is not a representative
browser latency or accuracy benchmark. All emitted patches were revalidated
against the final grading policy.

Production extractor replay of two frozen games matched the research query
order, scopes, budgets, history, selected evidence and all 23 moments without
issuing new engine searches. The landing-mode replay also matched its prefix.

Independent review covered extractor parity and evidence provenance, answer
grading and correction handling, and persistence/feed/attempt consumers. The
integrated review findings were fixed, including exact-certificate binding,
server price constraints and numeric JSON persistence.

The final `pnpm check` passed lint, TypeScript, 1,941 tests (40 intentionally
skipped), production build and every client bundle budget. The separate study
runner check passed its lint/type checks and 115 tests. The database was created
from the complete migration chain on a disposable local PostgreSQL instance:
57 tables and 796 columns matched Prisma, private-role checks passed, and all
27 actual AnalysisRun price/mode/quality insert probes accepted or rejected as
expected. Probe rows were rolled back.

All 11 selected desktop Chromium E2E cases passed against that production build
(21 seconds total): landing bundle separation, automatic personal-puzzle handoff,
cancellation/retry, real local WASM grading, neutral worker failure, analytical
correction without a duplicated attempt, and navigation/retry persistence. The
new T2 case seeds an actual frozen selected moment, reads it back through the
Practice consumer, plays its pending original answer in the real browser, and
verifies one RECORD/ENRICH attempt plus resolved evidence in PostgreSQL. This
tests the consumer path, not a live server-queue extraction from scratch.
Screenshots of the resolved T2 answer and local grading were visually inspected.
The disposable database/container was removed after verification.

The initial integration checks above were performed on
`feature/extractor-practice-v4`, based on
`ea127c3f9e461297820c56dc070e4815a43b4bff`. The subsequent release phase adds the
clean-cutover migration, its populated PostgreSQL regression, and the required
security upgrades to Next.js/eslint-config-next 16.3.4 and sharp 0.35.4.
Release measurements and deployment provenance are recorded in
`artifacts/practice-t2-release/`; local validation alone is not proof of deployment.
