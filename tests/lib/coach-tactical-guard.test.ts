import { describe, expect, it } from 'vitest';

import type {
    MultiPvLine,
    MultiPvResult,
    Score,
} from '@/lib/analysis/stockfishClient';
import { selectTacticalGuardMove } from '@/lib/coach/tacticalGuard';

function line(
    multipv: number,
    moveUci: string,
    score: Score
): MultiPvLine {
    return {
        multipv,
        pvUci: [moveUci],
        score,
    };
}

function analysis(lines: MultiPvLine[]): MultiPvResult {
    return {
        fen: 'test-fen',
        bestMoveUci: lines[0]?.pvUci[0] ?? '',
        lines,
        alternativesComplete: true,
    };
}

describe('Maia tactical guard', () => {
    it('vetoes a high-probability tactical error and samples only from safe Maia moves', () => {
        const result = selectTacticalGuardMove({
            maiaCandidates: [
                { moveUci: 'g1f3', probability: 0.9 },
                { moveUci: 'd2d4', probability: 0.1 },
            ],
            analysis: analysis([
                line(1, 'e2e4', { type: 'cp', value: 100 }),
                line(2, 'd2d4', { type: 'cp', value: 20 }),
                line(3, 'g1f3', { type: 'cp', value: -30 }),
            ]),
            thresholdCp: 100,
            seed: 17,
        });

        expect(result).toEqual({
            moveUci: 'd2d4',
            source: 'maia',
            lossCp: 80,
            safeCandidateCount: 1,
            evaluatedCandidateCount: 2,
        });
    });

    it('uses Stockfish’s verified best move when no Maia candidate is safe', () => {
        const result = selectTacticalGuardMove({
            maiaCandidates: [
                { moveUci: 'g1f3', probability: 0.7 },
                { moveUci: 'c2c4', probability: 0.3 },
            ],
            analysis: analysis([
                line(1, 'e2e4', { type: 'cp', value: 120 }),
                line(2, 'g1f3', { type: 'cp', value: 20 }),
                line(3, 'c2c4', { type: 'cp', value: -10 }),
            ]),
            thresholdCp: 100,
            seed: 9,
        });

        expect(result.moveUci).toBe('e2e4');
        expect(result.source).toBe('stockfish-fallback');
        expect(result.safeCandidateCount).toBe(0);
    });

    it('treats a lost mate and missing engine evidence as unsafe', () => {
        const result = selectTacticalGuardMove({
            maiaCandidates: [
                { moveUci: 'd2d4', probability: 0.9 },
                { moveUci: 'g1f3', probability: 0.1 },
            ],
            analysis: analysis([
                line(1, 'e2e4', { type: 'mate', value: 3 }),
                line(2, 'd2d4', { type: 'mate', value: -3 }),
            ]),
            thresholdCp: 500,
            seed: 1,
        });

        expect(result.moveUci).toBe('e2e4');
        expect(result.evaluatedCandidateCount).toBe(1);
        expect(result.source).toBe('stockfish-fallback');
    });

    it('is replayable for the same seed after conditional filtering', () => {
        const args = {
            maiaCandidates: [
                { moveUci: 'e2e4', probability: 0.5 },
                { moveUci: 'd2d4', probability: 0.3 },
                { moveUci: 'g1f3', probability: 0.2 },
            ],
            analysis: analysis([
                line(1, 'e2e4', { type: 'cp' as const, value: 30 }),
                line(2, 'd2d4', { type: 'cp' as const, value: 20 }),
                line(3, 'g1f3', { type: 'cp' as const, value: 10 }),
            ]),
            thresholdCp: 100,
            seed: 4_294_967_295,
        };

        expect(selectTacticalGuardMove(args)).toEqual(
            selectTacticalGuardMove(args)
        );
    });
});
