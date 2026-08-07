import { describe, expect, it } from 'vitest';

import {
    hashCanonicalTrainingValue,
    mergeTrainingMomentMetadata,
    solutionSemanticsHash,
    stableCanonicalStringify,
    trainingMomentKey,
} from '@/lib/training/contracts';
import {
    normalizeGradingPolicy,
    resolveTrainingConfig,
    trainingConfigHash,
} from '@/lib/training/config';

describe('training moment contracts', () => {
    it('creates a canonical moment key from game, PGN revision and decision ply', () => {
        const canonical = trainingMomentKey({
            gameId: '11111111-1111-4111-8111-111111111111',
            sourcePgnHash: 'ABCDEF',
            decisionPly: 31,
        });
        const normalized = trainingMomentKey({
            gameId: ' 11111111-1111-4111-8111-111111111111 ',
            sourcePgnHash: ' abcdef ',
            decisionPly: 31,
        });

        expect(canonical).toBe(normalized);
        expect(canonical).toMatch(/^[a-f0-9]{64}$/);
        expect(
            trainingMomentKey({
                gameId: '11111111-1111-4111-8111-111111111111',
                sourcePgnHash: 'different-pgn',
                decisionPly: 31,
            })
        ).not.toBe(canonical);
        expect(
            trainingMomentKey({
                gameId: '11111111-1111-4111-8111-111111111111',
                sourcePgnHash: 'abcdef',
                decisionPly: 32,
            })
        ).not.toBe(canonical);
    });

    it('rejects incomplete or unsafe moment identities', () => {
        expect(() =>
            trainingMomentKey({
                gameId: '',
                sourcePgnHash: 'hash',
                decisionPly: 1,
            })
        ).toThrow(/gameId is required/);
        expect(() =>
            trainingMomentKey({
                gameId: 'game',
                sourcePgnHash: 'hash',
                decisionPly: -1,
            })
        ).toThrow(/decisionPly/);
        expect(() =>
            trainingMomentKey({
                gameId: 'game',
                sourcePgnHash: 'hash',
                decisionPly: 1.5,
            })
        ).toThrow(/decisionPly/);
    });

    it('merges avoid and punish reasons into one deterministic metadata set', () => {
        const metadata = mergeTrainingMomentMetadata(
            {
                sourceKinds: ['MISSED_OPPORTUNITY'],
                lessonKinds: ['PUNISH_MISTAKE'],
                themes: [' quietMove ', 'defensiveMove'],
            },
            {
                sourceKinds: ['MY_MISTAKE', 'MISSED_OPPORTUNITY'],
                lessonKinds: ['AVOID_MISTAKE', 'PUNISH_MISTAKE'],
                themes: ['quietMove'],
            }
        );

        expect(metadata).toEqual({
            sourceKinds: ['MY_MISTAKE', 'MISSED_OPPORTUNITY'],
            lessonKinds: ['AVOID_MISTAKE', 'PUNISH_MISTAKE'],
            themes: ['defensivemove', 'quietmove'],
        });
    });

    it('hashes canonical JSON independently of object key order', () => {
        const left = {
            z: 1,
            nested: { b: true, a: ['x', 2] },
            omitted: undefined,
        };
        const right = {
            nested: { a: ['x', 2], b: true },
            z: 1,
        };

        expect(stableCanonicalStringify(left)).toBe(
            stableCanonicalStringify(right)
        );
        expect(hashCanonicalTrainingValue(left)).toBe(
            hashCanonicalTrainingValue(right)
        );
    });

    it('hashes equivalent solution semantics independently of accepted-move order', () => {
        const base = {
            verificationStatus: 'VERIFIED' as const,
            solutionShape: 'MULTIPLE' as const,
            gradingStrategy: 'DYNAMIC' as const,
            continuationShape: 'SINGLE_DECISION' as const,
            trainable: true,
            bestMoveUci: 'E2E4',
            acceptedMovesUci: ['d2d4', 'e2e4'],
            acceptanceFrontier: {
                version: 1 as const,
                status: 'STABLE' as const,
                targetCutoffCp: 100,
                effectiveCutoffCp: 80,
                boundaryGapCp: 40,
                moves: [
                    { moveUci: 'e2e4', tier: 'BEST' as const },
                    { moveUci: 'd2d4', tier: 'GOOD' as const },
                ],
                firstRejectedMoveUci: 'g1f3',
            },
            moveAssessments: [
                {
                    positionKey: 'root',
                    decisionIndex: 0,
                    fen: 'fen',
                    moveUci: 'e2e4',
                    source: 'PRECOMPUTED' as const,
                    grade: 'BEST' as const,
                    scoreAfter: null,
                    evidence: { depth: 20 },
                },
                {
                    positionKey: 'root',
                    decisionIndex: 0,
                    fen: 'fen',
                    moveUci: 'd2d4',
                    source: 'PRECOMPUTED' as const,
                    grade: 'GOOD' as const,
                    scoreAfter: null,
                    evidence: { depth: 20 },
                },
            ],
            bestLineUci: ['E2E4', 'e7e5'],
            solutionTree: {
                fen: 'fen',
                ply: 0,
                role: 'USER',
                acceptedMovesUci: ['e2e4'],
                selectedMoveUci: 'e2e4',
                alternativesComplete: true,
                tablebase: {
                    fetchedAt: '2026-01-01T00:00:00.000Z',
                    dtz: 7,
                },
                branches: [
                    {
                        moveUci: 'e2e4',
                        best: true,
                        evaluation: { source: 'ENGINE', nodes: 100_000 },
                        child: {
                            fen: 'after',
                            ply: 1,
                            role: 'TERMINAL',
                            acceptedMovesUci: [],
                            alternativesComplete: true,
                            branches: [],
                            stopReason: 'MAX_PLIES',
                        },
                    },
                ],
            },
            scoreAtStart: {
                kind: 'cp' as const,
                cp: 20,
                pov: 'WHITE' as const,
            },
            playedMoveScore: null,
            targetOutcome: { preserve: 'DRAW' },
            gradingPolicy: normalizeGradingPolicy(undefined),
        };

        expect(solutionSemanticsHash(base)).toBe(
            solutionSemanticsHash({
                ...base,
                bestMoveUci: 'e2e4',
                acceptedMovesUci: ['e2e4', 'd2d4', 'd2d4'],
                moveAssessments: base.moveAssessments.slice().reverse(),
                bestLineUci: ['e2e4', 'e7e5'],
                solutionTree: {
                    ...base.solutionTree,
                    tablebase: {
                        fetchedAt: '2030-12-31T23:59:59.000Z',
                        dtz: 99,
                    },
                    branches: [
                        {
                            ...base.solutionTree.branches[0],
                            evaluation: {
                                source: 'ENGINE',
                                nodes: 9_999_999,
                                depth: 40,
                            },
                        },
                    ],
                },
            })
        );
        expect(solutionSemanticsHash(base)).toBe(
            solutionSemanticsHash({
                ...base,
                moveAssessments: base.moveAssessments.map(
                    (assessment) => ({
                        ...assessment,
                        evidence: {
                            depth: 99,
                            nodes: 9_999_999,
                            provider: 'different-engine-host',
                            elapsedMs: 12_345,
                        },
                    })
                ),
            })
        );
        expect(
            solutionSemanticsHash({
                ...base,
                solutionTree: {
                    ...base.solutionTree,
                    selectedMoveUci: 'd2d4',
                    branches: [
                        {
                            ...base.solutionTree.branches[0],
                            moveUci: 'd2d4',
                        },
                    ],
                },
            })
        ).not.toBe(solutionSemanticsHash(base));
        expect(
            solutionSemanticsHash({
                ...base,
                moveAssessments: base.moveAssessments.map(
                    (assessment, index) =>
                        index === 0
                            ? {
                                  ...assessment,
                                  evidence: {
                                      ...assessment.evidence,
                                      bestGapCp: 21,
                                      bestGapWinChance: 0.04,
                                      recoveredCp: 90,
                                      recoveredWinChance: 0.2,
                                      preservesOutcome: true,
                                  },
                              }
                            : assessment
                ),
            })
        ).not.toBe(solutionSemanticsHash(base));
        expect(
            solutionSemanticsHash({
                ...base,
                moveAssessments: base.moveAssessments.map(
                    (assessment, index) =>
                        index === 0
                            ? {
                                  ...assessment,
                                  evidence: {
                                      ...assessment.evidence,
                                      evaluation: {
                                          source: 'ENGINE',
                                          score: {
                                              type: 'cp',
                                              value: 20,
                                          },
                                          wdl: {
                                              win: 400,
                                              draw: 500,
                                              loss: 100,
                                          },
                                      },
                                  },
                              }
                            : assessment
                ),
            })
        ).not.toBe(solutionSemanticsHash(base));
    });
});

