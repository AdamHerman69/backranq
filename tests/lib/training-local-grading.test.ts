import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';

import type {
    EvalResult,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import type {
    TrainingGradingManifestDto,
    TrainingSolutionTreeNodeDto,
} from '@/lib/training/api';
import {
    gradeKnownLocalMove,
    gradeUnknownLocalMove,
    localContinuationForMove,
} from '@/lib/training/localGrading';

const rootFen =
    'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const rootNode: TrainingSolutionTreeNodeDto = {
    fen: rootFen,
    ply: 0,
    role: 'USER',
    acceptedMovesUci: ['d2d4'],
    branches: [
        {
            moveUci: 'd2d4',
            best: true,
            child: {
                fen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
                ply: 1,
                role: 'TERMINAL',
                acceptedMovesUci: [],
                branches: [],
            },
        },
    ],
};

function manifest(): TrainingGradingManifestDto {
    return {
        version: 1,
        trainingSide: 'w',
        positionHistory: [],
        originalMoveUci: 'e2e4',
        originalScoreAfter: {
            kind: 'cp',
            cp: -150,
            pov: 'WHITE',
        },
        gradingPolicy: {
            version: 3,
            pov: 'TRAINING_SIDE',
            best: { maxCpLoss: 20, maxWinChanceLoss: 0.03 },
            strong: { maxCpLoss: 50, maxWinChanceLoss: 0.05 },
            success: {
                maxCpLoss: 100,
                maxWinChanceLoss: 0.1,
                preserveOutcome: true,
            },
            improvement: {
                minRecoveredCp: 50,
                minRecoveredWinChance: 0.05,
            },
            unknownMove: 'REJECT_OUTSIDE_ACCEPTED_SET',
            matePolicy: 'EXACT',
            tablebasePolicy: 'EXACT',
        },
        acceptanceFrontier: {
            version: 1,
            status: rootNode.alternativesComplete
                ? 'STABLE'
                : 'OPEN',
            targetCutoffCp: 100,
            effectiveCutoffCp: rootNode.alternativesComplete
                ? 80
                : null,
            boundaryGapCp: rootNode.alternativesComplete ? 40 : null,
            moves: [
                { moveUci: 'd2d4', tier: 'BEST' },
                { moveUci: 'c2c4', tier: 'GOOD' },
            ],
            firstRejectedMoveUci: rootNode.alternativesComplete
                ? 'e2e4'
                : null,
        },
        solutionTree: rootNode,
        moveAssessments: [
            {
                decisionIndex: 0,
                fen: rootFen,
                moveUci: 'd2d4',
                source: 'PRECOMPUTED',
                grade: 'BEST',
                scoreAfter: {
                    kind: 'cp',
                    cp: 100,
                    pov: 'WHITE',
                },
                evidence: {
                    bestGapCp: 0,
                    bestGapWinChance: 0,
                    preservesOutcome: true,
                },
            },
        ],
        review: {
            trainingSide: 'w',
            originalMoveUci: 'e2e4',
            submittedMoveUci: null,
            bestMoveUci: 'd2d4',
            acceptedMovesUci: ['d2d4'],
            acceptedMovesComplete: false,
            bestLineUci: ['d2d4'],
            scoreAtStart: {
                kind: 'cp',
                cp: 100,
                pov: 'WHITE',
            },
            originalDecision: {
                scoreBefore: {
                    kind: 'cp',
                    cp: 100,
                    pov: 'WHITE',
                },
                scoreAfter: {
                    kind: 'cp',
                    cp: -150,
                    pov: 'WHITE',
                },
                cpLoss: 250,
                winChanceLoss: 0.3,
            },
            comparison: null,
            sourceKinds: ['MY_MISTAKE'],
            lessonKinds: ['AVOID_MISTAKE'],
            themes: [],
            source: {
                gameId: 'game-1',
                provider: 'chesscom',
                playedAt: '2026-07-30T00:00:00.000Z',
                decisionPly: 0,
            },
        },
    };
}

