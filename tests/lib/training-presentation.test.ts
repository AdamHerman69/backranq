import { describe, expect, it } from 'vitest';

import {
    formatOutcomeDifference,
    formatScoreForTrainingSide,
    formatSignedOutcomeDifference,
    lessonLabel,
    moveLabel,
    moveLineLabels,
    themeLabel,
} from '@/lib/training/presentation';

describe('training presentation semantics', () => {
    it('renders legal root moves as SAN with a safe coordinate fallback', () => {
        const fen =
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

        expect(moveLabel(fen, 'e7e5')).toBe('e5');
        expect(moveLabel(fen, 'not-a-move')).toBe('not-a-move');
        expect(moveLabel(fen, null)).toBe('—');
    });

    it('renders a continuation as sequential SAN', () => {
        expect(
            moveLineLabels(
                'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                ['e2e4', 'e7e5', 'g1f3']
            )
        ).toEqual(['e4', 'e5', 'Nf3']);
    });

    it('renders every score from the training side rather than raw White POV', () => {
        expect(
            formatScoreForTrainingSide(
                { kind: 'cp', cp: 125, pov: 'WHITE' },
                'b'
            )
        ).toBe('You are worse by 1.25');
        expect(
            formatScoreForTrainingSide(
                { kind: 'mate', winner: 'BLACK', plies: 5 },
                'b'
            )
        ).toBe('You can force mate in 3');
        expect(
            formatScoreForTrainingSide(
                { kind: 'tablebase', wdl: 'WIN', pov: 'WHITE', dtz: 7 },
                'b'
            )
        ).toBe('Tablebase loss');
    });

    it('prefers outcome probability over centipawn fallback', () => {
        expect(
            formatOutcomeDifference({
                winChance: 0.037,
                cp: 80,
            })
        ).toBe('3.7 percentage points');
        expect(
            formatOutcomeDifference({
                winChance: null,
                cp: 80.4,
            })
        ).toBe('80 cp');
        expect(
            formatSignedOutcomeDifference({
                winChance: -0.042,
                cp: -95,
            })
        ).toBe('−4.2 percentage points');
    });

    it('turns domain tags into friendly review labels', () => {
        expect(lessonLabel('SAVE_DRAW')).toBe('Save the draw');
        expect(themeLabel('quietDefense')).toBe('Quiet Defense');
        expect(themeLabel('multi_solution')).toBe('Multi Solution');
    });
});
