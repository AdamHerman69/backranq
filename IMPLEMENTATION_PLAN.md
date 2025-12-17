# BackRank Implementation Plan

> A step-by-step guide for AI agents to transform the proof-of-concept into a full-fledged chess puzzle application.

## Overview

This document contains ordered prompts for AI agents to implement features incrementally. Each task is designed to be completable in a single session and includes:

-   Clear objectives
-   Technical context
-   Acceptance criteria
-   Git branch naming

## Git Branching Strategy

```
main
├── feat/phase-1-auth
│   ├── feat/1.1-database-setup
│   ├── feat/1.2-prisma-schema
│   ├── feat/1.3-nextauth-setup
│   ├── feat/1.4-user-profile-linking
│   └── feat/1.5-migrate-localstorage
├── feat/phase-2-games-library
│   ├── feat/2.1-games-api
│   ├── feat/2.2-games-list-page
│   ├── feat/2.3-game-detail-page
│   └── feat/2.4-game-sync-flow
├── feat/phase-3-puzzle-trainer
│   ├── feat/3.1-puzzles-api
│   ├── feat/3.2-puzzle-attempts-tracking
│   ├── feat/3.3-puzzle-trainer-page
│   └── feat/3.4-puzzle-sessions
├── feat/phase-4-dashboard
│   ├── feat/4.1-stats-api
│   ├── feat/4.2-dashboard-page
│   └── feat/4.3-insights-page
└── feat/phase-5-enhancements
    ├── feat/5.1-auto-sync
    ├── feat/5.2-spaced-repetition
    └── feat/5.3-pwa-support
```

---

# Phase 1: Authentication & Database

## Task 1.1: Database Setup with Supabase

**Branch:** `feat/1.1-database-setup`

**Merge into:** `feat/phase-1-auth`

### Prompt

````
I'm building a chess puzzle app called BackRank. I need to set up a PostgreSQL database using Supabase.

## Current State
- Next.js 14+ app with App Router
- Currently uses localStorage for state persistence
- No database or authentication

## Requirements

1. Install Supabase client packages:
   - @supabase/supabase-js
   - @supabase/ssr (for Next.js server components)

2. Create environment variables file structure:
   - Add to `.env.local.example`:
     ```
     NEXT_PUBLIC_SUPABASE_URL=your-project-url
     NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
     SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
     ```
   - Update `.gitignore` to exclude `.env.local`

3. Create Supabase client utilities in `src/lib/supabase/`:
   - `client.ts` - Browser client for client components
   - `server.ts` - Server client for API routes and server components
   - `middleware.ts` - For auth session refresh

4. Create a basic connection test API route at `/api/health` that verifies database connectivity

## Acceptance Criteria
- [ ] Supabase packages installed
- [ ] Environment variables documented
- [ ] Client utilities created and properly typed
- [ ] Health check endpoint works
- [ ] No TypeScript errors
````

---

## Task 1.2: Prisma Schema Design

**Branch:** `feat/1.2-prisma-schema`

**Merge into:** `feat/phase-1-auth`

### Prompt

````
I'm setting up Prisma ORM for my chess puzzle app BackRank. The app analyzes chess games and generates puzzles from blunders.

## Current State
- Next.js app with Supabase PostgreSQL database
- Supabase client already configured in `src/lib/supabase/`

## Existing Types (for reference)
The app already has these TypeScript types that the schema should align with:

```typescript
// src/lib/types/game.ts
type Provider = 'lichess' | 'chesscom';
type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';
type NormalizedGame = {
  id: string;
  provider: Provider;
  url?: string;
  playedAt: string;
  timeClass: TimeClass;
  rated?: boolean;
  white: { name: string; rating?: number };
  black: { name: string; rating?: number };
  result?: string;
  termination?: string;
  pgn: string;
};

// src/lib/analysis/puzzles.ts - Puzzle type
// src/lib/analysis/classification.ts - GameAnalysis, AnalyzedMove types
````

## Requirements

1. Initialize Prisma:

    - Run `npx prisma init`
    - Configure for PostgreSQL with Supabase connection string

2. Create schema in `prisma/schema.prisma` with these models:

    **User**

    - id (uuid, default uuid_generate_v4())
    - email (unique)
    - name (optional)
    - image (optional, for OAuth avatar)
    - lichessUsername (optional)
    - chesscomUsername (optional)
    - createdAt, updatedAt
    - preferences (Json, for analysis settings)
    - Relations: games, puzzles, puzzleAttempts

    **AnalyzedGame**

    - id (uuid)
    - userId (foreign key)
    - provider (enum: LICHESS, CHESSCOM)
    - externalId (the ID from the provider)
    - url (optional)
    - pgn (text)
    - playedAt (datetime)
    - timeClass (enum)
    - rated (boolean, optional)
    - result (string, optional)
    - termination (string, optional)
    - whiteName, whiteRating
    - blackName, blackRating
    - openingEco, openingName, openingVariation (optional)
    - analysis (Json, stores GameAnalysis)
    - analyzedAt (datetime, optional)
    - createdAt, updatedAt
    - Unique constraint: (userId, provider, externalId)
    - Relations: user, puzzles

    **Puzzle**

    - id (uuid)
    - userId (foreign key)
    - gameId (foreign key to AnalyzedGame)
    - sourcePly (int)
    - fen (string)
    - type (enum: AVOID_BLUNDER, PUNISH_BLUNDER)
    - severity (string, optional)
    - bestMoveUci (string)
    - bestLine (Json, array of UCI moves)
    - score (Json, { type: 'cp' | 'mate', value: number })
    - tags (string array)
    - openingEco, openingName, openingVariation (optional)
    - label (string, optional)
    - createdAt
    - Unique constraint: (gameId, sourcePly, fen)
    - Relations: user, game, attempts

    **PuzzleAttempt**

    - id (uuid)
    - puzzleId (foreign key)
    - userId (foreign key)
    - attemptedAt (datetime)
    - userMoveUci (string)
    - wasCorrect (boolean)
    - timeSpentMs (int, optional)
    - Relations: puzzle, user

3. Add necessary enums:

    - Provider (LICHESS, CHESSCOM)
    - TimeClass (BULLET, BLITZ, RAPID, CLASSICAL, UNKNOWN)
    - PuzzleType (AVOID_BLUNDER, PUNISH_BLUNDER)

4. Create initial migration

5. Add Prisma client singleton in `src/lib/prisma.ts`

## Acceptance Criteria

-   [ ] Prisma initialized with correct datasource
-   [ ] All models created with proper relations
-   [ ] Enums defined
-   [ ] Migration created and can be applied
-   [ ] Prisma client singleton created
-   [ ] No TypeScript errors after `npx prisma generate`

```

---

## Task 1.3: NextAuth.js Setup

**Branch:** `feat/1.3-nextauth-setup`

**Merge into:** `feat/phase-1-auth`

### Prompt

