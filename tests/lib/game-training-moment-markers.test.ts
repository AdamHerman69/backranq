import { describe, expect, it } from 'vitest';

import { GAME_TRAINING_MOMENT_MARKER_SELECT } from '@/lib/games/trainingMomentMarkers';

describe('game training-moment markers', () => {
    it('selects only marker data and never solution data for game detail', () => {
        expect(GAME_TRAINING_MOMENT_MARKER_SELECT).toEqual({
            id: true,
            decisionPly: true,
        });
        expect(GAME_TRAINING_MOMENT_MARKER_SELECT).not.toHaveProperty(
            'currentSolutionRevision'
        );
    });
});
