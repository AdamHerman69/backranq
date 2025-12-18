import type { Provider } from '@/lib/types/game';
import type { OpeningInfo } from '@/lib/chess/opening';

export type PuzzleType = 'blunder' | 'missedWin' | 'missedTactic';

export type PuzzleSeverity = 'small' | 'medium' | 'big';

export type PuzzleCategory = 'avoidBlunder' | 'punishBlunder';

export type GamePhase = 'opening' | 'middlegame' | 'endgame';

export type Puzzle = {
    id: string;
    /**
     * "Kind" of tactical moment (what happened in the game).
     * This is NOT the same as the puzzle category (avoid vs punish).
     */
    type: PuzzleType;
    /**
     * Puzzle category (who blundered / when the puzzle starts).
     * - avoidBlunder: position BEFORE user's mistake, find best/safe move
     * - punishBlunder: position AFTER opponent's mistake, find the punishment
     */
    mode: PuzzleCategory;
    provider: Provider;
    sourceGameId: string;
    sourcePly: number; // 0-based ply index at puzzle start (before the mistake)
    playedAt: string; // ISO
    fen: string;
    sideToMove: 'w' | 'b';
    bestLineUci: string[]; // PV UCI moves
    bestMoveUci: string;
    /**
     * Moves that should be accepted as "correct" for this puzzle (in UCI).
     * Used mainly for "avoid blunder" puzzles where multiple safe moves exist.
     *
     * Best move should always be considered accepted even if this is empty.
     */
    acceptedMovesUci?: string[];
    score:
        | { type: 'cp'; value: number }
        | { type: 'mate'; value: number }
        | null; // engine score at puzzle start
    label: string;
    /**
     * Lightweight tags derived from engine PV/score and simple chess.js heuristics.
     * Intended for UI filtering (in-browser, no extra engine calls).
     */
    tags: string[];
    /**
     * Opening classification for the source game (best-effort).
     * Used for grouping/filtering puzzles by opening in the UI.
     */
    opening?: OpeningInfo;
    /**
     * Rough importance bucket, primarily based on eval swing and mate presence.
     */
    severity?: PuzzleSeverity;
    /**
     * Rough phase bucket for the puzzle start position.
     */
    phase?: GamePhase;
};
