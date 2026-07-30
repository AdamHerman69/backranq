import { describe, expect, it } from 'vitest';
import {
    isStructurallyCompleteMultiPvBundle,
    type MultiPvLine,
} from '@/lib/analysis/stockfishClient';

function line(multipv: number, move: string): MultiPvLine {
    return {
        multipv,
        pvUci: [move],
        score: { type: 'cp', value: 0 },
    };
}

describe('browser Stockfish MultiPV completeness', () => {
    it('accepts only a contiguous, unique, exact bundle with every requested slot', () => {
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(2, 'd2d4'), line(1, 'e2e4'), line(3, 'g1f3')],
                3
            )
        ).toBe(true);
    });

    it('keeps a partial browser snapshot incomplete', () => {
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'e2e4'), line(2, 'd2d4')],
                3
            )
        ).toBe(false);
    });

    it('rejects non-contiguous, duplicate-root, and malformed browser bundles', () => {
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'e2e4'), line(3, 'd2d4')],
                2
            )
        ).toBe(false);
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'e2e4'), line(2, 'E2E4')],
                2
            )
        ).toBe(false);
        expect(
            isStructurallyCompleteMultiPvBundle(
                [line(1, 'not-a-move'), line(2, 'd2d4')],
                2
            )
        ).toBe(false);
    });
});
