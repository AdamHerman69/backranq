# Game sync and analysis automation V1

## Product contract

Game import, engine analysis, and practice are separate stages:

1. **Sync** keeps a user's game library current. It never consumes analysis
   credits.
2. **Analysis automation** selects eligible imported games using only provider
   metadata and an explicit user policy.
3. **Server execution** reserves credits only when an eligible game can
   actually enter the server queue.
4. **Practice** reads positions produced by completed analysis. A sync or
   analysis backlog must not block already available practice.

The default after a user explicitly links a public chess identity is:

- keep new games up to date;
- do not spend server credits automatically;
- offer free browser analysis while the application remains open.

## Sync invariants

- A provider and external game ID form the idempotency key for an imported
  game.
- Sync is paginated. A page-size or per-run safety limit must never advance the
  durable cursor beyond unprocessed games.
- Incremental fetches overlap the previous cursor and rely on idempotent import
  to avoid games being lost at timestamp boundaries.
- Provider payloads fail closed. Malformed rows, missing stable identity, or a
  response for a different player never advance the cursor.
- Provider failures are isolated. One failing source does not roll back or
  misreport games saved from another source.
- Provider identity is part of sync state. Changing the normalized username
  resets provider cursors and conditional-request metadata, but preserves
  imported games.
- A manual sync and an automatic sync for the same user/provider join the same
  active durable job.
- Running sync work uses a tokenized lease, heartbeat, bounded provider fetch,
  and transaction-level fencing. An expired or superseded worker cannot write
  games, cursor state, or terminal job state.
- App-open sync is stale-while-revalidate: it never blocks rendering and does
  nothing when a recent successful/attempted sync is fresh.
- Initial sync is intentionally bounded for fast first value. Older history is
  an explicit, bounded **Import history** action that can be repeated.

## Analysis automation policy

Sync-provider selection and analysis-provider selection are independent.
Automatic analysis supports:

- enabled/disabled;
- Lichess and Chess.com sources;
- bullet, blitz, rapid, classical, and unknown time controls;
- rated-only or rated and casual games;
- losses, losses and draws, or all completed results;
- minimum game length;
- personal daily and monthly caps;
- a credit reserve that automatic work may not cross;
- existing eligible backlog or games imported after automation was enabled.

The nested `autoAnalysis` policy is the only accepted preference contract.
There are no legacy aliases, compatibility fields, policy versions, or
dual-read/dual-write paths.

Plan entitlements remain hard ceilings. The effective budget is always the
lower of plan capacity and the user's personal budget.

Changing extraction coverage or grading tolerance never changes import
coverage. It affects analysis output, not which provider games are stored.

## Backlog semantics

An imported, eligible, unanalyzed game without active or successful server work
is part of the automation backlog.

- Credit or cap exhaustion is a normal blocked state, not an analysis failure.
- No credit is reserved for merely waiting work.
- If the worker queue is temporarily unavailable, eligible games remain
  waiting and no credit is reserved.
- Reconciliation is idempotent and may run after sync, credit renewal, plan
  changes, or a later scheduled job.
- A terminal automatic job schedules the next bounded reconciliation so an
  eligible backlog drains one executable game at a time without requiring the
  user to reopen the application.
- Failed engine work is not retried indefinitely by backlog reconciliation.
- Manual user-selected work has priority over automatic backlog work.
- Disabling automation prevents new automatic spend. Unstarted automatic work
  should be cancelled with its reservation released; running work may finish.

User-facing game states are:

- **Imported** — stored but not selected for active analysis.
- **Waiting** — eligible, but waiting for budget or queue capacity.
- **Analyzing** — browser or server work is active.
- **Ready** — analysis completed and any resulting practice positions were
  persisted.
- **Failed** — execution was attempted and genuinely failed.

## Home and navigation

Home is a state-aware launchpad, not a second practice workspace.

- If practice positions exist, **Continue Practice** is the dominant action.
- Sync status and unanalyzed backlog remain secondary unless they block the
  user's first useful position.
- A compact source row shows linked providers, latest sync status, and
  **Sync now**.
- The full provider/date/game picker is presented as **Import history**.
- Waiting work clearly offers free browser analysis and a path to billing or
  automation settings.

Profile and preference writes carry the expected signed-in owner and are
rejected before validation or mutation if the active account changed in
another tab. Provider identity checks are bounded and distinguish a missing
account from rate limits, upstream failure, and timeout.

The UI uses **Practice**, **games**, and **positions**. New product and API
contracts use the same canonical terminology; removed contracts are not kept
for backward compatibility.

## Required verification

- More games than one provider page are imported without gaps.
- Same-timestamp games are not lost.
- Identity changes reset only the affected provider cursor.
- Manual, automatic, and app-open sync requests are idempotent.
- Import success remains truthful when analysis has no credits.
- Personal caps, plan caps, and the reserve floor are enforced under
  concurrent reservation attempts.
- Waiting work resumes after capacity returns when automation remains enabled.
- Home keeps Continue Practice dominant when positions already exist.
- Mobile layouts, focus order, live status, reduced motion, and authenticated
  owner changes remain safe.
