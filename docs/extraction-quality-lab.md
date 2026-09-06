# Extraction Quality Lab

Status: implementation and calibration contract

Audit note (2026-09-05, `8739124`): see
[`audits/standard-analysis-audit.md`](audits/standard-analysis-audit.md) for
reproductions, measured limits, and producer/consumer defects. A green lab run
does not establish that browser persistence or ordinary Practice works end to end.

## Goal

The lab measures whether the product extractor finds stable, fair practice
positions in real blitz and rapid games. It is not a second extraction path and
does not write application data. It runs the production extractor against a
versioned public-game corpus and compares the product profile with a stronger
reference profile. The lab uses the server adapter and omits the optional
tablebase provider; it is not a browser or network/persistence benchmark.

The initial corpus is sourced only from these user-approved public accounts:

- Chess.com `adam1a4`;
- Lichess `aldicigg`.

Every corpus row must be standard chess, identify the requested account on
exactly one side, and have normalized time class `blitz` or `rapid`. Corpus
refresh fails closed if a provider returns another time class, malformed PGN,
an unresolved player side, or a duplicate provider game ID.

## Measurements

For each profile and game the lab records:

- completed/incomplete extraction manifests;
- built candidates plus the trainable subset, keyed by canonical decision
  ply and source kinds;
- solution verification status and shape;
- best move and accepted-move set;
- extraction receipt reason for every user decision;
- engine calls, requested nodes, wall time, and positions produced.

The comparison reports:

- product/reference moment-key overlap;
- product-only and reference-only decisions;
- exact best-move agreement and whether each profile's best move is accepted
  by the other profile;
- accepted-move Jaccard similarity;
- verification-status and receipt-reason distributions;
- total and per-game analysis cost.

The reference profile is a stronger comparator, not chess ground truth. A
human review label remains authoritative for deciding whether a position is
useful, noisy, missing, or unfair.

Earlier rejected candidates appear through receipts, not the moment array.
The ordinary comparison only compares trainable moments and reports perfect
ratios for empty denominators; always inspect counts and rejected decisions.
Current receipts also combine several different exclusion causes under
`VERIFICATION_UNSTABLE`, including an accepted original move.

## Commands

```bash
pnpm quality:extract:refresh
pnpm quality:extract:smoke
pnpm quality:extract
pnpm quality:extract:confirmation
```

`quality:extract:refresh` deliberately performs network reads and rewrites the
versioned corpus. Routine tests never call providers. `quality:extract:smoke`
runs a bounded subset with reduced budgets. The full command uses current
STANDARD budgets and a materially stronger reference profile. The application's
default is THOROUGH, whose loss-confirmation cap is higher. Generated reports
belong under `artifacts/extraction-quality-lab/` and are not committed.

`quality:extract:confirmation` isolates the effect of a deeper adaptive
confirmation cap. It compares STANDARD's 800k hard cap with THOROUGH's 1.6m
cap (named `confirmation-candidate` in the historical report format), while keeping scan, continuation, coverage, grading, and MultiPV
settings identical. Its default sample contains two games from each provider
and time-class bucket.

### Optional local audit instrumentation

```bash
BACKRANQ_EXTRACTION_AUDIT=1 BACKRANQ_EXTRACTION_AUDIT_DIRECTORY=audit-full pnpm quality:extract --limit=2
node scripts/summarize-extraction-audit.mjs artifacts/extraction-quality-lab/audit-full
BACKRANQ_EXTRACTION_AUDIT=1 BACKRANQ_EXTRACTION_AUDIT_DIRECTORY=audit-confirmation pnpm quality:extract:confirmation --limit=2
node scripts/summarize-extraction-audit.mjs artifacts/extraction-quality-lab/audit-confirmation
node scripts/audit-runtime-parity.mjs
```

Use a fresh directory for each run. This opt-in wrapper records full local
extraction output, per-call results, startup, wall time, diagnostic call stacks,
and the maximum reported UCI nodes/time per physical search. UCI counters are
cumulative per search: never sum MultiPV slots. A final info line can precede
the actual stop, so these remain reported counters rather than exact CPU work.
The stack-derived phase labels are diagnostic and the wrapper assumes the
extractor's sequential engine calls. It does not modify search budgets or add
engine searches. The summary rejects mixed run IDs, source SHA, or corpus hashes.
Repeated identical requests are counted without claiming they are waste.

## Product changes gated by the lab

### Adaptive confirmation

The product keeps a deterministic scan budget. A candidate starts at the
configured confirmation budget and escalates geometrically only when its
qualification changes, its loss is near the coverage threshold, its loss is
materially unstable, or its best move changes. Repeated disagreement at the
hard cap is unresolved rather than silently accepted or rejected.

The user-facing confirmation setting remains the base quality budget. The hard
cap is derived from it, so this does not introduce another ordinary setting.

### Adaptive accepted-move frontier

User decision nodes begin with a bounded MultiPV search. The verifier expands
an unresolved frontier until it finds the required natural cp gap, proves
legal-move exhaustion, or reaches a hard cap. A stable frontier receives a
second-budget comparison of membership and per-move tiers. The cap is a
resource boundary, not a claim that no other good move exists. An open frontier
keeps solution shape `OPEN` and is not eligible for the ordinary Practice feed.
Canonical ordinary Practice requires a complete accepted set and rejects moves
outside it; its unknown-move engine fallback does not adjudicate those prompts.
The audit documents a current adapter defect preventing proof of short legal
move exhaustion, plus the implications of tier-only instability.

### Extraction receipt

Completed game analysis includes one receipt row for every user decision. A
row says whether the decision produced a trainable position and, if not, why:
forced move, below coverage threshold, below threshold after confirmation,
incomplete evidence, or unstable verification. The receipt stores bounded
loss and confirmation evidence, never raw engine protocol output.

## Explicit non-goals

- no Practice UX overhaul in this branch;
- no spaced-repetition scheduler in this branch;
- no production corpus refresh or database write;
- no compatibility layer for older analysis JSON.

The future scheduler should use revision-pinned attempt grade, reveal state,
response time, recurrence, confidence, and severity after extraction quality is
calibrated.
