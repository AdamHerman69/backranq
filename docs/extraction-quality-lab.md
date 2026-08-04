# Extraction Quality Lab

Status: implementation and calibration contract

## Goal

The lab measures whether the product extractor finds stable, fair practice
positions in real blitz and rapid games. It is not a second extraction path and
does not write application data. It runs the production extractor against a
versioned public-game corpus and compares the product profile with a stronger
reference profile.

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
- all audited candidates plus the trainable subset, keyed by canonical decision
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
product budgets and a materially stronger reference profile. Generated reports
belong under `artifacts/extraction-quality-lab/` and are not committed.

`quality:extract:confirmation` isolates the effect of a deeper adaptive
confirmation cap. It compares the production 800k hard cap with a 1.6m
candidate while keeping scan, continuation, coverage, grading, and MultiPV
settings identical. Its default sample contains two games from each provider
and time-class bucket.

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

User decision nodes begin with a bounded MultiPV search. If the last returned
exact line is still within the grading tolerance, the verifier expands the
frontier until it finds an out-of-tolerance line, exhausts the engine result,
or reaches a hard cap. The cap is a resource boundary, not a claim that no
other good move exists; an open frontier keeps the solution shape `OPEN` and
unknown legal moves retain dynamic local grading.

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