describe('training config normalization', () => {
    it('defaults to broad coverage with practical outcome grading', () => {
        const config = resolveTrainingConfig();

        expect(config).toMatchObject({
            version: 3,
            coveragePreset: 'ALL_CONFIRMED',
            minWinChanceLoss: 0.03,
            fallbackMinCpLoss: 30,
            gradingTolerance: 'PRACTICAL',
            gradingPolicy: {
                pov: 'TRAINING_SIDE',
                unknownMove: 'REJECT_OUTSIDE_ACCEPTED_SET',
                matePolicy: 'EXACT',
                tablebasePolicy: 'EXACT',
            },
        });
    });

    it('clamps numeric settings and never makes best looser than success', () => {
        const policy = normalizeGradingPolicy(
            {
                best: {
                    maxCpLoss: 300,
                    maxWinChanceLoss: 0.8,
                },
                success: {
                    maxCpLoss: -100,
                    maxWinChanceLoss: -1,
                    preserveOutcome: false,
                },
                improvement: {
                    minRecoveredCp: Number.POSITIVE_INFINITY,
                    minRecoveredWinChance: 4,
                },
            },
            'STRICT'
        );

        expect(policy.best).toEqual({
            maxCpLoss: 300,
            maxWinChanceLoss: 0.8,
        });
        expect(policy.success).toEqual({
            maxCpLoss: 300,
            maxWinChanceLoss: 0.8,
            preserveOutcome: false,
        });
        expect(policy.improvement).toEqual({
            minRecoveredCp: 50,
            minRecoveredWinChance: 1,
        });
    });

    it('uses preset-specific extraction and grading defaults', () => {
        const config = resolveTrainingConfig({
            coveragePreset: 'HIGH_CONFIDENCE',
            gradingTolerance: 'LENIENT',
        });

        expect(config).toMatchObject({
            coveragePreset: 'HIGH_CONFIDENCE',
            minWinChanceLoss: 0.12,
            fallbackMinCpLoss: 150,
            gradingTolerance: 'LENIENT',
        });
    });

    it('produces the same hash for raw and already-resolved equivalent config', () => {
        const raw = {
            coveragePreset: 'BALANCED' as const,
            gradingTolerance: 'STRICT' as const,
        };
        const resolved = resolveTrainingConfig(raw);

        expect(trainingConfigHash(raw)).toBe(trainingConfigHash(resolved));
    });
});
