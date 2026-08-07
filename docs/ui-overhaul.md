# Backranq UI overhaul

## Product hierarchy

Backranq's primary loop is:

`game -> analysis -> personal decision -> attempt -> understanding -> review -> progress`

Every screen should prioritize, in order:

1. The chess position or current product decision.
2. The single most useful next action.
3. The consequence and explanation of that action.
4. Navigation to related positions, moves, or history.
5. Technical controls, filters, methodology, and administration.

Primary actions must remain directly available. Menus are reserved for rare,
advanced, or destructive actions.

## Screen intent map

| Screen | Primary user intent | Must be immediately available | Progressive disclosure |
| --- | --- | --- | --- |
| Landing | Understand and try Backranq, then find a personal position | Profile lookup, interactive board, sign in | Product details, methodology |
| Login | Safely continue a saved flow | Provider choices, back to landing, trust links | Provider details |
| Invitation | Accept Pro or recover from an unavailable invitation | State-specific CTA, support, back to Backranq | Invitation mechanics |
| Home | Know what to do next | Continue Practice, due/new count, current processing status | Detailed sync and analysis state |
| Practice Solve | See a position, move, understand, continue | Full board, prompt, Flip, Reveal, feedback, Try again/Analyze/Next | Focus filters, engine evidence, source details |
| Practice Analyze | Explore and compare lines | Board, evaluation, Decision/Your/Best, previous/next, Threats | MultiPV and variation management |
| Coach setup | Start or resume a useful game | Resume, color, opponent, strength, Start | Thresholds and engine provenance |
| Coach game | Play and understand interventions | Board, player state, Try again/Analyze/Continue | Move list and engine evidence |
| Games | Find and resume work on a game | Search, Sync, Import, Review, Practice | Advanced filters and bulk actions |
| Game review | Understand the game move by move | Players, full board, playback, current classification, Practice | Live engine, export, re-analysis, delete |
| Progress | Know whether practice is working and what to do next | Focus next, trend, core outcomes, time window | Coverage, methodology, detailed breakdowns |
| Settings | Change one category confidently | Section navigation and local Save state | Technical diagnostics |
| Notifications | Open the relevant update | Unread items, mark read, settings | Older notifications |
| Admin Weekly Master | Detect and resolve pipeline issues | Health, failures, candidate inspection | Audit evidence and rare overrides |
| Admin Premium | Invite and manage complimentary access | Invite, delivery health, pending invitations | Grant history and diagnostics |

## Mobile acceptance criteria

At 390 x 844:

- Practice shows the complete board, prompt, feedback, and current primary
  action without scrolling.
- Game review shows both players, the complete board, and playback controls
  before expandable review content.
- Coach shows player state, the complete board, and intervention actions.
- Boards never overflow horizontally and use a 8-12 px workspace gutter.
- Daily navigation is available in a bottom dock; Settings remains in account.
- Touch targets are at least 44 x 44 px and safe areas are respected.
- Reduced motion preserves every discrete state and accessible announcement.

## Visual system

The direction is an editorial chess studio: warm ivory surfaces, graphite text,
verdigris product accent, restrained elevation, and move-quality colors used
only when they convey chess meaning. Geist remains the application typeface.
Radix-backed local primitives remain for accessibility, while their visual skin
and composition are replaced.

Motion is purposeful: 90 ms press, 150 ms hover/focus, 220 ms panel changes,
220-260 ms chess moves, and a short grade reveal after the move settles. Layout
does not jump during loading; skeletons reserve the final board and panel sizes.

## Implementation order

1. Design tokens, primitives, responsive shell, mobile dock, shared
   loading/empty/error states.
2. Board presentation state machine and on-board move-quality marker.
3. Practice Solve and Landing puzzle integration.
4. Game review and analysis workspace.
5. Coach setup, game, intervention, and offline states.
6. Home, Games, Progress, Settings/Profile/Notifications.
7. Login, invitation, Privacy, Terms, Support, 404, route loading/error states.
8. Admin polish, accessibility review, responsive browser verification, and
   screenshot regression coverage.
