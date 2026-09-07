# Practice feedback benchmark

Run after the full suite, builds and other engine benchmarks finish. This harness launches real Chromium and the bundled local Stockfish WASM. It uses the application’s actual `gradeKnownLocalMove`, `gradeUnknownLocalMove`, evidence pool, policy and cumulative work planner.

```sh
node scripts/benchmark-practice-feedback.mjs --build-only
node scripts/benchmark-practice-feedback.mjs --input artifacts/practice-v4-audit --output artifacts/practice-feedback-benchmark.json
```

`--input` accepts a JSON file or a directory of JSON audit results. Nested canonical v4 manifests are collected and deduplicated by revision and semantic hash; empty inputs fail. `--limit N` bounds moments for a smoke run. `--mode desktop` or `--mode mobile-cpu4` runs one scenario; the default runs both sequentially.

Each position receives up to ten distinct legal moves, predetermined before any local search: preferred and another known good answer, original move, known below-standard answers, known moves nearest the policy boundary, then evenly spaced unknown moves and other legal moves. Exact selections and their order appear in the output. Positions with fewer than ten legal moves are measured completely. This is a stratified runtime sample, not a gameplay-frequency estimate.

Artifact version 6 uses a fresh real Stockfish runtime **for each hypothetical answer that needs engine work**, including optional detail refinement. Its identity is awaited before the warm grading clock starts; worker initialization is reported separately as per-answer `coldStartupMs`. Each answer receives a fresh local evidence session with the same unchanged paid manifest. The engine is terminated after that answer, so neither transposition-table contents nor earlier hypothetical conclusions leak into the next choice. Known answers with complete detail start no engine and report null startup. Runtime retries remain inside the grading budget and latency.

`--session-mode shared-stress` explicitly retains both the engine transposition table and local evidence across hypothetical answers within a position. Results are order-dependent and cannot satisfy the independent first-choice latency gate. Neither mode simulates a first-time download over a mobile network or the actual transposition table handed over by homepage extraction. Startup measures real worker initialization; browser/OS resource caches may already be warm.

The immediate badge uses a minimal DOM harness and two `requestAnimationFrame` callbacks. Its `initialHarnessPaintMs` includes known lookup and the scheduled frame after updating feedback, excluding separately measured initialization; it is not full React board latency, rasterization instrumentation, or an input-device-to-photon measurement. Known quality stays visible during optional refinement. Unknown moves begin neutral. The report separately records first live evaluation, first supported quality, final quality/tier, unresolved results, planner job reasons, requested/reported nodes and personal-patch validation. Every row retains the exact nullable runtime assessment and patch plus serialized patch bytes for replay; serialization is outside the measured grading interval.

The native all-legal comparator harness (`practice-v4-position-audit.ts`, artifact version 9) follows the same independent local-engine lifetime. Its stronger comparator intentionally uses a separate retained engine. Explicit `SHARED_STRESS` mode retains local engine TT across the run and local evidence within each position; immediate lookup also checks that retained evidence. This state is labelled order-dependent. Code, policy, source, mode and engine protocol participate in its resume fingerprint; older artifacts cannot resume as version 9.

For every legal move, the comparator completes both an 800k-node and a 1.6M-node singleton search, independently of the runtime verdict. Ground then requires the current shared reference-readiness check, supported self-reference and absence of drift. After each completion the shared `requiredWork` determines either a full-root search or a focused search of the current preferred move. Both reference ladders are independently bounded at 1.6M/3.2M/6.4M; compatible paid all-legal singleton evidence can satisfy the focused proof without another search. The total requested-node ceiling is 22.4M plus 2.4M per legal move, with 120 seconds per search. Each report preserves readiness, physical cost, reservations and termination reason. Unresolved reference or move evidence remains UNKNOWN; raw candidate disagreements and the excluded denominator remain visible. These searches retain the comparator’s transposition table and are corroborating engine measurements, not statistically independent samples.

Direct source-position capture uses the same dependency rule with 200k/400k/800k root and original-move ladders, a 400k/800k reference-probe ladder, a 2.8M aggregate ceiling and 30 seconds per search. Imported `--input-manifests` retain their exact extractor evidence and are the only positions counted as extractor-emitted. Optional `--input-sources` appends real positions whose complete identities and histories must match the corpus PGNs; it does not convert them into extractor outputs. The sidecar’s original bytes are copied immutably and hashed into the run fingerprint. Curated RULE positions remain separately labelled, and missing completed comparisons are counted explicitly.

Mobile mode uses the Playwright Pixel 7 viewport/device configuration and explicitly requests fourfold CDP CPU throttling. It is emulation on the recorded host: worker throttling is not guaranteed by that setting, and it cannot establish performance on physical mobile hardware. Both modes report Chromium, OS, CPU, memory, corpus SHA, source-file hashes, source commit, tracked source diff hash and the actual bundled-runtime SHA.

Every aggregate includes its measured count and p50/p95; missing live or supported results have null latency and are counted separately. Unknown-answer latency also has its own aggregate, excluding instantaneous known answers. The report records host load averages at the beginning and end. This benchmark does not label engine conclusions as correct. The independent deeper all-legal-move comparator supplies correctness evidence. Compare timings only from isolated runs on the same hardware, input corpus and source bundle, retaining unresolved and timeout counts beside the latency percentiles.

With the corroborated policy, optional extraction coverage can prepay one mature
physical search for a later actual answer. It does not certify previously unseen
CP/WDL moves after that one search. Coverage reports use supported answer-index
entries, never the number of merely observed alternatives. The existing single
optional pass and total allowance remain unchanged.

Version 9 optionally accepts `--reuse-comparator=<completed-v8-directory>` on
both capture and compare. It binds the complete immutable input files into the
new fingerprint and requires exact source/history, current initialized engine
identity, the declared v8 budgets and both physical singleton requests for every
legal move. It preserves all raw records, including stopped searches and bounds,
and recomputes every assessment and category using the current policy and strict
canonical validator. Old labels are never inputs. A ready reference uses zero
new stronger searches; an unready or unmatched reference runs the ordinary fresh
bounded comparator. Corrupt inputs fail explicitly. The actual extractor and
every runtime answer still run afresh. Reused physical cost and new work are
reported separately; this is a policy re-evaluation of paid evidence, not a new
independent engine replication.

Strict narrow cases require at least two legal choices, all classified and one to
three supported good answers. One-legal-move real source controls are labelled
separately and never satisfy that category quota.
