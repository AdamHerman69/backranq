import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeGradingPolicy } from '@/lib/training/config';
import {
    evaluateDynamicTrainingMove,
    type DynamicEvaluation,
} from '@/lib/training/attemptService';
import { gradeTrainingMove } from '@/lib/training/grader';

const engineMocks = vi.hoisted(() => ({
    evalPosition: vi.fn(),
    getIdentity: vi.fn(async () => ({
        name: 'Mockfish',
        source: 'test',
        flavor: 'lite-single',
        options: {},
    })),
    terminate: vi.fn(),
    tablebaseProbe: vi.fn(async () => null),
}));

vi.mock('@/lib/analysis/serverStockfishClient', () => ({
    ServerStockfishClient: class {
        evalPosition = engineMocks.evalPosition;
        getIdentity = engineMocks.getIdentity;
        terminate = engineMocks.terminate;
    },
}));

vi.mock('@/lib/analysis/tablebase', () => ({
    LichessTablebaseClient: class {
        probe = engineMocks.tablebaseProbe;
    },
}));

const rootFen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const afterD4 =
    'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1';

function evaluation(
    cp: number,
    wdl: { win: number; draw: number; loss: number }
) {
    return {
        fen: rootFen,
        bestMoveUci: 'e2e4',
        pvUci: ['e2e4'],
        score: { type: 'cp' as const, value: cp },
        wdl,
    };
}

async function run(): Promise<DynamicEvaluation> {
    return evaluateDynamicTrainingMove({
        fen: rootFen,
        moveUci: 'd2d4',
        trainingSide: 'w',
        bestScore: {
            kind: 'cp',
            cp: 1_000,
            pov: 'WHITE',
        },
        originalScore: {
            kind: 'cp',
            cp: -100,
            pov: 'WHITE',
        },
        originalMoveUci: 'a2a3',
    });
}

