# Production T2 server benchmark

Completed eight frozen holdout games on the local host, through `extractTrainingMomentsFromGames` and the actual production `ServerStockfishClient`. All candidate and receipt validation passed. No provider, hosted queue, database, or browser operation was performed. This is a small descriptive cost sample, not an SLA or a quality audit.

Sequential total: **76.91s wall; 80.98 CPU-seconds**, comprising **62.08s engine child + 18.90s parent process**. Average whole pipeline: **9.61s wall / 10.12 CPU-seconds per game**; observed wall range 7.26–12.54s.

The 515 source plies produced 34 moments from 260 player decisions. Total requested work was 58.6M nodes across 552 queries: 51.8M scan and 6.8M targeted verification nodes. There were no failures or reused engine queries.

| Game index | Rating | Plies | Moments | Nodes M | Engine CPU s | Parent CPU s | Whole wall s | Output KiB |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 26 | 1283 | 56 | 5 | 6.6 | 7.03 | 2.34 | 8.61 | 214.3 |
| 8 | 1455 | 70 | 7 | 9.0 | 9.62 | 3.24 | 12.07 | 331.3 |
| 16 | 1576 | 59 | 7 | 6.2 | 6.95 | 2.03 | 9.45 | 231.0 |
| 40 | 1696 | 61 | 2 | 6.9 | 6.90 | 1.92 | 8.24 | 118.4 |
| 48 | 1706 | 71 | 2 | 8.0 | 8.54 | 2.52 | 10.43 | 136.1 |
| 72 | 2486 | 48 | 4 | 5.4 | 6.08 | 1.60 | 7.26 | 148.7 |
| 80 | 2515 | 67 | 1 | 6.8 | 7.05 | 1.86 | 8.30 | 79.9 |
| 88 | 2802 | 83 | 6 | 9.7 | 9.91 | 3.37 | 12.54 | 318.9 |

## What the additional pipeline work costs

Parent-process work accounts for 23.3% of measured CPU. It includes engine protocol handling, scan/selection, pool/evidence processing, revision building, external validation, serialization and benchmark bookkeeping. Of that, 6.69s occurred inside awaited engine calls, while 12.20s occurred outside those calls. The latter is not a pure builder measurement: it includes initialization and validation too.

An additional full `validateTrainingMomentCandidates` plus receipt/manifest validation after extraction consumed 2.49 CPU-seconds / 2.46s wall total (0.311 CPU-seconds/game). Output JSON serialization consumed 0.005 CPU-seconds total. Building and internal validation already performed by the extractor remain inside its measured time.

Serialized results total 1.54 MiB, averaging 197.3 KiB/game. This includes moments, manifests, config and the analysis Map encoded as entries. It does not include database rows/index overhead or a framework/network response wrapper.

Maximum sampled parent RSS was 256.5 MiB; largest child process peak was 239.5 MiB. The largest sum of component peaks was 492.8 MiB. This is an upper bound, not a simultaneous RSS measurement. Parent RSS reflects a reused sequential Node process and GC behavior; each engine child was fresh.

## Method and limits

- Games were chosen from the existing holdout by rating/account only: indices 26, 8, 16, 40, 48, 72, 80, 88, with eight different accounts and ratings 1283–2802. This does not represent a uniform user population.
- Frozen current-source bundle; its SHA-256 and corpus SHA-256 are in the results JSON. No research strategy implementation ran. The runtime factory adds only CPU telemetry to the unchanged production Stockfish child entrypoint.
- Default T2: scan100k/MultiPV1; targeted root200k/MultiPV3 and original200k when absent, capped400k/candidate and2M/game. Hash64, one engine thread. A fresh engine per game includes startup/model loading; its transposition table stays warm inside that game.
- Child CPU is actual process CPU, not Stockfish reported search time and not elapsed wall. Telemetry and startup are included. Parent CPU is measured separately, avoiding double-counting child work. Parent/child work overlaps, so summed CPU and wall need not match.
- Parent measurement starts after bundle imports; parent module initialization is excluded, while engine child startup/model loading is included.
- Host scheduling, concurrent host activity, thermal state, platform and process reuse can change wall times. Hosted function cold starts, queue wait, database work, storage writes and provider fetching are excluded.
- No concurrency scenario was added: the sequential eight-game sample answers the pipeline-overhead question within the authorized budget. Completed at80.98 CPU-seconds, below the300-second ceiling.

Host: Apple M1 Pro; darwin/arm64; Node v24.16.0.

Artifacts: `server-benchmark.ts` (source), `server-benchmark.mjs` (immutable run bundle), `server-benchmark-results.json` (per-game query records and metrics), `server-benchmark-summary.json` (derived aggregates), `server-benchmark.log` (run progress).

## Browser answer feedback

A separate bounded real Chromium/WASM diagnostic used the production
`usePuzzleSession` hook with the same prewarm option as Practice. Across 14
conditions on two deliberately selected real positions, known answers appeared
in about 9 ms without an engine query. Ordinary pending answers showed a pending
frame within 1–9 ms and resolved in 293–311 ms after immediate submission, or
173–180 ms after one second of prompt dwell. The plausible knight alternative
was accepted; the original mistake was rejected.

One selected boundary answer stayed neutral in all four repeats. With immediate
submission during engine preparation it finished in about 2.08 s, compared with
1.35 s in the no-prewarm control; after a one-second dwell it took 0.92–0.95 s.
The canceled startup followed by a slow first replacement query is a concrete
future profiling target. The benchmark does not establish its internal cause.

Desktop and mobile here mean different viewports on the same desktop host;
this is not physical-phone performance. These numbers exclude full-page render,
network, drag interaction and persistence. Ten graded and four neutral outcomes
are a deliberately constructed diagnostic, not user answer frequencies or an
accuracy estimate. Both primary and control runs together consumed 8.85M
requested nodes and about 43 sampled CPU seconds. Source evidence and raw
measurements remain under `artifacts/practice-t2-release/`.
