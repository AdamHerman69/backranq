export type Provider = 'lichess' | 'chesscom';

export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'unknown';

export type NormalizedPlayer = {
    name: string;
    rating?: number;
};

export type NormalizedGame = {
    id: string;
    provider: Provider;
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
};
