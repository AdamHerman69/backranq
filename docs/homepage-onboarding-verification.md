# Homepage onboarding verification — 2026-09-05

Baseline: production `main` at `14e798584842a81c0c52f487819570344bac540a`.
This follows the technical stabilization pass and the explicitly authorized production reset.

## Demonstrated problems

- An untouched warm-up stayed on the board after personal extraction completed.
  The switch was hidden until the introductory attempt became terminal.
- Chronological extraction spent about 70–78 seconds on a frozen five-game
  `adam1a4` sample. The first two games contained losses of approximately
  245cp, 222cp, and 194cp. Rejected training candidates were not evidence that
  those games contained no mistakes: their accepted-answer boundaries were open
  or changed under confirmation.
- Confirmation rejected the same accepted moves and grades when only their
  ordering changed between engine searches.

## Resulting behavior

Untouched introduction boards switch to the completed personal result. Any
pointer or keyboard interaction preserves the current board and unfinished input,
with an immediately available **Solve my position** button. Late master-puzzle
responses cannot replace the personal board or emit a false display event.

The personal finder first runs the existing cheap scan, ranks the player's
candidate decisions by evaluation loss, and verifies the strongest ones until a
fully trainable position is found. The frozen sample completed in approximately
17.8 seconds: 8.7 seconds scouting, then three targeted checks. The result was a
verified 198cp mistake in game `174012887374`, decision ply 35. This is an isolated
Chromium measurement, not a guarantee for every device or profile.

Confirmation, grading tolerances, and engine node budgets remain unchanged.
Partial searches never claim full-game completion. Canonical full-game extraction
keeps its existing path. Frontier confirmation compares each move and its grade,
while still rejecting changed membership, grades, duplicate moves, or unstable evidence.

## Verification

- Independent review of both extraction and handoff changes: clean.
- Focused extraction/finder/frontier checks: 60 tests passed.
- `pnpm check`: passed; lint, TypeScript, 1,377 unit/API tests (31 opt-in tests
  skipped), production build, and all eight route bundle budgets.
- `pnpm test:e2e --skip-build tests/e2e/landing-handoff.spec.ts tests/e2e/landing-bundle.spec.ts`:
  real browser Stockfish and extraction, automatic handoff, late master response,
  retained unfinished keyboard input, explicit switch, and actual puzzle grading.
  All three tests passed. Only provider and analytics I/O are stubbed.
