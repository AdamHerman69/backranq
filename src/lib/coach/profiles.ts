export const OPPONENT_PROFILE_IDS = [
    'friendly',
    'club',
    'strong',
    'maximum',
] as const;

export type OpponentProfileId = (typeof OPPONENT_PROFILE_IDS)[number];

export type OpponentProfile = {
    id: OpponentProfileId;
    label: string;
    description: string;
    maxWinningChanceLoss: number;
    fallbackMaxCpLoss: number;
    selectionBias: number;
};

export const OPPONENT_PROFILES: readonly OpponentProfile[] = [
    {
        id: 'friendly',
        label: 'Friendly',
        description: 'Often chooses a playable alternative instead of the top line.',
        maxWinningChanceLoss: 0.18,
        fallbackMaxCpLoss: 220,
        selectionBias: 1.4,
    },
    {
        id: 'club',
        label: 'Club',
        description: 'Solid play with occasional second-best practical choices.',
        maxWinningChanceLoss: 0.08,
        fallbackMaxCpLoss: 100,
        selectionBias: 0.75,
    },
    {
        id: 'strong',
        label: 'Strong',
        description: 'Stays close to the best line and rarely gives ground.',
        maxWinningChanceLoss: 0.03,
        fallbackMaxCpLoss: 40,
        selectionBias: 0.25,
    },
    {
        id: 'maximum',
        label: 'Maximum',
        description: 'Always plays Stockfish’s first choice.',
        maxWinningChanceLoss: 0,
        fallbackMaxCpLoss: 0,
        selectionBias: 0,
    },
] as const;

export function getOpponentProfile(
    id: OpponentProfileId
): OpponentProfile {
    return (
        OPPONENT_PROFILES.find((profile) => profile.id === id) ??
        OPPONENT_PROFILES[1]!
    );
}