```

I'm adding authentication to my Next.js chess puzzle app using NextAuth.js (Auth.js v5).

## Current State

-   Next.js 14+ with App Router
-   Prisma ORM configured with User model
-   Supabase PostgreSQL database

## Prisma User Model (already exists)

```prisma
model User {
  id                String    @id @default(uuid())
  email             String    @unique
  name              String?
  image             String?
  lichessUsername   String?
  chesscomUsername  String?
  // ... other fields
}
```

## Requirements

1. Install NextAuth.js v5 (Auth.js):

    - next-auth@beta
    - @auth/prisma-adapter

2. Create auth configuration in `src/lib/auth/`:

    - `config.ts` - Main NextAuth configuration
    - `index.ts` - Export auth utilities

3. Configure providers:

    - Google OAuth (primary)
    - GitHub OAuth (secondary)
    - Credentials provider is NOT needed

4. Set up Prisma adapter:

    - Use @auth/prisma-adapter
    - Extend the User model if needed for NextAuth (Account, Session, VerificationToken)

5. Create API route handler:

    - `src/app/api/auth/[...nextauth]/route.ts`

6. Create middleware for protected routes:

    - `src/middleware.ts`
    - Protect: /dashboard, /games, /puzzles, /settings, /insights
    - Public: /, /login, /api/auth/\*

7. Create auth UI components in `src/components/auth/`:

    - `SignInButton.tsx` - Triggers OAuth flow
    - `SignOutButton.tsx` - Signs out user
    - `UserAvatar.tsx` - Shows user image/initial

8. Create login page:

    - `src/app/login/page.tsx`
    - Simple page with Google/GitHub sign-in buttons
    - Redirect to /dashboard after successful login

9. Add environment variables to `.env.local.example`:

    ```
    NEXTAUTH_URL=http://localhost:3000
    NEXTAUTH_SECRET=your-secret-here
    GOOGLE_CLIENT_ID=
    GOOGLE_CLIENT_SECRET=
    GITHUB_ID=
    GITHUB_SECRET=
    ```

10. Create a server-side helper to get current user:
    - `src/lib/auth/session.ts`
    - Export `getCurrentUser()` function for server components

## Acceptance Criteria

-   [ ] NextAuth.js installed and configured
-   [ ] Google and GitHub OAuth providers set up
-   [ ] Prisma adapter connected
-   [ ] Protected routes redirect to /login
-   [ ] Login page renders with OAuth buttons
-   [ ] Sign in/out flow works end-to-end
-   [ ] User session accessible in server components
-   [ ] No TypeScript errors

```

---

## Task 1.4: User Profile & Chess Account Linking

**Branch:** `feat/1.4-user-profile-linking`

**Merge into:** `feat/phase-1-auth`

### Prompt

```

I'm building a settings page where users can link their Lichess and Chess.com accounts to my chess puzzle app.

## Current State

-   NextAuth.js configured with Google/GitHub OAuth
-   Prisma User model has lichessUsername and chesscomUsername fields
-   Protected routes working

## Requirements

1. Create settings page at `src/app/settings/page.tsx`:

    - Display current user info (name, email, avatar)
    - Form to update lichessUsername
    - Form to update chesscomUsername
    - Show linked status for each platform

2. Create API routes for profile management:

    `src/app/api/user/profile/route.ts`:

    - GET: Return current user's profile
    - PATCH: Update profile fields (lichessUsername, chesscomUsername)

3. Add username validation:

    - When user enters a Lichess username, verify it exists by calling Lichess API
    - When user enters a Chess.com username, verify it exists by calling Chess.com API
    - Show validation status (checking, valid, invalid)
    - The app already has API routes at `/api/lichess/games` and `/api/chesscom/games` - you can reference how they call the providers

4. Create reusable components in `src/components/settings/`:

    - `ChessAccountLink.tsx` - Component for linking a chess account
        - Props: provider ('lichess' | 'chesscom'), currentUsername, onUpdate
        - Shows input, validate button, status indicator
    - `ProfileForm.tsx` - Main settings form

5. Add toast notifications for success/error states:

    - Install a toast library (sonner recommended)
    - Show success when account linked
    - Show error with message on failure

6. Style consistently with existing app (uses CSS modules in page.module.css)

## Acceptance Criteria

-   [ ] Settings page accessible at /settings
-   [ ] User can view their profile info
-   [ ] User can enter and validate Lichess username
-   [ ] User can enter and validate Chess.com username
-   [ ] Validation calls real APIs to verify usernames exist
-   [ ] Changes persist to database
-   [ ] Toast notifications for feedback
-   [ ] Responsive design matching existing styles

```

---

## Task 1.5: Migrate localStorage to Database

**Branch:** `feat/1.5-migrate-localstorage`

**Merge into:** `feat/phase-1-auth`

### Prompt

```

I need to migrate from localStorage persistence to database storage in my chess puzzle app.

## Current State

-   App currently saves state to localStorage under key "backrank.miniState.v1"
-   This includes: filters, puzzles, puzzleIdx, various analysis options
-   Users now have accounts with database storage available
-   Prisma models exist for AnalyzedGame, Puzzle, PuzzleAttempt

## Current localStorage Structure (from src/app/page.tsx)

```typescript
{
  filters: { lichessUsername, chesscomUsername, timeClass, rated, since, until, minElo, maxElo, max },
  puzzles: Puzzle[],
  puzzleIdx: number,
  puzzleTagFilter: string[],
  puzzleOpeningFilter: string,
  // Analysis options...
  puzzleMode, maxPuzzlesPerGame, blunderSwingCp, missedTacticSwingCp,
  evalBandMinCp, evalBandMaxCp, requireTactical, tacticalLookaheadPlies,
  openingSkipPlies, minPvMoves, skipTrivialEndgames, minNonKingPieces,
  confirmMovetimeMs, engineMoveTimeMs
}
```

## Requirements

1. Create user preferences API:

    `src/app/api/user/preferences/route.ts`:

    - GET: Load user's saved preferences (analysis options, filters)
    - PUT: Save user's preferences
    - Store in User.preferences JSON field

2. Create utility for preference management:

    `src/lib/preferences.ts`:

    - Define PreferencesSchema type
    - Default values
    - Merge function for partial updates

3. Update the main page.tsx to:

    - On mount: Check if user is logged in
        - If logged in: Load preferences from API, migrate any localStorage data
        - If not logged in: Continue using localStorage (guest mode)
    - On preference change: Save to API if logged in, localStorage if not
    - Add a "Sync to Account" prompt if user has localStorage data but is now logged in

4. Create migration helper:

    `src/lib/migration/localStorageToDb.ts`:

    - Function to detect localStorage data
    - Function to migrate puzzles to database
    - Function to migrate preferences
    - Clear localStorage after successful migration
    - Handle conflicts (puzzles that already exist in DB)

5. Add migration UI component:

    `src/components/migration/LocalStorageMigration.tsx`:

    - Shows when user logs in and has localStorage data
    - "Import X puzzles from this browser" button
    - Progress indicator during migration
    - Success/error feedback

## Important Notes

-   Keep guest mode working (localStorage for non-logged-in users)
-   Don't break existing functionality during migration
-   Handle the case where user has data in both localStorage and DB

## Acceptance Criteria

-   [ ] Logged-in users' preferences save to database
-   [ ] Preferences load from database on page load
-   [ ] Guest mode still works with localStorage
-   [ ] Migration prompt appears when user has localStorage data
-   [ ] Puzzles can be imported from localStorage to DB
-   [ ] No data loss during migration
-   [ ] localStorage cleared after successful migration

```

---

# Phase 2: Games Library

## Task 2.1: Games API Endpoints

**Branch:** `feat/2.1-games-api`

**Merge into:** `feat/phase-2-games-library`

