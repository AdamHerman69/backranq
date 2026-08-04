# Game automation

## Product contract

Game import, engine analysis, and practice are separate stages controlled by
one coherent user policy:

1. **Import** keeps the game library current and never consumes analysis
   credits.
2. **Automatic analysis** selects eligible imported games and consumes the
   selected server quality's exact price: Standard is 7 credits per game and
   the default Thorough profile is 10.
3. **Practice** reads positions produced by completed analysis and remains
   usable regardless of import or analysis backlogs.

For every provider and time control, the user chooses exactly one mode:

- `IGNORE` — do not import matching games automatically;
- `IMPORT_ONLY` — import matching games without automatic analysis;
- `AUTO_ANALYZE` — import matching games and automatically analyze eligible
  ones.

This makes `AUTO_ANALYZE => import` structural. An impossible configuration
such as “analyze bullet, but do not import bullet” cannot be represented.
Manual history import remains a separate, explicit action and may import games
outside the automation policy.

The default imports every time control from linked accounts and performs no
automatic server analysis. A top-level pause temporarily stops all scheduled
automation without destroying the matrix.

## Preference contract

`gameAutomation` is the only accepted automation contract:

- `paused`;
- a complete Lichess/Chess.com × bullet/blitz/rapid/classical/unknown mode
  matrix;
- shared analysis eligibility, budget, and existing-game settings.

Removed split settings are neither read nor written. There are no compatibility
aliases or migrations because the application has no production users.

The API validates providers, time controls, and modes strictly. `enabledAt` is
server-controlled and establishes the boundary for “new games only”.

## Import invariants

- A provider and external game ID form the idempotency key for an imported
  game.
- The selected time controls are sent to the provider fetch itself. Ignored
  games do not consume the first-sync game limit or pagination budget.
- Sync is paginated. A page-size or per-run safety limit never advances the
  durable cursor beyond unprocessed games.
- Incremental fetches overlap the previous cursor and rely on idempotent import
  to avoid games being lost at timestamp boundaries.
- Provider payloads fail closed. Malformed rows, missing stable identity, or a
  response for a different player never advances the cursor.
- Provider failures are isolated. One failing source does not roll back or
  misreport games saved from another source.
- Provider identity and the active import-policy hash are part of sync state.
  Changing either resets only that provider's cursor and conditional-request
  metadata while preserving imported games.
- A running sync is fenced by identity, import-policy hash, and job lease. Work
  started under old rules cannot import games or advance the new cursor after a
  settings change.
- Manual and automatic requests for the same user/provider join the same
  durable job. “Sync now” bypasses scheduling freshness, not the selected
  automatic-import time controls.
- Initial sync is intentionally bounded for fast first value. Older history is
  an explicit, repeatable **Import history** action.

Changing a mode to `IGNORE` does not delete games already imported. Expanding
the imported time controls restarts the provider lookback so newly included
games are not skipped.

## Automatic analysis

Only a game whose exact provider/time-control cell is `AUTO_ANALYZE` can enter
the automatic analysis backlog. Shared filters support:

- rated-only or rated and casual games;
- losses, losses and draws, or all completed results;
- minimum game length;
- personal daily and monthly game limits;
- a credit reserve that automatic work may not cross;
- existing eligible games or only games imported after analysis was enabled.

Plan entitlements remain hard ceilings. Game limits are independent from the
credit balance: Standard and Thorough each occupy one game slot, while credit
capacity is floored by the selected profile's 7- or 10-credit price. The
effective game limit is always the lower of plan and personal limits.

Changing the matrix cancels unstarted automatic jobs and releases their
reservations. Bounded reconciliation then recreates only work allowed by the
new matrix. Running work may finish. Pausing or removing all `AUTO_ANALYZE`
cells prevents new automatic spend.

## Backlog semantics

An imported, eligible, unanalyzed game without active, successful, or terminal
failed server work is part of the automation backlog.

- Credit or cap exhaustion is a normal blocked state, not an analysis failure.
- Waiting work does not reserve credit.
- Queue unavailability leaves games waiting without a reservation.
- Reconciliation is idempotent and may run after import, preferences changes,
  credit renewal, plan changes, or a scheduled sweep.
- Manual user-selected work has priority over automatic backlog work.
- Failed engine work is not retried indefinitely.

User-facing game states are Imported, Waiting, Analyzing, Ready, and Failed.

## Required verification

- Each provider receives the exact imported time-control set.
- More games than one provider page are imported without gaps.
- Same-timestamp games are not lost.
- Identity and policy changes reset only the affected provider cursor.
- A stale in-flight sync cannot commit after a policy change.
- `IMPORT_ONLY` never creates automatic analysis work.
- Provider-specific `AUTO_ANALYZE` cells are enforced exactly.
- Personal caps, plan caps, and the reserve floor remain safe under concurrent
  reservations.
- Waiting work resumes after capacity returns while its cell remains enabled.
- Mobile layout, focus order, live status, and authenticated-owner changes
  remain safe.
