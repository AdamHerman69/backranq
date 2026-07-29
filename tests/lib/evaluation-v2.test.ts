import { describe, expect, it } from 'vitest';
import {
    evaluationLoss,
    negateScore,
    qualifiesEvaluationLoss,
    reverseWdl,
    scoreToOrderingCp,
    winningChance,
} from '@/lib/analysis/evaluation';
import { parseUciInfoLine } from '@/lib/analysis/serverStockfishClient';

describe('explicit engine evaluation model', () => {
    it('keeps mate categorical while providing stable legacy ordering', () => {
        expect(scoreToOrderingCp({ type: 'mate', value: 1 })).toBe(99_999);
        expect(scoreToOrderingCp({ type: 'mate', value: -3 })).toBe(-99_997);
        expect(scoreToOrderingCp({ type: 'mate', value: 0 })).toBe(0);
        expect(winningChance({ type: 'mate', value: 1 })).toBe(1);
        expect(winningChance({ type: 'mate', value: -1 })).toBe(0);
    });

    it('uses UCI WDL when present and reverses perspective coherently', () => {
        const wdl = { win: 700, draw: 200, loss: 100 };
        expect(winningChance({ type: 'cp', value: 0 }, wdl)).toBe(0.8);
        expect(reverseWdl(wdl)).toEqual({
            win: 100,
            draw: 200,
            loss: 700,
        });
        expect(negateScore({ type: 'cp', value: 42 })).toEqual({
            type: 'cp',
            value: -42,
        });
    });

    it('reports practical loss from a common player perspective', () => {
        const loss = evaluationLoss(
            { score: { type: 'cp', value: 120 } },
            { score: { type: 'cp', value: 90 } }
        );
        expect(loss.cp).toBe(30);
        expect(loss.winningChance).toBeGreaterThan(0);
    });

    it('uses winning-chance loss before the centipawn fallback', () => {
        const saturated = evaluationLoss(
            { score: { type: 'cp', value: 1_200 } },
            { score: { type: 'cp', value: 900 } }
        );
        expect(saturated.cp).toBe(300);
        expect(
            qualifiesEvaluationLoss(saturated, {
                minWinningChanceLoss: 0.03,
                fallbackMinCpLoss: 30,
            })
        ).toBe(false);

        expect(
            qualifiesEvaluationLoss(
                { cp: 31, winningChance: null },
                {
                    minWinningChanceLoss: 0.03,
                    fallbackMinCpLoss: 30,
                }
            )
        ).toBe(true);
    });
});

describe('server UCI parser', () => {
    it('captures reproducibility evidence from exact lines', () => {
        expect(
            parseUciInfoLine(
                'info depth 18 seldepth 25 multipv 2 score cp 34 wdl 321 600 79 nodes 100000 nps 800000 time 125 pv e2e4 e7e5'
            )
        ).toMatchObject({
            depth: 18,
            selDepth: 25,
            multipv: 2,
            score: { type: 'cp', value: 34 },
            wdl: { win: 321, draw: 600, loss: 79 },
            nodes: 100_000,
            nps: 800_000,
            timeMs: 125,
            pvUci: ['e2e4', 'e7e5'],
            isBound: false,
        });
    });

    it('does not promote lower/upper bounds to exact scores', () => {
        expect(
            parseUciInfoLine(
                'info depth 12 score cp 80 upperbound nodes 5000 pv d2d4'
            )
        ).toMatchObject({
            score: null,
            isBound: true,
            nodes: 5_000,
        });
    });
});