### Prompt

```

I'm building API endpoints to manage analyzed chess games in my puzzle app.

## Current State

-   Prisma schema has AnalyzedGame model
-   App can fetch games from Lichess/Chess.com via existing API routes
-   Games are analyzed client-side with Stockfish WASM
-   Currently games exist only in React state, not persisted

## Existing Types

```typescript
// src/lib/types/game.ts
type NormalizedGame = {
    id: string;
    provider: 'lichess' | 'chesscom';
    url?: string;
    playedAt: string;
    timeClass: TimeClass;
    rated?: boolean;
    white: { name: string; rating?: number };
    black: { name: string; rating?: number };
    result?: string;
    termination?: string;
    pgn: string;
};

// src/lib/analysis/classification.ts
type GameAnalysis = {
    moves: AnalyzedMove[];
    whiteAccuracy?: number;
    blackAccuracy?: number;
};
```

## Requirements

1. Create games API routes:

    `src/app/api/games/route.ts`:

    - GET: List user's analyzed games with pagination and filters
        - Query params: page, limit, provider, timeClass, result, since, until, hasAnalysis
        - Return: { games: AnalyzedGame[], total: number, page: number, totalPages: number }
    - POST: Save a new analyzed game (or batch of games)
        - Body: { games: NormalizedGame[], analyses?: Map<string, GameAnalysis> }
        - Upsert based on (userId, provider, externalId)
        - Return: { saved: number, skipped: number }

    `src/app/api/games/[id]/route.ts`:

    - GET: Get single game with full analysis
    - PATCH: Update game (mainly to add/update analysis)
    - DELETE: Remove game from user's library

    `src/app/api/games/[id]/analysis/route.ts`:

    - PUT: Save analysis results for a game
        - Body: GameAnalysis
    - Called after client-side Stockfish analysis completes

2. Create data transformation utilities:

    `src/lib/api/games.ts`:

    - `normalizedGameToDb(game: NormalizedGame, userId: string)` - Transform for Prisma
    - `dbGameToNormalized(dbGame: AnalyzedGame)` - Transform from Prisma
    - `gameAnalysisToJson(analysis: GameAnalysis)` - Serialize for JSON column
    - `jsonToGameAnalysis(json: unknown)` - Deserialize from JSON column

3. Create client-side API hooks:

    `src/lib/api/useGames.ts`:

    - Custom hooks using fetch (or SWR/React Query if you prefer)
    - `useGames(filters)` - List games with refetch capability
    - `useSaveGames()` - Mutation to save games
    - `useGameAnalysis(gameId)` - Get/update analysis

4. Add proper error handling:
    - 401 for unauthenticated requests
    - 404 for games not found / not owned by user
    - 400 for validation errors
    - Proper TypeScript types for error responses

## Acceptance Criteria

-   [ ] GET /api/games returns paginated list
-   [ ] POST /api/games saves games to database
-   [ ] Games are scoped to authenticated user
-   [ ] Analysis can be saved separately
-   [ ] Proper error responses
-   [ ] TypeScript types for all request/response shapes
-   [ ] Client hooks work correctly

```

---

## Task 2.2: Games List Page

**Branch:** `feat/2.2-games-list-page`

**Merge into:** `feat/phase-2-games-library`

### Prompt

```

I'm building a Games Library page to browse and manage analyzed chess games.

## Current State

-   API endpoints exist at /api/games for CRUD operations
-   Main page (src/app/page.tsx) has a games table that shows fetched games
-   Existing styles in page.module.css can be referenced

## Current Games Table (from page.tsx lines 721-829)

The existing table shows: checkbox, date, provider, time control, players, result, rated, link, view button.
This provides a reference for the data we display.

## Requirements

1. Create games library page at `src/app/games/page.tsx`:

    - Server component that fetches initial games
    - Client component for interactive filtering
    - Show loading skeleton while fetching

2. Create filter bar component `src/components/games/GamesFilter.tsx`:

    - Provider filter (All, Lichess, Chess.com)
    - Time class filter (All, Bullet, Blitz, Rapid, Classical)
    - Result filter (All, Wins, Losses, Draws)
    - Date range picker (Since, Until)
    - Analysis status (All, Analyzed, Not Analyzed)
    - Search by opponent name
    - Filters update URL query params for shareability

3. Create games list component `src/components/games/GamesList.tsx`:

    - Card-based layout (not table) for better mobile experience
    - Each card shows:
        - Result indicator (W/L/D with color)
        - Opponent name and rating
        - Your color (playing as White/Black)
        - Time control badge
        - Date played
        - Opening name (if available)
        - Accuracy (if analyzed)
        - Puzzle count (if any generated)
        - Actions: View, Analyze, Train Puzzles
    - Pagination controls at bottom
    - Empty state when no games

4. Create game card component `src/components/games/GameCard.tsx`:

    - Compact but informative design
    - Click anywhere to navigate to game detail
    - Quick action buttons

5. Add a "Sync New Games" button:

    - Opens modal to fetch new games from providers
    - Uses the existing fetch logic from page.tsx
    - Shows progress during fetch
    - Saves fetched games to database

6. Create unanalyzed games banner `src/components/games/UnanalyzedGamesBanner.tsx`:

    - Shows when there are games without analysis
    - Displays count: "X games need analysis"
    - Prominent banner/card at top of games list (in the sync section div.p-4)
    - Click opens game selection modal
    - User can select which games to analyze (checkboxes)
    - "Analyze Selected" button triggers batch analysis
    - Progress indicator for analysis queue
    - Dismissible but reappears if unanalyzed games remain

7. Create styles in `src/app/games/games.module.css`:
    - Responsive grid layout
    - Card styles matching app theme
    - Filter bar styling
    - Banner/prompt styling for unanalyzed games alert
    - Mobile-first approach

## Design Notes

-   Use the same color scheme as existing app
-   Result colors: Win (green), Loss (red), Draw (gray)
-   Provider icons or badges for Lichess/Chess.com
-   Subtle hover effects on cards
-   Unanalyzed games banner should be prominent but not intrusive (info/warning style)

## Acceptance Criteria

-   [ ] /games page renders with games from database
-   [ ] All filters work and update URL
-   [ ] Cards display all relevant game info
-   [ ] Pagination works correctly
-   [ ] Empty state shows when no games
-   [ ] "Sync New Games" fetches and saves games
-   [ ] Unanalyzed games banner shows when applicable
-   [ ] Game selection modal for batch analysis works
-   [ ] Batch analysis can be triggered from banner
-   [ ] Responsive on mobile
-   [ ] Loading states for async operations

```

---

## Task 2.3: Game Detail Page

**Branch:** `feat/2.3-game-detail-page`

**Merge into:** `feat/phase-2-games-library`

### Prompt

