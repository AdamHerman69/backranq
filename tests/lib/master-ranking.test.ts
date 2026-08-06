import { describe, expect, it } from 'vitest';
import type { TrainingMomentCandidate } from '@/lib/training/contracts';
import {
    masterCandidateKey,
    rankMasterCandidate,
} from '@/lib/master/ranking';

function candidate(
    overrides: Partial<TrainingMomentCandidate> = {}
): TrainingMomentCandidate {
    return {
        sourceGameId: 'snapshot-1',
        sourceProvider: 'lichess',
        sourcePlayedAt: '2026-08-05T12:00:00.000Z',
        sourcePgnHash: 'pgn-hash',
        decisionPly: 28,
        fen: '8/8/8/8/8/8/8/K6k w - - 0 1',
        positionHistory: [],
        sideToMove: 'w',
        originalMoveUci: 'a1a2',
        sourceKinds: ['MY_MISTAKE'],
        lessonKinds: ['AVOID_MISTAKE'],
        themes: ['tactic'],
        originalDecision: {
            scoreBefore: { kind: 'cp', cp: 120, pov: 'WHITE' },
            scoreAfter: { kind: 'cp', cp: -80, pov: 'WHITE' },
            cpLoss: 200,
            winChanceLoss: 0.14,
        },
        confidence: 0.98,
        phase: 'MIDDLEGAME',
        solution: {
            solutionHash: 'solution-hash',
            verificationStatus: 'VERIFIED',
            solutionShape: 'UNIQUE',
            gradingStrategy: 'PRECOMPUTED',
            continuationShape: 'SINGLE_DECISION',
            trainable: true,
            bestMoveUci: 'a1b1',
            acceptedMovesUci: ['a1b1'],
            acceptanceFrontier: {
                version: 1,
                status: 'STABLE',
                targetCutoffCp: 100,
                effectiveCutoffCp: 70,
                boundaryGapCp: 40,
                moves: [{ moveUci: 'a1b1', tier: 'BEST' }],
                firstRejectedMoveUci: 'a1a2',
            },
            moveAssessments: [],
            bestLineUci: ['a1b1', 'h1g1', 'b1c1'],
            solutionTree: {},
            scoreAtStart: { kind: 'cp', cp: 120, pov: 'WHITE' },
            playedMoveScore: { kind: 'cp', cp: -80, pov: 'WHITE' },
            targetOutcome: {},
            gradingPolicy: {
                version: 3,
                pov: 'TRAINING_SIDE',
                best: { maxCpLoss: 15, maxWinChanceLoss: 0.02 },
                strong: { maxCpLoss: 50, maxWinChanceLoss: 0.05 },
                success: {
                    maxCpLoss: 80,
                    maxWinChanceLoss: 0.08,
                    preserveOutcome: true,
                },
                improvement: {
                    minRecoveredCp: 40,
                    minRecoveredWinChance: 0.04,
                },
                unknownMove: 'REJECT_OUTSIDE_ACCEPTED_SET',
                matePolicy: 'EXACT',
                tablebasePolicy: 'EXACT',
            },
            evidence: {},
            generatorVersion: 'test',
            configHash: 'config',
        },
        ...overrides,
    };
}

describe('Weekly Master candidate ranking', () => {
    it('passes only high-confidence meaningful verified positions', () => {
        const ranking = rankMasterCandidate({
            moment: candidate(),
            playedAt: new Date('2026-08-05T12:00:00.000Z'),
            personPriority: 90,
            now: new Date('2026-08-06T12:00:00.000Z'),
        });

        expect(ranking.hardGatePassed).toBe(true);
        expect(ranking.rejectionReasons).toEqual([]);
        expect(ranking.totalScore).toBeGreaterThan(70);
    });

    it('rejects ambiguous evidence and moves that are not meaningful mistakes', () => {
        const base = candidate();
        const ranking = rankMasterCandidate({
            moment: candidate({
                originalDecision: {
                    ...base.originalDecision,
                    cpLoss: 30,
                    winChanceLoss: 0.01,
                },
                solution: {
                    ...base.solution,
                    verificationStatus: 'AMBIGUOUS',
                    solutionShape: 'OPEN',
                },
            }),
            playedAt: new Date('2026-08-05T12:00:00.000Z'),
            personPriority: 90,
            now: new Date('2026-08-06T12:00:00.000Z'),
        });

        expect(ranking.hardGatePassed).toBe(false);
        expect(ranking.rejectionReasons).toEqual(
            expect.arrayContaining([
                'NOT_VERIFIED',
                'OPEN_SOLUTION',
                'MISTAKE_NOT_MEANINGFUL',
            ])
        );
    });

    it('never labels the played move a mistake when the grader accepts it', () => {
        const base = candidate();
        const ranking = rankMasterCandidate({
            moment: candidate({
                solution: {
                    ...base.solution,
                    acceptedMovesUci: ['a1b1', 'a1a2'],
                },
            }),
            playedAt: new Date('2026-08-05T12:00:00.000Z'),
            personPriority: 90,
            now: new Date('2026-08-06T12:00:00.000Z'),
        });

        expect(ranking.hardGatePassed).toBe(false);
        expect(ranking.rejectionReasons).toContain(
            'ORIGINAL_MOVE_IS_ACCEPTED'
        );
    });

    it('includes the featured person in deterministic candidate identity', () => {
        expect(
            masterCandidateKey({
                snapshotId: 'snapshot',
                personId: 'person-a',
                decisionPly: 12,
                configHash: 'config',
            })
        ).not.toBe(
            masterCandidateKey({
                snapshotId: 'snapshot',
                personId: 'person-b',
                decisionPly: 12,
                configHash: 'config',
            })
        );
    });
});
