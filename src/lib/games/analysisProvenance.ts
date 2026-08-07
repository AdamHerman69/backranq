import type { NormalizedGame } from '@/lib/types/game';

export type ResolvedGameAnalysisProvenance = {
    sourceUsername: string;
    userSide: 'white' | 'black';
    userColor: 'w' | 'b';
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