```

I'm building a Game Detail page to view a single analyzed game with its puzzles.

## Current State

-   Games library page exists at /games
-   The main page.tsx has a "Game viewer (PGN)" section (lines 831-930) with:
    -   Chessboard component
    -   Move navigation (Start, Back, Next, End)
    -   Move list with classification symbols
    -   Accuracy badges
-   PuzzlePanel component shows game context in "Game" tab

## Requirements

1. Create game detail page at `src/app/games/[id]/page.tsx`:

    - Load game from database by ID
    - Show 404 if game not found or not owned by user
    - Server component with client interactive parts

2. Create game viewer component `src/components/games/GameViewer.tsx`:

    - Refactor the viewer logic from page.tsx into reusable component
    - Props: game, analysis (optional), puzzles (optional)
    - Full-width board with responsive sizing
    - Move list panel (collapsible on mobile)

3. Create game header component `src/components/games/GameHeader.tsx`:

    - Player names with ratings
    - Result
    - Date and time control
    - Opening name
    - Link to original game on provider site
    - Accuracy badges (if analyzed)

4. Create game actions component `src/components/games/GameActions.tsx`:

    - "Analyze Game" button (if not analyzed)
    - "Re-analyze" option
    - "Generate Puzzles" button
    - "Train Puzzles" link (if puzzles exist)
    - "Delete Game" with confirmation
    - Export PGN button

5. Create puzzles preview section `src/components/games/GamePuzzlesPreview.tsx`:

    - List of puzzles generated from this game
    - Shows puzzle type, ply number, best move
    - Click to navigate to puzzle trainer with this puzzle

6. Integrate client-side analysis:

    - When user clicks "Analyze", run Stockfish analysis
    - Show progress indicator
    - Save results to database via API
    - Update UI when complete

7. Create analysis progress component `src/components/analysis/AnalysisProgress.tsx`:
    - Shows current game/ply being analyzed
    - Progress bar
    - Estimated time remaining
    - Cancel button

## Layout Structure

```
┌─────────────────────────────────────────────────────────────┐
│ [← Back to Games]              Game Header                  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────────────┐  ┌─────────────────────────────┐  │
│  │                     │  │ Move List                   │  │
│  │     Chessboard      │  │ 1. e4 e5                    │  │
│  │                     │  │ 2. Nf3 Nc6                  │  │
│  │                     │  │ ...                         │  │
│  └─────────────────────┘  │                             │  │
│  [Start][Back][Next][End] │ [Analyze] [Generate Puzzles]│  │
│                           └─────────────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│ Puzzles from this game (3)                                  │
│ ┌─────────┐ ┌─────────┐ ┌─────────┐                        │
│ │Puzzle 1 │ │Puzzle 2 │ │Puzzle 3 │                        │
│ └─────────┘ └─────────┘ └─────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

-   [ ] /games/[id] renders game details
-   [ ] Board displays correctly with navigation
-   [ ] Move list shows classifications if analyzed
-   [ ] Analyze button triggers client-side analysis
-   [ ] Analysis saves to database
-   [ ] Puzzles section shows related puzzles
-   [ ] All actions work (delete, export, etc.)
-   [ ] Responsive layout

```

---

## Task 2.4: Game Sync Flow Improvements

**Branch:** `feat/2.4-game-sync-flow`

**Merge into:** `feat/phase-2-games-library`

### Prompt

```

I'm improving the game sync flow to better handle fetching, saving, and analyzing games.

## Current State

-   Users can link Lichess/Chess.com accounts in settings
-   Main page has fetch functionality but doesn't persist to DB
-   Games list page has basic "Sync New Games" button

## Requirements

1. Create sync modal component `src/components/sync/SyncGamesModal.tsx`:

    - Step 1: Select source (Lichess, Chess.com, or Both)
    - Step 2: Configure filters (date range, time class, max games)
    - Step 3: Fetch progress with game count
    - Step 4: Review fetched games (show new vs already imported)
    - Step 5: Save confirmation
    - Show which games are new vs already in library

2. Create sync service `src/lib/services/gameSync.ts`:

    - `fetchNewGames(userId, options)` - Fetch games not yet in DB
    - `getLastSyncTime(userId, provider)` - Get timestamp of most recent game
    - `detectNewGames(userId)` - Quick check for new games since last sync
    - Use existing `/api/lichess/games` and `/api/chesscom/games` routes

3. Add "new games available" indicator:

    - On games page load, check if new games exist on providers
    - Show badge/banner: "5 new games available - Sync now"
    - Store last check time to avoid excessive API calls

4. Create batch analysis flow `src/components/analysis/BatchAnalysis.tsx`:

    - Reusable component for analyzing multiple games
    - Can be triggered from: UnanalyzedGamesBanner, game selection modal, or individual game actions
    - Accepts array of game IDs to analyze
    - Queue-based processing (analyze one at a time)
    - Progress for entire batch (shows: "Analyzing game 3/10 • Ply 15/42")
    - Option to generate puzzles after analysis completes
    - Runs client-side Stockfish (current approach)
    - Pause/Resume/Cancel controls
    - Results summary when complete

5. Update games list to show analysis status clearly:

    - Visual indicator on each game card (badge or icon)
    - "Analyzed" badge (green) vs "Needs Analysis" badge (yellow/orange)
    - Show last synced timestamp
    - Display total "X games pending analysis" count at top
    - Quick filter for "needs analysis" in filter bar
    - Analysis status visible without hovering

6. Add smart defaults:

    - Remember last used sync filters
    - Default date range to "since last sync"
    - Pre-select user's linked platforms

7. Handle rate limiting gracefully:
    - Lichess and Chess.com have rate limits
    - Show appropriate messages if rate limited
    - Suggest waiting or reducing request size

## Acceptance Criteria

-   [ ] Sync modal guides user through process
-   [ ] Only new games are fetched (not duplicates)
-   [ ] Batch analysis works for multiple games
-   [ ] Progress indicators throughout
-   [ ] "New games available" detection works
-   [ ] Rate limiting handled gracefully
-   [ ] Last sync time displayed and used

```

---

# Phase 3: Puzzle Trainer

## Task 3.1: Puzzles API Endpoints

**Branch:** `feat/3.1-puzzles-api`

**Merge into:** `feat/phase-3-puzzle-trainer`

### Prompt

```

I'm building API endpoints to manage chess puzzles in my app.

## Current State

-   Prisma schema has Puzzle and PuzzleAttempt models
-   Puzzles are generated client-side from analyzed games
-   Currently puzzles only exist in React state

## Existing Puzzle Type (from src/lib/analysis/puzzles.ts)

```typescript
type Puzzle = {
    id: string;
    sourceGameId: string;
    sourcePly: number;
    fen: string;
    type: 'avoidBlunder' | 'punishBlunder';
    severity?: string;
    bestMoveUci: string;
    bestLineUci: string[];
    score: { type: 'cp' | 'mate'; value: number };
    tags?: string[];
    opening?: { eco?: string; name?: string; variation?: string };
    label?: string;
};
```

## Requirements

1. Create puzzles API routes:

    `src/app/api/puzzles/route.ts`:

    - GET: List user's puzzles with filters and pagination
        - Query params: page, limit, type, gameId, opening, tags, solved, failed
        - Include attempt stats (times attempted, success rate)
        - Return: { puzzles: Puzzle[], total, page, totalPages }
    - POST: Save puzzles (batch)
        - Body: { puzzles: Puzzle[] }
        - Upsert based on (gameId, sourcePly, fen)
        - Return: { saved: number, duplicates: number }

    `src/app/api/puzzles/[id]/route.ts`:

    - GET: Get single puzzle with attempts history
    - DELETE: Remove puzzle

    `src/app/api/puzzles/[id]/attempt/route.ts`:

    - POST: Record a puzzle attempt
        - Body: { userMoveUci: string, wasCorrect: boolean, timeSpentMs?: number }
        - Return: Updated puzzle stats

    `src/app/api/puzzles/random/route.ts`:

    - GET: Get random puzzle(s) for training
        - Query params: count, type, excludeIds, preferFailed
        - Weighted towards puzzles user hasn't solved
        - Return: Puzzle[]

    `src/app/api/puzzles/stats/route.ts`:

    - GET: Get user's puzzle statistics
        - Total puzzles, solved, failed, success rate
        - Breakdown by type, opening, time period
        - Recent activity

