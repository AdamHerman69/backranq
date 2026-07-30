import { describe, expect, it, vi } from 'vitest';

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
            version: 2,
            pov: 'TRAINING_SIDE',
            best: { maxCpLoss: 20, maxWinChanceLoss: 0.03 },
            success: {
                maxCpLoss: 80,
                maxWinChanceLoss: 0.08,
                preserveOutcome: true,
            },
            improvement: {
                minRecoveredCp: 50,
                minRecoveredWinChance: 0.05,
            },
            unknownMove: 'DYNAMIC',
            matePolicy: 'EXACT',
            tablebasePolicy: 'EXACT',
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
            grade: 'GOOD',
            accepted: true,
        });
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