function evaluation(
    fen: string,
    cp: number
): EvalResult {
    return {
        fen,
        bestMoveUci: 'a2a3',
        pvUci: ['a2a3'],
        score: { type: 'cp', value: cp },
        depth: 18,
        nodes: 140_000,
    };
}

describe('local practice grading', () => {
    it('grades the original move immediately without touching Stockfish', () => {
        const result = gradeKnownLocalMove({
            manifest: manifest(),
            node: rootNode,
            moveUci: 'e2e4',
        });

        expect(result?.result).toEqual({
            status: 'GRADED',
            grade: 'REPEATED_MISTAKE',
            accepted: false,
        });
        expect(result?.evidence).toMatchObject({
            kind: 'ORIGINAL_MOVE_IDENTITY',
        });
    });

    it('grades a downloaded accepted move synchronously', () => {
        const result = gradeKnownLocalMove({
            manifest: manifest(),
            node: rootNode,
            moveUci: 'd2d4',
        });

        expect(result?.result).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
        expect(result?.source).toBe('PRECOMPUTED');
    });

    it('returns null rather than rejecting an unlisted legal move', () => {
        expect(
            gradeKnownLocalMove({
                manifest: manifest(),
                node: rootNode,
                moveUci: 'a2a3',
            })
        ).toBeNull();
    });

    it('grades every legal move synchronously when the frontier is complete', () => {
        const completeNode = {
            ...rootNode,
            alternativesComplete: true,
        };
        const completeManifest = manifest();
        completeManifest.solutionTree = completeNode;
        completeManifest.acceptanceFrontier = {
            ...completeManifest.acceptanceFrontier,
            status: 'STABLE',
            effectiveCutoffCp: 80,
            boundaryGapCp: 40,
            moves: [{ moveUci: 'd2d4', tier: 'BEST' }],
            firstRejectedMoveUci: 'a2a3',
        };
        const legalMoves = new Chess(rootFen)
            .moves({ verbose: true })
            .map(
                (move) =>
                    `${move.from}${move.to}${move.promotion ?? ''}`
            );

        const results = legalMoves.map((moveUci) => ({
            moveUci,
            evaluation: gradeKnownLocalMove({
                manifest: completeManifest,
                node: completeNode,
                moveUci,
            }),
        }));

        expect(results.every((item) => item.evaluation != null)).toBe(true);
        expect(
            results.find((item) => item.moveUci === 'd2d4')?.evaluation
                ?.result
        ).toMatchObject({ accepted: true, grade: 'BEST' });
        expect(
            results.find((item) => item.moveUci === 'a2a3')?.evaluation
                ?.result
        ).toMatchObject({
            accepted: false,
            grade: 'DIFFERENT_MISTAKE',
        });
    });

    it('uses only the supplied browser engine for an unknown alternative', async () => {
        const evalPosition = vi
            .fn()
            .mockImplementation(
                async ({ fen }: { fen: string }) =>
                    fen === rootFen
                        ? evaluation(fen, 100)
                        : evaluation(fen, -70)
            );
        const engine: StockfishEngine = {
            evalPosition,
            analyzeMultiPv: vi.fn(),
        };

        const result = await gradeUnknownLocalMove({
            engine,
            manifest: manifest(),
            node: rootNode,
            moveUci: 'a2a3',
        });

        expect(evalPosition).toHaveBeenCalledTimes(4);
        expect(result.source).toBe('DYNAMIC');
        expect(result.result).toEqual({
            status: 'GRADED',
            grade: 'STRONG',
            accepted: true,
        });
    });

    it('grades the production Eric Rosen Qb5 regression when cp becomes mate', async () => {
        const fen =
            '4r1k1/5p2/5Ppp/7r/1Q4RP/2P2NK1/8/7q w - - 5 47';
        const afterQb5 =
            '4r1k1/5p2/5Ppp/1Q5r/6RP/2P2NK1/8/7q b - - 6 47';
        const node: TrainingSolutionTreeNodeDto = {
            fen,
            ply: 0,
            role: 'USER',
            acceptedMovesUci: ['g4e4'],
            selectedMoveUci: 'g4e4',
            branches: [],
        };
        const productionManifest: TrainingGradingManifestDto = {
            ...manifest(),
            originalMoveUci: 'b4c4',
            originalScoreAfter: {
                kind: 'mate',
                plies: 1,
                winner: 'BLACK',
            },
            solutionTree: node,
            moveAssessments: [],
            review: {
                ...manifest().review,
                originalMoveUci: 'b4c4',
                bestMoveUci: 'g4e4',
                acceptedMovesUci: ['g4e4'],
            },
        };
        const evalPosition = vi
            .fn()
            .mockResolvedValueOnce({
                ...evaluation(fen, -12),
                wdl: { win: 1, draw: 996, loss: 3 },
            })
            .mockResolvedValueOnce({
                ...evaluation(afterQb5, 1110),
                wdl: { win: 1000, draw: 0, loss: 0 },
            })
            .mockResolvedValueOnce({
                ...evaluation(fen, -17),
                wdl: { win: 1, draw: 995, loss: 4 },
            })
            .mockResolvedValueOnce({
                ...evaluation(afterQb5, 0),
                score: { type: 'mate', value: 7 },
                wdl: { win: 1000, draw: 0, loss: 0 },
            });

        const result = await gradeUnknownLocalMove({
            engine: {
                evalPosition,
                analyzeMultiPv: vi.fn(),
            },
            manifest: productionManifest,
            node,
            moveUci: 'b4b5',
        });

        expect(result.result).toEqual({
            status: 'GRADED',
            grade: 'DIFFERENT_MISTAKE',
            accepted: false,
        });
        expect(result.evidence).toMatchObject({ stable: true });
    });

    it('still refuses a cp-to-mate transition when WDL outcomes disagree', async () => {
        const evalPosition = vi
            .fn()
            .mockResolvedValueOnce({
                ...evaluation(rootFen, 100),
                wdl: { win: 600, draw: 300, loss: 100 },
            })
            .mockResolvedValueOnce({
                ...evaluation(rootFen, -200),
                wdl: { win: 100, draw: 200, loss: 700 },
            })
            .mockResolvedValueOnce({
                ...evaluation(rootFen, 105),
                wdl: { win: 605, draw: 295, loss: 100 },
            })
            .mockResolvedValueOnce({
                ...evaluation(rootFen, 0),
                score: { type: 'mate', value: 5 },
                wdl: { win: 400, draw: 100, loss: 500 },
            });

        const result = await gradeUnknownLocalMove({
            engine: {
                evalPosition,
                analyzeMultiPv: vi.fn(),
            },
            manifest: manifest(),
            node: rootNode,
            moveUci: 'a2a3',
        });

        expect(result.result).toEqual({
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
        expect(result.evidence).toMatchObject({ stable: false });
    });

    it('advances a downloaded conditional line without a request', () => {
        const nextUserNode: TrainingSolutionTreeNodeDto = {
            fen: 'rnbqkbnr/pppp1ppp/8/4p3/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2',
            ply: 2,
            role: 'USER',
            acceptedMovesUci: ['d4e5'],
            branches: [],
        };
        const node: TrainingSolutionTreeNodeDto = {
            ...rootNode,
            branches: [
                {
                    moveUci: 'd2d4',
                    best: true,
                    child: {
                        fen: 'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1',
                        ply: 1,
                        role: 'OPPONENT',
                        acceptedMovesUci: [],
                        selectedMoveUci: 'e7e5',
                        branches: [
                            {
                                moveUci: 'e7e5',
                                best: true,
                                child: nextUserNode,
                            },
                        ],
                    },
                },
            ],
        };

        expect(
            localContinuationForMove({
                node,
                moveUci: 'd2d4',
            })
        ).toEqual({
            opponentMoveUci: 'e7e5',
            fenAfterOpponentMove: nextUserNode.fen,
            nextUserNode,
        });
    });
});
