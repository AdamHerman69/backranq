import { Chess } from 'chess.js';
import { describe, it, expect } from 'vitest';
import {
    ruleTerminalEvaluation,
    claimableDraw,
} from '@/lib/analysis/ruleEvaluation';

describe('mandatory rule endings and optional claims', () => {
    const rook = '8/8/8/8/8/2k5/4K3/6R1 w - -';
    it('keeps fifty-move availability separate from the automatic75-move ending', () => {
        expect(ruleTerminalEvaluation(`${rook} 100 51`)).toBeNull();
        expect(claimableDraw(`${rook} 100 51`, [])).toBe('FIFTY_MOVE_RULE');
        expect(ruleTerminalEvaluation(`${rook} 150 76`)).toMatchObject({
            terminal: { kind: 'SEVENTY_FIVE_MOVE_RULE', outcome: 'DRAW' },
            searchEvidence: { source: 'RULE', reported: { nodes: 0 } },
        });
    });
    it('gives a mating final move precedence over the75-move rule', () => {
        expect(
            ruleTerminalEvaluation('7k/6Q1/6K1/8/8/8/8/8 b - - 150 76'),
        ).toMatchObject({
            score: { type: 'mate', value: 0 },
            terminal: { kind: 'CHECKMATE', outcome: 'LOSS' },
        });
    });
    it('keeps threefold optional and makes the fifth actual occurrence terminal', () => {
        const board = new Chess();
        const previous: string[] = [];
        for (let cycle = 0; cycle < 2; cycle++)
            for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) {
                previous.push(board.fen());
                board.move(move);
            }
        expect(claimableDraw(board.fen(), previous)).toBe(
            'THREEFOLD_REPETITION',
        );
        expect(ruleTerminalEvaluation(board.fen(), previous)).toBeNull();
        for (let cycle = 0; cycle < 2; cycle++)
            for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) {
                previous.push(board.fen());
                board.move(move);
            }
        expect(ruleTerminalEvaluation(board.fen(), previous)).toMatchObject({
            terminal: { kind: 'FIVEFOLD_REPETITION', outcome: 'DRAW' },
            searchEvidence: { request: { historyMode: 'REPLAY' } },
        });
    });
    it('canonicalizes irrelevant en-passant targets in repetition identity', () => {
        const noTarget = '4k3/8/8/8/4P3/8/8/4K3 b - - 0 1';
        const staleTarget = '4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1';
        expect(claimableDraw(noTarget, [staleTarget, staleTarget])).toBe(
            'THREEFOLD_REPETITION',
        );
    });
});