describe('dynamic matched-budget evaluator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('compares root and submitted WDL at both matched budgets', async () => {
        engineMocks.evalPosition
            .mockResolvedValueOnce(
                evaluation(1_000, {
                    win: 900,
                    draw: 0,
                    loss: 100,
                })
            )
            .mockResolvedValueOnce(
                evaluation(0, {
                    win: 105,
                    draw: 0,
                    loss: 895,
                })
            )
            .mockResolvedValueOnce(
                evaluation(1_000, {
                    win: 900,
                    draw: 0,
                    loss: 100,
                })
            )
            .mockResolvedValueOnce(
                evaluation(0, {
                    win: 105,
                    draw: 0,
                    loss: 895,
                })
            );

        const result = await run();

        expect(engineMocks.evalPosition.mock.calls).toEqual([
            [{ fen: rootFen, nodes: 70_000, timeoutMs: 15_000 }],
            [{ fen: afterD4, nodes: 70_000, timeoutMs: 15_000 }],
            [{ fen: rootFen, nodes: 140_000, timeoutMs: 15_000 }],
            [{ fen: afterD4, nodes: 140_000, timeoutMs: 15_000 }],
        ]);
        expect(result.metrics).toMatchObject({
            stable: true,
            bestGapCp: 1_000,
            bestGapWinChance: 0.005,
            preservesOutcome: true,
        });
        expect(
            gradeTrainingMove(
                result.metrics,
                normalizeGradingPolicy(undefined, 'PRACTICAL')
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
        expect(result.evidence).toMatchObject({
            matchedPasses: [
                { nodesRequested: 70_000 },
                { nodesRequested: 140_000 },
            ],
            stable: true,
        });
    });

    it('marks materially changing matched WDL gaps unstable', async () => {
        engineMocks.evalPosition
            .mockResolvedValueOnce(
                evaluation(1_000, {
                    win: 900,
                    draw: 0,
                    loss: 100,
                })
            )
            .mockResolvedValueOnce(
                evaluation(0, {
                    win: 105,
                    draw: 0,
                    loss: 895,
                })
            )
            .mockResolvedValueOnce(
                evaluation(1_000, {
                    win: 900,
                    draw: 0,
                    loss: 100,
                })
            )
            .mockResolvedValueOnce(
                evaluation(0, {
                    win: 300,
                    draw: 0,
                    loss: 700,
                })
            );

        const result = await run();

        expect(result.metrics.stable).toBe(false);
        expect(
            gradeTrainingMove(
                result.metrics,
                normalizeGradingPolicy(undefined, 'PRACTICAL')
            )
        ).toEqual({
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
    });

    it('grades a legal non-tablebase checkmate from rule evidence without analyzing the terminal FEN', async () => {
        const mateFen =
            '7k/5Q2/6K1/8/8/8/PPPPPPPP/8 w - - 0 1';
        const rootMate = {
            fen: mateFen,
            bestMoveUci: 'f7g7',
            pvUci: ['f7g7'],
            score: { type: 'mate' as const, value: 1 },
        };
        engineMocks.evalPosition
            .mockResolvedValueOnce(rootMate)
            .mockResolvedValueOnce(rootMate);

        const result = await evaluateDynamicTrainingMove({
            fen: mateFen,
            moveUci: 'f7f8',
            trainingSide: 'w',
            bestScore: null,
            originalScore: {
                kind: 'cp',
                cp: 0,
                pov: 'WHITE',
            },
            originalMoveUci: 'a2a3',
        });

        expect(engineMocks.evalPosition.mock.calls).toEqual([
            [{ fen: mateFen, nodes: 70_000, timeoutMs: 15_000 }],
            [{ fen: mateFen, nodes: 140_000, timeoutMs: 15_000 }],
        ]);
        expect(engineMocks.tablebaseProbe).not.toHaveBeenCalled();
        expect(result.scoreAfter).toEqual({
            kind: 'mate',
            plies: 0,
            winner: 'WHITE',
        });
        expect(result.evidence).toMatchObject({
            source: 'RULE',
            terminal: 'CHECKMATE',
            stable: true,
        });
        expect(
            gradeTrainingMove(
                result.metrics,
                normalizeGradingPolicy(undefined, 'PRACTICAL')
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
    });

    it.each([
        {
            reason: 'STALEMATE',
            fen: '7k/5K2/8/6Q1/8/8/PPPPPPPP/8 w - - 0 1',
            moveUci: 'g5g6',
        },
        {
            reason: 'FIFTY_MOVE',
            fen: '7k/8/8/8/8/8/R7/K7 w - - 99 1',
            moveUci: 'a2a3',
        },
    ])(
        'adjudicates a terminal $reason as an exact draw',
        async ({ reason, fen, moveUci }) => {
            const rootDraw = {
                fen,
                bestMoveUci: moveUci,
                pvUci: [moveUci],
                score: { type: 'cp' as const, value: 0 },
            };
            engineMocks.evalPosition
                .mockResolvedValueOnce(rootDraw)
                .mockResolvedValueOnce(rootDraw);

            const result = await evaluateDynamicTrainingMove({
                fen,
                moveUci,
                trainingSide: 'w',
                bestScore: null,
                originalScore: {
                    kind: 'cp',
                    cp: -50,
                    pov: 'WHITE',
                },
                originalMoveUci: 'h2h3',
            });

            expect(result.scoreAfter).toEqual({
                kind: 'tablebase',
                wdl: 'DRAW',
                pov: 'WHITE',
            });
            expect(result.evidence).toMatchObject({
                source: 'RULE',
                terminal: reason,
                stable: true,
            });
            expect(engineMocks.evalPosition).toHaveBeenCalledTimes(2);
        }
    );

    it('adjudicates an unknown move that completes a source-context threefold repetition', async () => {
        const positionHistory = [
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 1 1',
            'rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2',
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 3 2',
            'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 4 3',
            'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 5 3',
            'rnbqkb1r/pppppppp/5n2/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 6 4',
        ];
        const repetitionRoot =
            'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        const rootDraw = {
            fen: repetitionRoot,
            bestMoveUci: 'f6g8',
            pvUci: ['f6g8'],
            score: { type: 'cp' as const, value: 0 },
        };
        engineMocks.evalPosition
            .mockResolvedValueOnce(rootDraw)
            .mockResolvedValueOnce(rootDraw);

        const result = await evaluateDynamicTrainingMove({
            fen: repetitionRoot,
            moveUci: 'f6g8',
            trainingSide: 'b',
            bestScore: null,
            originalScore: null,
            originalMoveUci: 'a7a6',
            positionHistory,
        });

        expect(result.scoreAfter).toEqual({
            kind: 'tablebase',
            wdl: 'DRAW',
            pov: 'WHITE',
        });
        expect(result.evidence).toMatchObject({
            source: 'RULE',
            terminal: 'THREEFOLD_REPETITION',
        });
        expect(engineMocks.tablebaseProbe).not.toHaveBeenCalled();
        expect(engineMocks.evalPosition).toHaveBeenCalledTimes(2);
    });
});
