import type { NormalizedGame } from '@/lib/types/game';

export type ResolvedGameAnalysisProvenance = {
    sourceUsername: string;
    userSide: 'white' | 'black';
    userColor: 'w' | 'b';
};

export type FrozenStoredGamePerspective = {
    sourceUsername: string;
    userSide: 'WHITE' | 'BLACK' | 'UNKNOWN';
    whiteName: string;
    blackName: string;
};

function normalizedUsername(value: string | undefined | null) {
    return (value ?? '').trim().toLocaleLowerCase('en-US');
}

/** Resolves perspective exclusively from immutable import-time provenance. */
export function resolveGameAnalysisProvenance(
    game: NormalizedGame
): ResolvedGameAnalysisProvenance | null {
    const sourceUsername = game.provenance?.username.trim();
    const userSide = game.provenance?.userSide;
    if (!sourceUsername || (userSide !== 'white' && userSide !== 'black')) {
        return null;
    }
    const recordedPlayer =
        userSide === 'white' ? game.white.name : game.black.name;
    if (
        normalizedUsername(recordedPlayer) !==
        normalizedUsername(sourceUsername)
    ) {
        return null;
    }
    return {
        sourceUsername,
        userSide,
        userColor: userSide === 'white' ? 'w' : 'b',
    };
}

/** Revalidates the database snapshot before accepting analysis evidence. */
export function resolveStoredGameAnalysisProvenance(
    game: FrozenStoredGamePerspective
): ResolvedGameAnalysisProvenance | null {
    const sourceUsername = game.sourceUsername.trim();
    if (
        !sourceUsername ||
        (game.userSide !== 'WHITE' && game.userSide !== 'BLACK')
    ) {
        return null;
    }
    const recordedPlayer =
        game.userSide === 'WHITE' ? game.whiteName : game.blackName;
    if (
        normalizedUsername(recordedPlayer) !==
        normalizedUsername(sourceUsername)
    ) {
        return null;
    }
    return {
        sourceUsername,
        userSide: game.userSide === 'WHITE' ? 'white' : 'black',
        userColor: game.userSide === 'WHITE' ? 'w' : 'b',
    };
}
