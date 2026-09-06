# Homepage onboarding verification — 2026-09-05

## Current local flow: live game scan

Starting personal search unmounts the warm-up/master/current puzzle, including
unfinished input. A single board follows actual extraction progress, using
pre-decision FENs from one PGN parse per visited game and the imported player's
fixed orientation. Progress is coalesced to the latest event per animation frame;
analysis never waits for playback. Only adjacent scanned moves animate (100 ms).
Candidate changes, verification, resumed playback jumps and reduced motion use
instant position changes. Pause freezes playback while analysis continues.

Verification holds the candidate's pre-decision position without evaluation
hints or solution arrows. A successful result automatically opens the personal
puzzle at that FEN, without a switch button. The main board shows game metadata,
phase and move number rather than a guessed percentage. Empty/error searches
show an explicit outcome and allow another search. Terminal states reject late
progress, and late master responses cannot replace a personal search or result.

Local validation: `pnpm check` passed (lint, types, 1,381 unit/API tests, build,
all eight route budgets). The four Chromium landing tests passed with actual
browser Stockfish, isolated provider/analytics responses and a local test DB.
They cover lazy engine loading, late master delivery, replacing unfinished
input, fixed orientation, pause/resume, verification-to-puzzle FEN equality,
actual move grading, and mobile empty/error retry with reduced motion. One test
delays worker message delivery by 80 ms to observe intermediate states; that
delay is test-only and is not a performance benchmark. Desktop and mobile
screenshots were visually inspected. No production deployment has been made.

## Follow-up: search one game at a time

Local follow-up against `main` at `873912414c5498fa1c94e575ed9847884cad190b`:
homepage search now scouts the newest game, ranks and verifies that game's
candidates, and returns immediately on a verified trainable result. It only
scouts the next older game if no candidate in the current game qualifies.
Analytics progress allocates scanning and confirmation within each game's share instead
of jumping to 90% during the first game's verification. Engine budgets and
the shared extraction/grading rules are unchanged.

Regression coverage includes stopping before any older game is scanned,
exhausting rejected candidates in ranked order, skipping candidate-free games,
and cancellation. The prior timing measurements below describe the previous
implementation, not a benchmark of this sequential version.

Validation: focused finder/state checks passed (14 tests); `pnpm check` passed
(lint, types, 1,379 unit/API tests, production build, eight route bundle budgets).
`pnpm test:e2e --skip-build tests/e2e/landing-handoff.spec.ts tests/e2e/landing-bundle.spec.ts`
passed all three Chromium tests with the real browser engine and isolated
provider/analytics responses. This follow-up has not been deployed.

## Original verification

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
