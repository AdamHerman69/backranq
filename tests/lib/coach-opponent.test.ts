import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import type {
    MultiPvLine,
    MultiPvResult,
} from '@/lib/analysis/stockfishClient';
import { selectOpponentMove } from '@/lib/coach/opponent';
import { getOpponentProfile } from '@/lib/coach/profiles';

const START_FEN = new Chess().fen();

function line(args: {
    multipv: number;
    move: string;
    cp: number;
    wdl?: { win: number; draw: number; loss: number };
}): MultiPvLine {
    return {
        multipv: args.multipv,
        pvUci: [args.move],
        score: { type: 'cp', value: args.cp },
        ...(args.wdl ? { wdl: args.wdl } : {}),
    };
}

function analysis(lines: MultiPvLine[]): MultiPvResult {
    return {
        fen: START_FEN,
        bestMoveUci: lines[0]?.pvUci[0] ?? '',
        lines,
    };
}

describe('opponent move selection', () => {
    it('sorts by MultiPV rank, rejects illegal roots, and deduplicates normalized moves', () => {
        const result = selectOpponentMove({
            fen: START_FEN,
            analysis: analysis([
                line({
                    multipv: 4,
                    move: 'e2e5',
                    cp: 100,
                }),
                line({
                    multipv: 3,
                    move: 'E2E4',
                    cp: 0,
                }),
                line({
                    multipv: 2,
                    move: 'e2e4',
                    cp: 0,
                }),
                line({
                    multipv: 1,
                    move: 'a1a8',
                    cp: 500,
                }),
            ]),
            profileId: 'maximum',
            random: () => 0.99,
        });

        expect(result.moveUci).toBe('e2e4');
        expect(result.line.multipv).toBe(2);
        expect(result.candidateIndex).toBe(0);
    });

    it('rejects a malformed UCI root even if chess.js can apply its first four characters', () => {
        const result = selectOpponentMove({
            fen: START_FEN,
            analysis: analysis([
                line({
                    multipv: 1,
                    move: 'e2e4junk',
                    cp: 100,
                }),
                line({
                    multipv: 2,
                    move: 'd2d4',
                    cp: 0,
                }),
            ]),
            profileId: 'maximum',
            random: () => 0,
        });

        expect(result.moveUci).toBe('d2d4');
        expect(result.line.multipv).toBe(2);
    });

    it('throws a controlled error when Stockfish provides no legal root', () => {
        expect(() =>
            selectOpponentMove({
                fen: START_FEN,
                analysis: analysis([
                    line({
                        multipv: 1,
                        move: 'e2e5',
                        cp: 0,
                    }),
                    line({
                        multipv: 2,
                        move: 'a1a8',
                        cp: -10,
                    }),
                ]),
                profileId: 'friendly',
                random: () => 0,
            })
        ).toThrow('Stockfish returned no legal opponent move.');
    });

    it('caps weaker-bot candidates by WDL loss before centipawn loss', () => {
        const result = selectOpponentMove({
            fen: START_FEN,
            analysis: analysis([
                line({
                    multipv: 1,
                    move: 'e2e4',
                    cp: 1_000,
                    wdl: { win: 600, draw: 300, loss: 100 },
                }),
                line({
                    multipv: 2,
                    move: 'd2d4',
                    cp: 500,
                    // Only a 5 percentage-point expected-score loss.
                    wdl: { win: 550, draw: 300, loss: 150 },
                }),
                line({
                    multipv: 3,
                    move: 'g1f3',
                    cp: 490,
                    // A 25 percentage-point loss, outside Friendly's cap.
                    wdl: { win: 300, draw: 400, loss: 300 },
                }),
            ]),
            profileId: 'friendly',
            random: () => 0.999,
        });

        expect(result.moveUci).toBe('d2d4');
        expect(result.candidateIndex).toBe(1);
    });

    it('honors the exact injected-RNG bucket boundary', () => {
        const candidates = analysis([
            line({ multipv: 1, move: 'e2e4', cp: 0 }),
            line({ multipv: 2, move: 'd2d4', cp: -10 }),
        ]);
        const bias = getOpponentProfile('friendly').selectionBias;
        const firstWeight = Math.pow(1, bias);
        const secondWeight = Math.pow(2, bias);
        const boundary = firstWeight / (firstWeight + secondWeight);

        expect(
            selectOpponentMove({
                fen: START_FEN,
                analysis: candidates,
                profileId: 'friendly',
                random: () => boundary - Number.EPSILON,
            }).moveUci
        ).toBe('e2e4');
        expect(
            selectOpponentMove({
                fen: START_FEN,
                analysis: candidates,
                profileId: 'friendly',
                random: () => boundary,
            }).moveUci
        ).toBe('d2d4');
    });

    it('clamps hostile RNG values and makes maximum strength deterministic', () => {
        const candidates = analysis([
            line({ multipv: 1, move: 'e2e4', cp: 0 }),
            line({ multipv: 2, move: 'd2d4', cp: -10 }),
        ]);

        expect(
            selectOpponentMove({
                fen: START_FEN,
                analysis: candidates,
                profileId: 'friendly',
                random: () => Number.NaN,
            }).moveUci
        ).toBe('e2e4');
        expect(
            selectOpponentMove({
                fen: START_FEN,
                analysis: candidates,
                profileId: 'friendly',
                random: () => 5,
            }).moveUci
        ).toBe('d2d4');
        expect(
            selectOpponentMove({
                fen: START_FEN,
                analysis: candidates,
                profileId: 'maximum',
                random: () => 0.999,
            }).moveUci
        ).toBe('e2e4');
    });

    it('does not let a weaker profile choose a lost mate over a winning mate', () => {
        const result = selectOpponentMove({
            fen: START_FEN,
            analysis: analysis([
                {
                    multipv: 1,
                    pvUci: ['e2e4'],
                    score: { type: 'mate', value: 3 },
                },
                {
                    multipv: 2,
                    pvUci: ['d2d4'],
                    score: { type: 'mate', value: -3 },
                },
            ]),
            profileId: 'friendly',
            random: () => 0.999,
        });

        expect(result.moveUci).toBe('e2e4');
        expect(result.candidateIndex).toBe(0);
    });
});