2. Create data transformation utilities:

    `src/lib/api/puzzles.ts`:

    - `puzzleToDb(puzzle: Puzzle, userId: string, gameId: string)`
    - `dbToPuzzle(dbPuzzle)`
    - `aggregatePuzzleStats(attempts: PuzzleAttempt[])`

3. Create client-side hooks:

    `src/lib/api/usePuzzles.ts`:

    - `usePuzzles(filters)` - List with refetch
    - `usePuzzle(id)` - Single puzzle
    - `useRandomPuzzles(count)` - For training
    - `useRecordAttempt()` - Mutation
    - `usePuzzleStats()` - User stats

4. Add puzzle generation integration:
    - After analysis completes, save generated puzzles via API
    - Link puzzles to their source game in database

## Acceptance Criteria

-   [ ] All CRUD endpoints work correctly
-   [ ] Puzzles scoped to authenticated user
-   [ ] Attempts are recorded and tracked
-   [ ] Random puzzle selection works with weighting
-   [ ] Stats endpoint returns accurate data
-   [ ] Client hooks function properly
-   [ ] Proper error handling

```

---

## Task 3.2: Puzzle Attempt Tracking

**Branch:** `feat/3.2-puzzle-attempts-tracking`

**Merge into:** `feat/phase-3-puzzle-trainer`

### Prompt

```

I'm adding puzzle attempt tracking to measure user progress and enable spaced repetition.

## Current State

-   Puzzles API endpoints exist
-   PuzzleAttempt model in Prisma
-   PuzzlePanel component handles solving but doesn't persist attempts

## Current PuzzlePanel behavior (src/app/puzzle/PuzzlePanel.tsx)

-   User makes a move on the board
-   Compared against bestMoveUci
-   Shows "Correct!" or "Not best" message
-   Can reset and try again
-   No persistence

## Requirements

1. Update PuzzlePanel to record attempts:

    - On first attempt (not reset), call attempt API
    - Track time from puzzle load to first move
    - Don't record subsequent attempts after reset (or record separately)

2. Create attempt recording hook `src/lib/hooks/usePuzzleAttempt.ts`:

    - `startAttempt(puzzleId)` - Begin timing
    - `recordAttempt(puzzleId, move, correct)` - Save attempt
    - Handle offline/error gracefully
    - Debounce to prevent double-submissions

3. Add attempt history to puzzle detail:

    - Show previous attempts on this puzzle
    - Times attempted, success rate
    - Last attempted date

4. Create streak tracking:

    - Daily puzzle streak (solved at least one puzzle)
    - Current streak count
    - Best streak
    - Store in User preferences or separate model

5. Add visual feedback for recorded attempts:

    - Small indicator that attempt was saved
    - Don't interrupt the solving flow
    - Error indicator if save failed (with retry)

6. Create attempt stats component `src/components/puzzles/PuzzleAttemptStats.tsx`:

    - Your history with this puzzle
    - Average time to solve
    - Success rate

7. Update puzzle list to show attempt status:
    - Never attempted
    - Attempted but failed
    - Solved
    - Visual indicators (icons/colors)

## Acceptance Criteria

-   [ ] Attempts recorded automatically on first solve
-   [ ] Time tracking works accurately
-   [ ] Multiple attempts tracked separately
-   [ ] Streak tracking functional
-   [ ] Attempt history viewable
-   [ ] Offline attempts queued for later
-   [ ] Visual feedback for save status
-   [ ] Puzzle list shows attempt status

```

---

## Task 3.3: Dedicated Puzzle Trainer Page

**Branch:** `feat/3.3-puzzle-trainer-page`

**Merge into:** `feat/phase-3-puzzle-trainer`

### Prompt

```

I'm building a dedicated puzzle training page for focused practice.

## Current State

-   PuzzlePanel component exists and handles puzzle solving
-   Puzzles API with random puzzle endpoint
-   Attempt tracking implemented

## Current PuzzlePanel (src/app/puzzle/PuzzlePanel.tsx)

-   Shows puzzle board with move interaction
-   Has "Puzzle" and "Game" tabs
-   Line explorer for reviewing
-   Various toggle options

## Requirements

1. Create puzzle trainer page `src/app/puzzles/page.tsx`:

    - Clean, focused UI (minimize distractions)
    - Large board centered on screen
    - Essential controls only

2. Create trainer layout `src/components/puzzles/PuzzleTrainer.tsx`:

    - Board (largest element)
    - Puzzle info bar (type, opening, difficulty indicator)
    - Result feedback (correct/incorrect)
    - Next puzzle button
    - Skip puzzle option
    - Session stats (current session: X solved, Y% accuracy)

3. Create training modes:

    - **Quick Play**: Random puzzles, infinite
    - **Timed Session**: X puzzles or Y minutes
    - **Review Failed**: Prioritize previously failed puzzles
    - **Opening Focus**: Filter by specific opening
    - **Game Puzzles**: Puzzles from a specific game

4. Create mode selector `src/components/puzzles/TrainingModeSelector.tsx`:

    - Cards for each mode
    - Show relevant stats per mode
    - Start training button

5. Create session summary `src/components/puzzles/SessionSummary.tsx`:

    - Shown when session ends
    - Puzzles attempted, solved, accuracy
    - Time spent
    - Comparison to previous sessions
    - "Train More" or "View All Puzzles" actions

6. Optimize for keyboard:

    - Arrow keys for move navigation (after solve)
    - Space for next puzzle
    - Enter to confirm move
    - Escape to skip

7. Create mini puzzle view for quick navigation:

    - Thumbnail board showing position
    - Used when selecting specific puzzle to train

8. Mobile optimizations:
    - Full-screen board option
    - Swipe for next/previous
    - Bottom sheet for puzzle info

## Layout (Desktop)

```
┌─────────────────────────────────────────────────────────────┐
│ Puzzle Trainer           Session: 5/10 solved (83%)    [X]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│              ┌─────────────────────────┐                    │
│              │                         │                    │
│              │       Chessboard        │                    │
│              │                         │                    │
│              │                         │                    │
│              └─────────────────────────┘                    │
│                                                             │
│              White to move • Find the best move             │
│                                                             │
│              [Skip]                      [Next Puzzle →]    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

-   [ ] /puzzles page with mode selection
-   [ ] Quick Play mode works with random puzzles
-   [ ] Timed session mode with countdown
-   [ ] Review Failed mode prioritizes failed puzzles
-   [ ] Session stats tracked and displayed
-   [ ] Session summary on completion
-   [ ] Keyboard shortcuts functional
-   [ ] Mobile-friendly layout
-   [ ] Smooth transitions between puzzles

```

---

## Task 3.4: Puzzle Sessions & History

**Branch:** `feat/3.4-puzzle-sessions`

**Merge into:** `feat/phase-3-puzzle-trainer`

### Prompt

