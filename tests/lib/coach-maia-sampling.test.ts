import { describe, expect, it } from 'vitest';

import { modelMoveToIndex } from '@/lib/coach/maia/preprocess';
import {
    normalizeMaiaSeed,
    sampleMaiaPolicy,
} from '@/lib/coach/maia/sampling';

function blankPolicy(): Float32Array {
    const logits = new Float32Array(4_352);
    logits.fill(-20);
    return logits;
}

describe('Maia legal policy sampling', () => {
    it('cannot select a high-scoring illegal policy index', () => {
        const logits = blankPolicy();
        logits[3_000] = 1_000;
        logits[modelMoveToIndex('e2e4')] = 2;
        logits[modelMoveToIndex('e2e3')] = 1;

        const result = sampleMaiaPolicy({
            logits,
            legalMoves: [
                {
                    moveUci: 'e2e4',
                    modelIndex: modelMoveToIndex('e2e4'),
                },
                {
                    moveUci: 'e2e3',
                    modelIndex: modelMoveToIndex('e2e3'),
                },
            ],
            seed: 42,
            temperature: 1,
            topP: 1,
        });

        expect(['e2e4', 'e2e3']).toContain(result.moveUci);
        expect(result.candidateCount).toBe(2);
    });

    it('returns exactly the same sample for the same normalized seed', () => {
        const logits = blankPolicy();
        const legalMoves = ['e2e4', 'd2d4', 'g1f3'].map((moveUci, index) => {
            logits[modelMoveToIndex(moveUci)] = 3 - index * 0.2;
            return {
                moveUci,
                modelIndex: modelMoveToIndex(moveUci),
            };
        });
        const args = {
            logits,
            legalMoves,
            seed: -1,
            temperature: 1,
            topP: 0.95,
        };

        expect(sampleMaiaPolicy(args)).toEqual(sampleMaiaPolicy(args));
        expect(sampleMaiaPolicy(args).seed).toBe(4_294_967_295);
        expect(normalizeMaiaSeed(4_294_967_295)).toBe(
            normalizeMaiaSeed(-1)
        );
    });

    it('applies top-p after the legal softmax', () => {
        const logits = blankPolicy();
        const legalMoves = ['e2e4', 'd2d4', 'g1f3'].map((moveUci, index) => {
            logits[modelMoveToIndex(moveUci)] = 10 - index * 10;
            return {
                moveUci,
                modelIndex: modelMoveToIndex(moveUci),
            };
        });

        const result = sampleMaiaPolicy({
            logits,
            legalMoves,
            seed: 9,
            temperature: 1,
            topP: 0.9,
        });

        expect(result.moveUci).toBe('e2e4');
        expect(result.candidateCount).toBe(1);
        expect(result.probability).toBe(1);
    });

    it('rejects NaN legal logits and invalid sampling controls', () => {
        const logits = blankPolicy();
        const legalMoves = [
            {
                moveUci: 'e2e4',
                modelIndex: modelMoveToIndex('e2e4'),
            },
        ];
        logits[modelMoveToIndex('e2e4')] = Number.NaN;

        expect(() =>
            sampleMaiaPolicy({
                logits,
                legalMoves,
                seed: 1,
                temperature: 1,
                topP: 1,
            })
        ).toThrow('invalid logit');
        expect(() => normalizeMaiaSeed(Number.NaN)).toThrow('finite');
    });
});
