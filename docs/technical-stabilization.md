# Technical stabilization

## Mission and baseline

- Requested outcome: establish evidence for application correctness, performance,
  maintainability, and test reliability; repair confirmed defects in reviewed batches.
- UI redesign and new product features are out of scope. Existing UI behavior,
  responsiveness, and offline recovery are in scope.
- Base: `main`, `bf097c4a6210445a4ffdf64d3862749f5dc8b946` (2026-09-05).
- Initial tracked working tree is clean. Existing untracked `artifacts/` and
  `ideas.md`, and other worktrees, are user-owned and excluded.
- Authorized: local audits, isolated test databases, code/test/documentation fixes,
  independent review. Publication, deployment, live provider tests, and mutations
  of shared databases are not part of this run.
- Do not add legacy compatibility, speculative abstractions, or weaken tests to
  obtain a pass. Preserve one authoritative implementation of business rules.

## Execution

The coordinator owns verification, this report, shared configuration, integration,
and final evidence. Auditors initially work read-only against the same baseline.
Editing lanes receive explicit non-overlapping ownership. Each confirmed defect
needs a trigger, expected/actual behavior, impact, source location, and regression
verification. Hypotheses and test gaps are distinct from demonstrated failures.

| Lane | Scope | Status |
| --- | --- | --- |
| Authorization and data | User isolation, authentication, admin and billing entrypoints | Three fixes implemented; coordinator reviewed |
| Background work | Analysis/sync, retries, cancellation, recovery, credit lifecycle | Three fixes implemented; independent source review clean; eight real PostgreSQL regressions pass |
| Application flows | Import, analysis, practice, progress, Coach/offline | Durability and completion-time fixes; independent review clean; browser persistence regression passed |
| Verification and performance | Existing CI gates, test validity, real browser/DB behavior, measured budgets | Baseline and combined check/DB/E2E/offline/model gates passed |

Prioritize security/data/credit defects, broken core flows, measured performance
issues, then maintenance changes justified by concrete risk. Independently review
each patch and verify the integrated result; summaries are not proof.

## Journey coverage to verify

| Journey | Required evidence |
| --- | --- |
| Authentication and ownership | Unauthenticated rejection; another user's data inaccessible; session transitions |
| Import to analysis | Valid/invalid PGN; repeated import; job completion/cancellation/recovery |
| Practice to progress | Correct grading; persistence; retry/duplicate submission behavior; aggregate correctness |
| Coach/offline | Legal moves; engine lifecycle; storage ownership; cold offline and reconnection |
| Billing and administration | Credit invariants; duplicate events/commands; permissions; isolated provider doubles |
| Notifications | Owner boundaries; preferences; retries/unsubscribe with isolated transports |
| Performance | Production build; initial bundle budgets; browser interaction and API latency on fixed fixtures |

## Evidence log

Detailed local command logs for this run: `/tmp/backranq-stabilization.FtcmEW/`.
These are temporary diagnostic files, not durable repository artifacts. Relevant
results and limitations will be summarized here.

- Node `v24.16.0`, pnpm `10.24.0`, Docker server `29.4.0` available.
- `pnpm check`: passed (lint, types, 214 test files / 1,334 tests,
  production build, all eight initial client bundle budgets). 5 test files /
  23 tests skipped, including opt-in database/live checks.
- `pnpm audit:prod`: failed, six high-severity advisories across transitive
  `browserslist` and `fast-uri`; patched versions confirmed in package registry.
- `pnpm check:queue-runtime-bundle`: passed.
- `COMPOSE_PROJECT_NAME=backranq-stabilization pnpm test:e2e`: passed,
  64 browser tests / 5 explicitly skipped (live provider and visual audit).
  Complete migration chain applied to disposable PostgreSQL 17.
- Isolated `pnpm check:db-contract`: passed, 57 application tables, two
  untrusted roles; `pnpm check:schema-shape`: passed, 814 columns.
- Opt-in PostgreSQL integration: 8 tests passed; Progress scale gate failed
  at 5,978.69 ms reader / 3,912.84 ms attempts query for 100,003 attempts and
  1,001 positions. This run overlapped the production build and was not treated
  as a standalone application performance diagnosis (quiet rerun below).
- Baseline local Practice: warm feed p95 21.88 ms, Home-to-Practice interaction
  p95 143.4 ms, cold interaction 254.7 ms, three Prisma operations for feed.
  These fixed-fixture local measurements do not establish deployed latency.
- `pnpm test:e2e:coach-offline:built`: 19 passed / 1 opt-in Maia test skipped.
- Isolated Progress scale rerun after build/browser workload finished: all three
  tests passed, including the unchanged 5-second reader/query limits. The first
  failure is retained as evidence of benchmark sensitivity to concurrent load;
  no speculative SQL optimization or relaxed threshold was introduced.
