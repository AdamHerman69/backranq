import { describe, expect, it } from 'vitest';

import { normalizeApiDbGameToNormalized } from '@/lib/analysis/backgroundAnalysisManager';

describe('Coach background-analysis provenance', () => {
    it('carries the immutable stored side into the extractor input', () => {
        const normalized = normalizeApiDbGameToNormalized({
            provider: 'BACKRANQ_COACH',
            externalId: 'coach-game-1',
            url: null,
            playedAt: '2026-08-04T12:00:00.000Z',
            timeClass: 'UNKNOWN',
            rated: false,
            result: '0-1',
            termination: 'Checkmate',
            whiteName: 'Backranq Player',
            whiteRating: null,
            blackName: 'Backranq Coach',
            blackRating: null,
            pgn: '1. f3 e5 2. g4 Qh4# 0-1',
            sourceUsername: 'Backranq Player',
            sourceAccountId: null,
            userSide: 'WHITE',
        });

        expect(normalized).toMatchObject({
            id: 'backranq_coach:coach-game-1',
            provider: 'backranq_coach',
            provenance: {
                username: 'Backranq Player',
                userSide: 'white',
            },
        });
    });
});
