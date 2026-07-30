import {
    MAIA_RECOMMENDED_ELO_DEFAULT,
    MAIA_RECOMMENDED_ELO_MAX,
    MAIA_RECOMMENDED_ELO_MIN,
} from '@/lib/coach/maia/metadata';

export const OPPONENT_PROFILE_IDS = [
    'friendly',
    'club',
    'strong',
    'maximum',
] as const;

export type OpponentProfileId = (typeof OPPONENT_PROFILE_IDS)[number];

export const COACH_OPPONENT_MODEL_IDS = [
    'stockfish',
    'maia3',
] as const;

export type CoachOpponentModelId =
    (typeof COACH_OPPONENT_MODEL_IDS)[number];

export const STOCKFISH_OPPONENT_REVISION =
    'stockfish-18.0.8:profiles-wdl-v1';
export const MAIA_OPPONENT_DEFAULT_ELO =
    MAIA_RECOMMENDED_ELO_DEFAULT;
export const MAIA_OPPONENT_MIN_ELO = MAIA_RECOMMENDED_ELO_MIN;
export const MAIA_OPPONENT_MAX_ELO = MAIA_RECOMMENDED_ELO_MAX;
export const MAIA_OPPONENT_ELO_STEP = 50;

export function normalizeMaiaOpponentElo(value: unknown): number {
    const parsed =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim()
              ? Number(value)
              : Number.NaN;
    if (!Number.isFinite(parsed)) return MAIA_OPPONENT_DEFAULT_ELO;
    const bounded = Math.max(
        MAIA_OPPONENT_MIN_ELO,
        Math.min(MAIA_OPPONENT_MAX_ELO, parsed)
    );
    return (
        Math.round(bounded / MAIA_OPPONENT_ELO_STEP) *
        MAIA_OPPONENT_ELO_STEP
    );
}

export function deriveMaiaOpponentSeed(
    sessionKey: string,
    ply: number
): number {
    const input = `${sessionKey}:${Math.max(0, Math.trunc(ply))}`;
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

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