```

I'm adding puzzle session tracking to help users see their training history.

## Current State

-   Puzzle trainer page exists
-   Individual attempts are tracked
-   No concept of "sessions" grouping attempts

## Requirements

1. Create PuzzleSession model (update Prisma schema):

    ```prisma
    model PuzzleSession {
      id          String   @id @default(uuid())
      userId      String
      user        User     @relation(fields: [userId], references: [id])
      startedAt   DateTime @default(now())
      endedAt     DateTime?
      mode        String   // 'quick', 'timed', 'review', 'opening', 'game'
      config      Json?    // mode-specific config (time limit, opening filter, etc.)
      puzzleCount Int      @default(0)
      solvedCount Int      @default(0)
      totalTimeMs Int      @default(0)
      attempts    PuzzleAttempt[]
    }
    ```

2. Update PuzzleAttempt to link to session:

    - Add optional sessionId foreign key
    - Attempts can exist without session (quick single puzzle)

3. Create session API endpoints:

    `src/app/api/puzzles/sessions/route.ts`:

    - GET: List user's sessions with stats
    - POST: Start new session

    `src/app/api/puzzles/sessions/[id]/route.ts`:

    - GET: Session details with attempts
    - PATCH: Update session (end it, update stats)

    `src/app/api/puzzles/sessions/[id]/complete/route.ts`:

    - POST: Mark session complete, calculate final stats

4. Create session history page `src/app/puzzles/history/page.tsx`:

    - List of past sessions
    - Filter by date range, mode
    - Click to view session details

5. Create session detail view `src/components/puzzles/SessionDetail.tsx`:

    - All puzzles attempted in session
    - Correct/incorrect indicators
    - Time per puzzle
    - Review any puzzle from session

6. Create session hooks:

    - `useCreateSession(mode, config)`
    - `useCurrentSession()`
    - `useEndSession()`
    - `useSessionHistory(filters)`

7. Integrate sessions into trainer:

    - Create session on training start
    - Link attempts to current session
    - End session on completion or exit
    - Prompt if leaving mid-session

8. Create calendar heatmap component `src/components/puzzles/ActivityCalendar.tsx`:
    - GitHub-style contribution graph
    - Shows puzzle activity by day
    - Darker = more puzzles solved

## Acceptance Criteria

-   [ ] Sessions created when training starts
-   [ ] Attempts linked to sessions
-   [ ] Session ends properly (explicit or on exit)
-   [ ] History page shows past sessions
-   [ ] Session details viewable
-   [ ] Activity calendar displays correctly
-   [ ] Stats accurate across sessions

```

---

# Phase 4: Dashboard & Insights

## Task 4.1: Stats Aggregation API

**Branch:** `feat/4.1-stats-api`

**Merge into:** `feat/phase-4-dashboard`

### Prompt

```

I'm building statistics aggregation for the dashboard and insights pages.

## Current State

-   Games, puzzles, and attempts are stored in database
-   Basic puzzle stats endpoint exists
-   No comprehensive analytics

## Requirements

1. Create comprehensive stats API:

    `src/app/api/stats/overview/route.ts`:

    - Total games analyzed
    - Total puzzles generated
    - Puzzles solved / attempted
    - Overall accuracy
    - Current streak
    - Best streak
    - Member since

    `src/app/api/stats/accuracy/route.ts`:

    - Accuracy over time (daily/weekly/monthly)
    - Accuracy by opening
    - Accuracy by puzzle type
    - Accuracy by time control

    `src/app/api/stats/openings/route.ts`:

    - Most played openings
    - Win rate by opening
    - Blunder frequency by opening
    - Puzzles generated per opening

    `src/app/api/stats/activity/route.ts`:

    - Games played over time
    - Puzzles solved over time
    - Daily activity for calendar heatmap
    - Time of day patterns

    `src/app/api/stats/blunders/route.ts`:

    - Most common blunder types
    - Blunder frequency over time
    - Game phase analysis (opening/middlegame/endgame)
    - Time pressure correlation (moves before time trouble)

2. Create stats calculation utilities `src/lib/stats/`:

    - `calculateAccuracy.ts` - Various accuracy calculations
    - `aggregateByPeriod.ts` - Group data by day/week/month
    - `openingStats.ts` - Opening-specific calculations
    - `streakCalculator.ts` - Streak logic

3. Add caching for expensive calculations:

    - Cache stats with reasonable TTL
    - Invalidate on new data
    - Consider background recalculation

4. Create stats hooks:

    - `useOverviewStats()`
    - `useAccuracyTrend(period)`
    - `useOpeningStats()`
    - `useActivityData(range)`
    - `useBlunderAnalysis()`

5. Return data in chart-friendly formats:
    - Time series as { date, value }[]
    - Categories as { label, value }[]
    - Include metadata (totals, averages)

## Acceptance Criteria

-   [ ] All stats endpoints return accurate data
-   [ ] Performance acceptable (<500ms for most queries)
-   [ ] Empty states handled (new users)
-   [ ] Data formats suitable for charting
-   [ ] Caching implemented for expensive queries
-   [ ] Hooks work correctly

```

---

## Task 4.2: Dashboard Page

**Branch:** `feat/4.2-dashboard-page`

**Merge into:** `feat/phase-4-dashboard`

### Prompt

```

I'm building the main dashboard - the home page for logged-in users.

## Current State

-   Stats API endpoints exist
-   Games and puzzles pages exist
-   No dashboard yet (users go directly to main page)

## Requirements

1. Create dashboard page `src/app/dashboard/page.tsx`:

    - Server component with data fetching
    - Client components for interactive elements
    - Redirect non-authenticated users to /login

2. Create welcome section:

    - Personalized greeting with user name
    - Current streak indicator (fire emoji + count)
    - Quick stats row (games, puzzles, accuracy)

3. Create "Continue Training" section `src/components/dashboard/ContinueTraining.tsx`:

    - 2-3 puzzle cards ready to solve
    - Mix of: failed puzzles to retry, unsolved, random
    - "Start Training" button for full trainer

4. Create "New Games" section `src/components/dashboard/NewGamesPrompt.tsx`:

    - Check for new games on providers
    - "X new games available" message
    - Quick sync button
    - Last synced timestamp

5. Create recent activity section `src/components/dashboard/RecentActivity.tsx`:

    - Recent games analyzed
    - Recent puzzles solved
    - Timeline format

6. Create quick stats cards `src/components/dashboard/StatCard.tsx`:

    - Reusable stat card component
    - Icon, label, value, optional trend indicator
    - Used for: total games, puzzles solved, accuracy, streak

7. Create mini activity chart `src/components/dashboard/ActivityMiniChart.tsx`:

    - Small chart showing last 7 days activity
    - Links to full insights page

8. Add navigation shortcuts:

    - "View All Games" link
    - "View All Puzzles" link
    - "See Insights" link

9. Handle empty states:
    - New user with no games → Prompt to link accounts and sync
    - Has games but no puzzles → Prompt to analyze and generate
    - Everything empty → Onboarding flow

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  👋 Welcome back, Adam!                        🔥 7 day streak│
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │ 48 Games│ │142 Puzz │ │ 78% Acc │ │ 7 Streak│            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
├─────────────────────────────────────────────────────────────┤
│  📥 3 new games available since yesterday                    │
│     [Sync Now]                                               │
├─────────────────────────────────────────────────────────────┤
│  Continue Training                          [Start Session →]│
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│  │ [Puzzle 1]  │ │ [Puzzle 2]  │ │ [Puzzle 3]  │            │
│  │ Retry       │ │ New         │ │ New         │            │
│  └─────────────┘ └─────────────┘ └─────────────┘            │
├─────────────────────────────────────────────────────────────┤
│  Recent Activity                            [See Insights →] │
│  • Solved 5 puzzles (Today)                                  │
│  • Analyzed game vs Magnus (Yesterday)                       │
│  • Generated 3 new puzzles (Yesterday)                       │
└─────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

-   [ ] Dashboard loads with user data
-   [ ] Stat cards show accurate numbers
-   [ ] Continue training shows relevant puzzles
-   [ ] New games detection works
-   [ ] Recent activity displays correctly
-   [ ] Empty states handled gracefully
-   [ ] Responsive layout
-   [ ] Navigation to other pages works

```

