import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import {
    getCoachGameOutcome,
    terminalEvaluation,
} from '@/lib/coach/terminal';

describe('coach game terminal evidence', () => {
    it('returns no terminal evidence or outcome while play can continue', () => {
        const chess = new Chess();

        expect(terminalEvaluation(chess)).toBeNull();
        expect(getCoachGameOutcome(chess, 'w')).toBeNull();
    });

    it('represents checkmate from the losing side-to-move POV', () => {
        const chess = new Chess();
        chess.move('f3');
        chess.move('e5');
        chess.move('g4');
        chess.move('Qh4#');

        expect(chess.turn()).toBe('w');
        expect(terminalEvaluation(chess)).toEqual({
            score: { type: 'mate', value: -1 },
            wdl: { win: 0, draw: 0, loss: 1_000 },
        });
        expect(getCoachGameOutcome(chess, 'w')).toEqual({
            outcome: 'loss',
            title: 'Checkmate — the bot won',
            reason: 'The game is over, but every caught mistake remains available in this session.',
        });
        expect(getCoachGameOutcome(chess, 'b')).toEqual({
            outcome: 'win',
            title: 'Checkmate — you won',
            reason: 'You converted the game successfully.',
        });
    });

    it('returns exact draw evidence and a stalemate explanation', () => {
        const chess = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');

        expect(chess.isStalemate()).toBe(true);
        expect(terminalEvaluation(chess)).toEqual({
            score: { type: 'cp', value: 0 },
            wdl: { win: 0, draw: 1_000, loss: 0 },
        });
        expect(getCoachGameOutcome(chess, 'w')).toEqual({
            outcome: 'draw',
            title: 'Draw',
            reason: 'Draw by stalemate.',
        });
    });

    it('distinguishes repetition and insufficient-material draw reasons', () => {
        const repeated = new Chess();
        for (const move of [
            'Nf3',
            'Nf6',
            'Ng1',
            'Ng8',
            'Nf3',
            'Nf6',
            'Ng1',
            'Ng8',
        ]) {
            repeated.move(move);
        }
        expect(repeated.isThreefoldRepetition()).toBe(true);
        expect(getCoachGameOutcome(repeated, 'w')?.reason).toBe(
            'Draw by threefold repetition.'
        );

        const insufficient = new Chess(
            '8/8/8/8/8/8/4k3/6K1 w - - 0 1'
        );
        expect(insufficient.isInsufficientMaterial()).toBe(true);
        expect(getCoachGameOutcome(insufficient, 'b')?.reason).toBe(
            'Draw by insufficient material.'
        );
    });
});