- Full migration history vs Prisma via a disposable shadow database: no difference.
- `pnpm smoke:stockfish-browser`: passed real WASM searches and cancellation.
- `pnpm check:queue-runtime-callback`: passed real Stockfish startup and local
  Queue transport acknowledgement from the compiled callback.
- After pinned transitive updates, `pnpm audit:prod`: no known vulnerabilities.
- `pnpm test:maia-model`: passed pinned public-model SHA/size verification and
  real local ONNX inference. This downloads public model bytes, not a credentialed
  provider operation.
- Tests not executed or skipped must never be represented as passing.

## Completion gates

- No unresolved confirmed critical/high-severity findings in audited scope.
- Relevant lint, types, unit/API tests, production build and bundle gates pass.
- Isolated database contracts/integration and browser journeys pass where required.
- Performance meets predefined budgets; no unsupported production-performance claims.
- Integrated changes receive independent review and regression verification.
- Remaining gaps, blocked checks, and lower-priority work are explicit.

## Findings and changes

| ID | Priority | Confirmed scenario | Status |
| --- | --- | --- | --- |
| T01 | P1 | Completed practice result is lost when navigation aborts its first online write before it enters the durable queue | Fixed; baseline-red lifecycle regression; independent review clean; real browser/database replay passed |
| T02 | P2 | Current Stripe invoice parent contract is ignored; paid/failed invoice events are acknowledged without synchronization | Fixed; baseline-red canonical regressions; coordinator review clean |
| T03 | P2 | Email unsubscribe also cancels pending Web Push deliveries | Fixed; baseline-red canonical regression; coordinator review clean |
| T04 | P2 | Vercel hostname fallback creates non-absolute billing/invitation URLs | Fixed; baseline-red canonical regression; coordinator review clean |
| T05 | P2 | Stale analysis worker can resurrect a terminal/newer run through an unfenced running transition | Fixed; baseline-red regression and real PostgreSQL contention tests; independent review clean |
| T06 | P2 | Direct sync redelivery reclaims an expired run after the maximum attempt budget | Fixed; baseline-red regression and successful page-continuation coverage; independent review clean |
| T07 | P2 | Analysis failure before run transition leaves a terminal job attached to a QUEUED run | Fixed; baseline-red behavioral regression; independent review clean |
| T08 | High dependency gate | Six transitive dependency advisories fail the production audit | Fixed; production dependency audit clean; independent lockfile review clean |
| T09 | P2 | Offline completion recorded on day A is attributed to server synchronization day B, shifting progress and review timing | Fixed; two baseline-red service regressions; independent review clean; real browser/database replay passed |

Source and regression evidence:

- T01: `src/lib/hooks/usePracticeFeed.ts`,
  `tests/lib/practice-attempt-persistence.test.ts`,
  `tests/e2e/practice-persistence.spec.ts`.
- T02: `src/app/api/stripe/webhook/route.ts`,
  `tests/api/stripe-webhook-route.test.ts`. Fixtures are checked against the
  installed SDK's `Stripe.Invoice` parent contract rather than unchecked legacy
  objects; string/expanded subscription references and one-off invoices covered.
- T03: `src/app/api/notifications/unsubscribe/route.ts`,
  `tests/api/notification-unsubscribe-route.test.ts` (email/push, status, owner,
  and essential-message separation).
- T04: `src/lib/stripe.ts`, `tests/lib/stripe-config.test.ts` (absolute URLs and
  configuration precedence).
- T05–T07: `src/lib/services/analysisJobs.ts`, `serverAnalysis.ts`, `syncJobs.ts`;
  `tests/lib/job-lifecycle-regressions.test.ts`,
  `tests/lib/job-lifecycle-postgres.integration.test.ts`, and
  `tests/lib/sync-jobs.test.ts`.
- T08: `package.json`, `pnpm-lock.yaml`; only patched `browserslist@4.28.7` and
  `fast-uri@3.1.6` overrides with expected transitive deduplication. Advisories:
  GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g, GHSA-5jgf-p345-68v8,
  GHSA-f65p-4m7j-42xc, GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp.
- T09: `src/lib/hooks/usePuzzleSession.ts`,
  `src/lib/training/{api,apiValidation,attemptService,completionTime,offlineQueue}.ts`;
  `tests/lib/training-{api,attempt-service,completion-time,offline-queue}.test.ts`
  and the held-POST browser regression, which preserves a completion two days
  before replay and verifies a single database record.

Audit observations, limits, and discarded hypotheses:

- T09 is now accepted against `docs/progress-v1.md` terminal-completion semantics
  and the attempt service's delayed/offline scheduling guarantee.
