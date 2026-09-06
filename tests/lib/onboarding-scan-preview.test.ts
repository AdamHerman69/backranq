import { describe, expect, it } from 'vitest';
import { createScanPreview } from '@/lib/onboarding/scanPreview';
import type { TrainingMomentExtractionProgress } from '@/lib/analysis/extractTrainingMoments';
import type { NormalizedGame } from '@/lib/types/game';

const game: NormalizedGame = {
    id: 'scan', provider: 'lichess', playedAt: '2026-09-01', timeClass: 'rapid',
    white: { name: 'opponent' }, black: { name: 'player' },
    provenance: { username: 'player', userSide: 'black' },
    pgn: '1. e4 e5 2. Nf3 Nc6 *',
};
const progress: TrainingMomentExtractionProgress = {
    runId: 'extraction', gameId: 'scan', gameIndex: 0, gameCount: 1,
    phase: 'scanning', ply: 0, plyCount: 4,
    fen: '7k/8/8/8/8/8/8/K7 b - - 0 42',
    positionHistory: [], userSide: 'black',
};

describe('onboarding scan preview', () => {
    it('uses canonical extraction positions and perspective without interpreting PGN again', () => {
        expect(createScanPreview({ ...game, pgn: 'deliberately not replayable', provenance: undefined }, progress))
            .toEqual({
                gameId: game.id, fen: progress.fen, previousFen: undefined,
                orientation: 'black', whiteName: 'opponent', blackName: 'player',
                playedAt: game.playedAt,
            });
    });

    it('keeps confirmation at the canonical decision position and preserves adjacency evidence', () => {
        const confirmation = { ...progress, phase: 'confirming' as const, previousFen: 'previous canonical position' };
        expect(createScanPreview(game, confirmation)).toMatchObject({
            fen: confirmation.fen, previousFen: confirmation.previousFen, orientation: confirmation.userSide,
        });
    });

    it('does not combine progress from a different game with current metadata', () => {
        expect(createScanPreview(game, { ...progress, gameId: 'older-game' })).toBeUndefined();
    });
});