---

## Task 4.3: Insights Page

**Branch:** `feat/4.3-insights-page`

**Merge into:** `feat/phase-4-dashboard`

### Prompt

```

I'm building an Insights page with detailed analytics about the user's chess performance.

## Current State

-   Stats API endpoints exist
-   Dashboard with quick stats exists
-   Need detailed analytics view

## Requirements

1. Create insights page `src/app/insights/page.tsx`:

    - Multiple chart sections
    - Filter by date range (7d, 30d, 90d, 1y, all)
    - Tab navigation for different insight categories

2. Install charting library:

    - Recommend: recharts (React-friendly, lightweight)
    - Alternative: chart.js with react-chartjs-2

3. Create accuracy trend chart `src/components/insights/AccuracyTrend.tsx`:

    - Line chart showing accuracy over time
    - Compare to previous period
    - Hover for details

4. Create opening performance chart `src/components/insights/OpeningPerformance.tsx`:

    - Bar chart of most played openings
    - Color by win rate
    - Click to filter games/puzzles by opening

5. Create puzzle progress chart `src/components/insights/PuzzleProgress.tsx`:

    - Cumulative puzzles solved over time
    - Success rate trend
    - Comparison line for attempts

6. Create blunder analysis section `src/components/insights/BlunderAnalysis.tsx`:

    - Pie chart: blunder types (tactical, positional, time pressure)
    - Blunder frequency by game phase
    - Most common blunder patterns

7. Create activity heatmap `src/components/insights/ActivityHeatmap.tsx`:

    - GitHub-style calendar
    - Color intensity = puzzles solved
    - Tooltip with exact numbers

8. Create time-based analysis `src/components/insights/TimeAnalysis.tsx`:

    - Best time of day to play (by win rate)
    - Performance by day of week
    - Time pressure analysis

9. Create comparison cards `src/components/insights/ComparisonCard.tsx`:

    - This week vs last week
    - This month vs last month
    - Show improvement/decline with arrows

10. Create insight summary `src/components/insights/InsightSummary.tsx`:
    - AI-generated text insights (or rule-based)
    - "You blunder most in the Sicilian Defense"
    - "Your accuracy has improved 5% this month"
    - Actionable suggestions

## Layout

```
┌─────────────────────────────────────────────────────────────┐
│  Insights                    [7d] [30d] [90d] [1y] [All]    │
├─────────────────────────────────────────────────────────────┤
│  Summary                                                     │
│  "Your accuracy improved 5% this month. Most blunders occur │
│   in the Sicilian Defense - consider training those puzzles"│
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────┐│
│  │ Accuracy Trend                                 📈 +5%   ││
│  │ [Line Chart]                                            ││
│  └─────────────────────────────────────────────────────────┘│
├──────────────────────────────┬──────────────────────────────┤
│  Opening Performance         │  Puzzle Progress             │
│  [Bar Chart]                 │  [Line Chart]                │
├──────────────────────────────┴──────────────────────────────┤
│  Activity Calendar                                           │
│  [Heatmap]                                                   │
├─────────────────────────────────────────────────────────────┤
│  Blunder Analysis                                            │
│  [Pie Chart]  [Bar Chart by Phase]                          │
└─────────────────────────────────────────────────────────────┘
```

## Acceptance Criteria

-   [ ] All charts render with real data
-   [ ] Date range filter works
-   [ ] Charts are interactive (hover, click)
-   [ ] Summary insights generated
-   [ ] Empty states for insufficient data
-   [ ] Responsive (charts resize)
-   [ ] Loading states for data fetch
-   [ ] Performance acceptable

```

---

# Phase 5: Enhancements

## Task 5.1: Automatic Game Sync

**Branch:** `feat/5.1-auto-sync`

**Merge into:** `feat/phase-5-enhancements`

### Prompt

```

I'm adding automatic background sync to fetch new games periodically.

## Current State

-   Manual sync via button click
-   Games saved to database
-   Users have linked chess accounts

## Requirements

1. Choose background job solution:

    - Option A: Vercel Cron (if deployed on Vercel)
    - Option B: Inngest (recommended for complex workflows)
    - Option C: Simple API route + external cron (Uptime Robot, etc.)

2. Create sync job `src/jobs/syncGames.ts` (or appropriate location):

    - Fetch all users with linked accounts
    - For each user, fetch games since last sync
    - Save new games to database
    - Update lastSyncAt timestamp
    - Handle rate limits gracefully

3. Create sync API endpoint `src/app/api/cron/sync-games/route.ts`:

    - Protected by secret key (CRON_SECRET)
    - Triggers sync for all users (or subset)
    - Returns summary of sync results

4. Add per-user sync preferences:

    - Enable/disable auto-sync (default: enabled)
    - Sync frequency preference (hourly, daily)
    - Add to User preferences JSON

5. Create notification system (basic):

    - Store notifications in database
    - "5 new games synced" type messages
    - Show notification badge in UI

6. Create notifications API:

    `src/app/api/notifications/route.ts`:

    - GET: List user's notifications
    - POST: Mark as read

7. Add notification bell to header `src/components/layout/NotificationBell.tsx`:

    - Badge with unread count
    - Dropdown with recent notifications
    - "Mark all read" action

8. Handle sync conflicts:
    - Game already exists → skip
    - User preferences changed → respect new settings
    - Account unlinked → skip that provider

## Cron Schedule

-   Check for new games every 6 hours
-   Per-user rate limiting (max 1 sync per hour per user)
-   Stagger syncs to avoid provider rate limits

## Acceptance Criteria

-   [ ] Cron job runs on schedule
-   [ ] New games fetched automatically
-   [ ] User can enable/disable auto-sync
-   [ ] Notifications created for new games
-   [ ] Notification UI works
-   [ ] Rate limits respected
-   [ ] Errors handled gracefully

```

---

## Task 5.2: Spaced Repetition for Puzzles

**Branch:** `feat/5.2-spaced-repetition`

**Merge into:** `feat/phase-5-enhancements`

### Prompt

