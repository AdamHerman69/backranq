import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import {
    encodeMaiaBoard,
    legalMaiaMoves,
    mirrorUci,
    modelIndexToMove,
    modelMoveToIndex,
    prepareMaiaPosition,
} from '@/lib/coach/maia/preprocess';

describe('Maia position preprocessing', () => {
    it('encodes the starting board as a1-first piece channels', () => {
        const tokens = encodeMaiaBoard(new Chess());

        expect(tokens).toHaveLength(64 * 12);
        expect(tokens.reduce((sum, value) => sum + value, 0)).toBe(32);
        expect(tokens[0 * 12 + 3]).toBe(1); // white rook a1
        expect(tokens[4 * 12 + 5]).toBe(1); // white king e1
        expect(tokens[56 * 12 + 9]).toBe(1); // black rook a8
        expect(tokens[60 * 12 + 11]).toBe(1); // black king e8
    });

    it('mirrors ranks and swaps piece colors when black is to move', () => {
        const chess = new Chess(
            'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'
        );
        const tokens = encodeMaiaBoard(chess);

        expect(tokens[4 * 12 + 5]).toBe(1); // original black king e8 -> white e1
        expect(tokens[12 * 12 + 0]).toBe(1); // original black pawn e7 -> white e2
        expect(tokens[36 * 12 + 6]).toBe(1); // original white pawn e4 -> black e5
        expect(mirrorUci('e7e5')).toBe('e2e4');
    });

    it('uses the exact 4,352-move vocabulary ordering', () => {
        expect(modelMoveToIndex('a1a1')).toBe(0);
        expect(modelMoveToIndex('h8h8')).toBe(4_095);
        expect(modelMoveToIndex('a7a8q')).toBe(4_096);
        expect(modelMoveToIndex('a7a8n')).toBe(4_099);
        expect(modelMoveToIndex('h7h8n')).toBe(4_351);

        for (const move of [
            'a1a1',
            'e2e4',
            'e1g1',
            'a7b8q',
            'h7h8n',
        ]) {
            expect(modelIndexToMove(modelMoveToIndex(move))).toBe(move);
        }
    });

    it('maps every starting-position legal move to a unique policy index', () => {
        const prepared = prepareMaiaPosition(new Chess().fen());

        expect(prepared.legalMoves).toHaveLength(20);
        expect(
            new Set(prepared.legalMoves.map((move) => move.modelIndex)).size
        ).toBe(20);
        expect(prepared.legalMoves).toContainEqual({
            moveUci: 'e2e4',
            modelIndex: modelMoveToIndex('e2e4'),
        });
    });

    it('preserves legal castling moves for both sides', () => {
        const white = new Chess(
            'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
        );
        const black = new Chess(
            'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1'
        );

        expect(legalMaiaMoves(white)).toEqual(
            expect.arrayContaining([
                {
                    moveUci: 'e1g1',
                    modelIndex: modelMoveToIndex('e1g1'),
                },
                {
                    moveUci: 'e1c1',
                    modelIndex: modelMoveToIndex('e1c1'),
                },
            ])
        );
        expect(legalMaiaMoves(black)).toEqual(
            expect.arrayContaining([
                {
                    moveUci: 'e8g8',
                    modelIndex: modelMoveToIndex('e1g1'),
                },
                {
                    moveUci: 'e8c8',
                    modelIndex: modelMoveToIndex('e1c1'),
                },
            ])
        );
    });

    it('includes en-passant in the legal policy mask', () => {
        const chess = new Chess(
            '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'
        );

        expect(legalMaiaMoves(chess)).toContainEqual({
            moveUci: 'e5d6',
            modelIndex: modelMoveToIndex('e5d6'),
        });
    });

    it('keeps all four promotion suffixes, including black mirroring', () => {
        const white = legalMaiaMoves(
            new Chess('4k3/P7/8/8/8/8/8/4K3 w - - 0 1')
        );
        const black = legalMaiaMoves(
            new Chess('4k3/8/8/8/8/8/p7/4K3 b - - 0 1')
        );

        for (const piece of ['q', 'r', 'b', 'n']) {
            expect(white).toContainEqual({
                moveUci: `a7a8${piece}`,
                modelIndex: modelMoveToIndex(`a7a8${piece}`),
            });
            expect(black).toContainEqual({
                moveUci: `a2a1${piece}`,
                modelIndex: modelMoveToIndex(`a7a8${piece}`),
            });
        }
    });

    it('rejects terminal and malformed positions before inference', () => {
        expect(() => prepareMaiaPosition('not a fen')).toThrow(
            'Invalid chess position'
        );
        expect(() =>
            prepareMaiaPosition(
                '7k/5Q2/7K/8/8/8/8/8 b - - 0 1'
            )
        ).toThrow('no legal moves');
    });
});
