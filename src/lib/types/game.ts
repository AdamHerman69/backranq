export const GAME_SOURCES = [
    'lichess',
    'chesscom',
    'manual_pgn',
    'backranq_coach',
] as const;
export type GameSource = (typeof GAME_SOURCES)[number];

export const SYNC_PROVIDERS = ['lichess', 'chesscom'] as const;
export type SyncProvider = (typeof SYNC_PROVIDERS)[number];

export function isGameSource(value: unknown): value is GameSource {
    return GAME_SOURCES.includes(value as GameSource);
}

export function isSyncProvider(value: unknown): value is SyncProvider {
    return SYNC_PROVIDERS.includes(value as SyncProvider);
}

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';

export type NormalizedPlayer = {
    name: string;
    rating?: number;
};

export type NormalizedGameProvenance = {
    /** Provider username requested for this import, snapshotted at fetch time. */
    username: string;
    /** Provider-owned stable account identifier, when the API exposes one. */
    accountId?: string;
    userSide: 'white' | 'black' | 'unknown';
    /** Provider-native time-control value plus exact parsed clock fields. */
    timeControl?: {
        raw?: string;
        initialSeconds?: number;
        incrementSeconds?: number;
    };
};

export type NormalizedGame = {
    id: string;
    provider: GameSource;
    url?: string;
    playedAt: string; // ISO
    timeClass: TimeClass;
    rated?: boolean;
    white: NormalizedPlayer;
    black: NormalizedPlayer;
    /**
     * PGN header tags (best-effort). Example: "1-0", "0-1", "1/2-1/2", "*".
     * Providers typically include this in the PGN, but we parse it so the UI can display it.
     */
    result?: string;
    /**
     * Optional PGN "Termination" tag (best-effort), e.g. "Normal", "Time forfeit".
     */
    termination?: string;
    pgn: string;
    provenance?: NormalizedGameProvenance;
};
