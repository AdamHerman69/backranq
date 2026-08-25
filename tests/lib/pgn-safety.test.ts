import { describe, expect, it } from 'vitest';
import {
    countSourcePgnPlies,
    hashSourcePgn,
    isValidSourcePgn,
    sourcePgnPositionFens,
} from '@/lib/chess/pgn';

describe('source PGN safety helpers', () => {
    it('normalizes line endings for stable source identity', () => {
        expect(
            hashSourcePgn('[Event "Test"]\r\n\r\n1. e4 *\r\n')
        ).toBe(hashSourcePgn('[Event "Test"]\n\n1. e4 *'));
    });

    it('rejects malformed movetext before any data mutation', () => {
        expect(isValidSourcePgn('[Event "Test"]\n\n1. e5 *')).toBe(false);
        expect(isValidSourcePgn('[Event "Test"]\n\n1. e4 *')).toBe(true);
    });

    it('counts parsed plies instead of comment or annotation tokens', () => {
        expect(
            countSourcePgnPlies(
                '[Event "Test"]\n\n1. e4 {clock note with words} e5 $1 2. Nf3 (2. Bc4) Nc6 *'
            )
        ).toBe(4);
        expect(countSourcePgnPlies('[Event "Test"]\n\n1. e5 *')).toBe(0);
    });

    it('anchors every ply to an exact source position including clocks', () => {
        expect(
            sourcePgnPositionFens(
                '[Event "Test"]\n\n1. e4 e5 *'
            )
        ).toEqual([
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
            'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
        ]);
    });
});