- Some source-text tests constrain code shape without establishing runtime
  behavior. Existing Home E2E already exercises shared sync requests; avoid
  duplicating it or deleting useful checks without evidence.
- Initial claim of a skipped-analysis credit settlement race was disproved:
  completion atomically persists the pending-release marker. Do not repair it.
- `load:analysis-queue` is a standalone arithmetic simulation, not a load test of
  the real scheduler, database, Queue delivery, or deployed worker throughput.
  Its output must not be used as evidence of production capacity.

## Contract and verification changes

- Practice records are written to an owner-scoped durable outbox before network
  I/O. Only confirmed responses remove the exact entry; navigation aborts leave
  it available for replay. Direct writes and flushes coordinate without dropping
  concurrent additions. Independent review caught and corrected a missing retry
  trigger introduced by queue-first persistence.
- Practice requests require immutable canonical `completedAt`; server receipt
  remains separately recorded. Five minutes of clock skew matches existing
  Coach/exposure conventions. No arbitrary offline retention cutoff is added.
  The pre-user outbox changes from v3 to v4; old pending local v3 entries are not
  migrated or replayed. No database migration is needed.
- Analysis run start now checks the claimed run and dispatch fence under a real
  row lock. The obsolete generic transition fields and helper were removed.
- Exhausted sync jobs become terminal before another provider call; successful
  pagination still resets its page attempt budget.
- The new PostgreSQL lifecycle regression file is included explicitly in the
  existing CI database job so it cannot remain permanently opt-in-only.
- Removed the unused `BACKRANQ_E2E_AUTH` environment switch and stale comment
  claiming that it disabled the analysis bar. No source consumed that switch;
  existing Home E2E exercises the actual bar. Independent review and scoped lint
  passed for this test-runner cleanup.

## Integrated verification

All editing lanes are frozen and independently reviewed. Results below are from
the combined working tree, not merely separate author test runs.

| Gate | Result |
| --- | --- |
| `pnpm check` | Passed: lint, TypeScript, 218 files / 1,365 tests, production build, all eight client bundle budgets |
| Default-suite skips | 6 files / 31 tests skipped by their opt-in guards; database and Maia are exercised separately |
| PostgreSQL CI suite with integration + scale flags | Passed: 4 files / 17 tests, including unchanged 100k-attempt scale limits and eight new lifecycle regressions |
| New practice persistence browser regression | Passed: interrupted first POST, identical replay, exactly one DB attempt, original completion date and separate receipt date |
| Full browser suite | Passed: 65 tests; 5 explicit live-provider/visual-audit skips |
| Final compiled Queue bundle and callback | Passed; actual Stockfish startup and acknowledgement through local transport stub |
| Final Coach/offline + real Maia browser inference | Passed: 20 tests, including public model download and cold offline inference; no skips |

Final local Practice samples: feed p95 **16.88 ms**, Home-to-Practice interaction
p95 **145.4 ms**, cold interaction **236.1 ms**, three feed Prisma operations.
These are within existing budgets. The small before/after differences are not
claimed as a performance improvement; this patch primarily improves correctness.
Practice initial JS is **170.3 KiB gzip / 250 KiB budget**, versus 169.9 KiB baseline.

## Outcome and remaining limits

Eight application defects (T01–T07 and T09) and the six-advisory dependency gate
(T08) are resolved. The audited patches have no outstanding actionable review
findings. UI redesign remains a separate phase.

- This is a bounded evidence-based technical pass, not proof that every possible
  application defect has been found. Auth/ownership review found no demonstrated
  cross-user bypass in the inspected boundaries; it was not a penetration test.
- Credentialed live OAuth/provider imports, Stripe billing/webhook delivery,
  SMTP2GO/Web Push delivery, hosted configuration, and deployed latency were not
  exercised. Unit/API doubles and isolated local DB/browser tests cover their
  inspected contracts. Live integration checks require separately scoped targets.
- A real scheduler/worker throughput test under expected concurrent user load is
  still a useful next performance pass. The arithmetic queue simulation does not
  establish this capacity. No throughput or deployed-latency claim is made here.
- Visual redesign/audit was deliberately excluded. Existing layout checks ran
  as part of the canonical E2E suite; the explicit visual-audit cases were skipped.

Final source remains `main` at `bf097c4a6210445a4ffdf64d3862749f5dc8b946`
with local uncommitted changes. No commits, pushes, merges, hosted configuration
changes, or deployments were performed. Existing unrelated artifacts, ideas, and
worktrees were preserved. Test-owned PostgreSQL container/network/shadow database
were removed by the final E2E wrapper; generated auth state was cleaned up.

For a subsequent technical pass, keep the same acceptance rules: demonstrate a
defect or measurement first, assign one owner, prove the regression fails before
the fix, independently review the patch, and exercise the combined behavior.
