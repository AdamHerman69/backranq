import { describe, expect, it } from 'vitest';

import {
    deriveMaiaOpponentSeed,
    getOpponentProfile,
    MAIA_OPPONENT_DEFAULT_ELO,
    MAIA_OPPONENT_MAX_ELO,
    MAIA_OPPONENT_MIN_ELO,
    normalizeMaiaOpponentElo,
    OPPONENT_PROFILE_IDS,
    OPPONENT_PROFILES,
} from '@/lib/coach/profiles';

describe('coach profiles', () => {
    it('publishes one complete, uniquely addressable opponent profile per id', () => {
        expect(OPPONENT_PROFILES.map((profile) => profile.id)).toEqual(
            OPPONENT_PROFILE_IDS
        );
        expect(new Set(OPPONENT_PROFILE_IDS).size).toBe(
            OPPONENT_PROFILE_IDS.length
        );

        for (const id of OPPONENT_PROFILE_IDS) {
            const profile = getOpponentProfile(id);
            expect(profile.id).toBe(id);
            expect(profile.label).not.toBe('');
            expect(profile.description).not.toBe('');
            expect(profile.maxWinningChanceLoss).toBeGreaterThanOrEqual(0);
            expect(profile.maxWinningChanceLoss).toBeLessThanOrEqual(1);
            expect(profile.fallbackMaxCpLoss).toBeGreaterThanOrEqual(0);
            expect(profile.selectionBias).toBeGreaterThanOrEqual(0);
        }
    });

    it('tightens the acceptable opponent loss monotonically with difficulty', () => {
        const thresholds = OPPONENT_PROFILES.map(
            (profile) => profile.maxWinningChanceLoss
        );
        const fallbackThresholds = OPPONENT_PROFILES.map(
            (profile) => profile.fallbackMaxCpLoss
        );

        expect(thresholds).toEqual(
            thresholds.slice().sort((left, right) => right - left)
        );
        expect(fallbackThresholds).toEqual(
            fallbackThresholds
                .slice()
                .sort((left, right) => right - left)
        );
        expect(getOpponentProfile('maximum')).toMatchObject({
            maxWinningChanceLoss: 0,
            fallbackMaxCpLoss: 0,
            selectionBias: 0,
        });
    });

    it('normalizes Maia ratings to the supported serious-player range', () => {
        expect(normalizeMaiaOpponentElo('not-a-rating')).toBe(
            MAIA_OPPONENT_DEFAULT_ELO
        );
        expect(normalizeMaiaOpponentElo(0)).toBe(
            MAIA_OPPONENT_MIN_ELO
        );
        expect(normalizeMaiaOpponentElo(10_000)).toBe(
            MAIA_OPPONENT_MAX_ELO
        );
        expect(normalizeMaiaOpponentElo(1_524)).toBe(1_500);
        expect(normalizeMaiaOpponentElo(1_526)).toBe(1_550);
    });

    it('derives a stable unsigned Maia sampling seed per session and ply', () => {
        const first = deriveMaiaOpponentSeed('session-a', 7);
        expect(first).toBe(deriveMaiaOpponentSeed('session-a', 7));
        expect(first).not.toBe(
            deriveMaiaOpponentSeed('session-a', 8)
        );
        expect(first).not.toBe(
            deriveMaiaOpponentSeed('session-b', 7)
        );
        expect(first).toBeGreaterThanOrEqual(0);
        expect(first).toBeLessThanOrEqual(0xffff_ffff);
    });

});