```

I'm implementing spaced repetition to help users learn from their mistakes more effectively.

## Current State

-   Puzzle attempts tracked
-   Random puzzle selection available
-   No learning algorithm

## Requirements

1. Implement SM-2 algorithm (or simplified version):

    - Track ease factor per puzzle
    - Calculate next review date
    - Prioritize due puzzles in training

2. Add SRS fields to Puzzle model:

    ```prisma
    // Add to Puzzle model
    easeFactor      Float     @default(2.5)
    interval        Int       @default(0)  // days
    nextReviewAt    DateTime?
    repetitions     Int       @default(0)
    ```

3. Create SRS calculation utility `src/lib/srs/`:

    - `calculateNextReview(puzzle, wasCorrect, timeSpent)`
    - `getPuzzlesDueForReview(userId, limit)`
    - `updatePuzzleSRS(puzzleId, attemptResult)`

4. Update attempt recording to update SRS:

    - On correct: increase interval, maybe increase ease
    - On incorrect: reset interval, decrease ease
    - Consider time spent (very fast = maybe too easy)

5. Create "Review Due" training mode:

    - Shows puzzles due for review
    - Sorted by due date (most overdue first)
    - Badge showing count of due puzzles

6. Add review stats to dashboard:

    - Puzzles due today
    - Upcoming reviews (next 7 days)
    - Review streak

7. Create review forecast chart `src/components/insights/ReviewForecast.tsx`:

    - Shows expected reviews per day
    - Helps user plan study time

8. Add SRS settings to preferences:
    - Enable/disable SRS
    - New puzzle interval (default: 1 day)
    - Maximum interval (default: 365 days)

## SRS Logic (Simplified SM-2)

```typescript
function calculateNext(
    correct: boolean,
    currentEase: number,
    currentInterval: number
) {
    if (!correct) {
        return { interval: 1, ease: Math.max(1.3, currentEase - 0.2) };
    }

    const newEase = currentEase + 0.1;
    const newInterval =
        currentInterval === 0 ? 1 : Math.round(currentInterval * newEase);

    return {
        interval: Math.min(newInterval, 365),
        ease: Math.min(newEase, 3.0),
    };
}
```

## Acceptance Criteria

-   [ ] SRS fields added to puzzle model
-   [ ] Next review calculated correctly
-   [ ] Due puzzles surfaced in training
-   [ ] Dashboard shows due count
-   [ ] Review forecast displays
-   [ ] Settings allow customization
-   [ ] Migration doesn't break existing puzzles

```

---

## Task 5.3: PWA Support

**Branch:** `feat/5.3-pwa-support`

**Merge into:** `feat/phase-5-enhancements`

### Prompt

```

I'm adding Progressive Web App support for offline puzzle training and app installation.

## Current State

-   Standard Next.js web app
-   Works only online
-   Not installable

## Requirements

1. Install and configure next-pwa:

    - `npm install next-pwa`
    - Configure in next.config.ts

2. Create web manifest `public/manifest.json`:

    - App name: "BackRank"
    - Short name: "BackRank"
    - Theme color matching app
    - Icons in multiple sizes (192, 512)
    - Display: standalone
    - Start URL: /dashboard

3. Create app icons:

    - Design or use placeholder chess-themed icon
    - Generate sizes: 72, 96, 128, 144, 152, 192, 384, 512
    - Save to public/icons/

4. Configure service worker for caching:

    - Cache app shell (HTML, CSS, JS)
    - Cache static assets
    - Cache API responses for offline viewing
    - Network-first for fresh data when online

5. Add offline support for puzzles:

    - Cache current puzzle set for offline training
    - Queue attempts when offline
    - Sync attempts when back online

6. Create offline indicator `src/components/layout/OfflineIndicator.tsx`:

    - Shows when user is offline
    - Non-intrusive banner
    - "You're offline - some features limited"

7. Create install prompt `src/components/pwa/InstallPrompt.tsx`:

    - Detect if PWA is installable
    - Show "Add to Home Screen" prompt
    - Dismissible, don't show again option
    - Show on mobile primarily

8. Update meta tags in layout:

    - Add manifest link
    - Add theme-color meta tag
    - Add apple-touch-icon links
    - Add iOS-specific meta tags

9. Create offline page `src/app/offline/page.tsx`:

    - Shown when navigating to uncached page while offline
    - Friendly message
    - Links to cached content (puzzles)

10. Test PWA functionality:
    - Lighthouse PWA audit
    - Install on mobile device
    - Test offline scenarios

## Service Worker Caching Strategy

```javascript
// Cache strategies by route
{
  '/api/puzzles/random': 'NetworkFirst',      // Fresh puzzles when possible
  '/api/stats/*': 'StaleWhileRevalidate',     // Stats can be slightly stale
  '/_next/static/*': 'CacheFirst',            // Static assets
  '/icons/*': 'CacheFirst',                   // Icons
}
```

## Acceptance Criteria

-   [ ] App installable on mobile and desktop
-   [ ] Manifest configured correctly
-   [ ] Icons display properly
-   [ ] Offline indicator shows when disconnected
-   [ ] Puzzles playable offline (cached set)
-   [ ] Attempts sync when back online
-   [ ] Lighthouse PWA score > 90
-   [ ] Install prompt shows appropriately

````

---

# Appendix

## A. Environment Variables Reference

```bash
# .env.local.example

# Database (Supabase)
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
DATABASE_URL=

# Auth (NextAuth.js)
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=

# OAuth Providers
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_ID=
GITHUB_SECRET=

# Cron Jobs
CRON_SECRET=

# Optional: Analytics
NEXT_PUBLIC_POSTHOG_KEY=
````

## B. Recommended Package Additions

```json
{
    "dependencies": {
        "@auth/prisma-adapter": "^1.0.0",
        "@prisma/client": "^5.0.0",
        "@supabase/ssr": "^0.1.0",
        "@supabase/supabase-js": "^2.0.0",
        "next-auth": "^5.0.0-beta",
        "next-pwa": "^5.6.0",
        "recharts": "^2.10.0",
        "sonner": "^1.0.0",
        "zustand": "^4.4.0"
    },
    "devDependencies": {
        "prisma": "^5.0.0"
    }
}
```

## C. File Structure After Implementation

```
src/
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/
│   │   ├── cron/
│   │   ├── games/
│   │   ├── notifications/
│   │   ├── puzzles/
│   │   ├── stats/
│   │   └── user/
│   ├── dashboard/
│   ├── games/
│   │   └── [id]/
│   ├── insights/
│   ├── login/
│   ├── offline/
│   ├── puzzles/
│   │   └── history/
│   └── settings/
├── components/
│   ├── analysis/
│   ├── auth/
│   ├── dashboard/
│   ├── games/
│   ├── insights/
│   ├── layout/
│   ├── migration/
│   ├── pwa/
│   ├── puzzles/
│   ├── settings/
│   └── sync/
├── lib/
│   ├── api/
│   ├── auth/
│   ├── hooks/
│   ├── migration/
│   ├── preferences/
│   ├── prisma/
│   ├── services/
│   ├── srs/
│   ├── stats/
│   └── supabase/
└── jobs/
```

## D. Testing Checklist

After each phase, verify:

-   [ ] All new pages load without errors
-   [ ] Authentication flow works
-   [ ] Data persists correctly
-   [ ] Mobile responsive
-   [ ] No TypeScript errors
-   [ ] No console errors
-   [ ] API endpoints return expected data
-   [ ] Error states handled

## E. Deployment Considerations

1. **Database**: Run migrations before deploying new schema
2. **Environment**: Ensure all env vars set in production
3. **OAuth**: Update callback URLs for production domain
4. **Cron**: Configure cron jobs in hosting platform
5. **PWA**: Test install flow in production
