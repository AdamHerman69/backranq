export const MAX_COACH_GAME_PGN_BYTES = 256 * 1024;
export const MAX_COACH_SESSION_ID_LENGTH = 128;
export const COACH_PLAYER_NAME = 'Backranq Player';
export const COACH_OPPONENT_NAME = 'Backranq Coach';

export type CompletedCoachGamePayload = {
    sessionId: string;
    pgn: string;
    userSide: 'white' | 'black';
    completedAt: string;
};

export type SavedCoachGame = {
    ownerId: string;
    gameId: string;
    created: boolean;
    needsAnalysis: boolean;
};
