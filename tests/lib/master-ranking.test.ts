import { practiceV4Fixture } from '../helpers/practice-v4';
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
        originalMoveUci: 'a2a3',
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
        solution: { configHash: 'config', manifest: (() => {
            const manifest = practiceV4Fixture();
            manifest.rootAnswerIndex.readiness = 'ALL_MOVES_CLASSIFIED';
            manifest.rootAnswerIndex.unresolvedMovesUci = [];
            return manifest;
        })() },
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
                    manifest: { ...base.solution.manifest, decision: { ...base.solution.manifest.decision, status: 'UNRESOLVED', selection: 'OMITTED' }, rootAnswerIndex: { ...base.solution.manifest.rootAnswerIndex, readiness: 'PARTIAL' } },
                },
            }),
            playedAt: new Date('2026-08-05T12:00:00.000Z'),
            personPriority: 90,
            now: new Date('2026-08-06T12:00:00.000Z'),
        });

        expect(ranking.hardGatePassed).toBe(false);
        expect(ranking.rejectionReasons).toEqual(
            expect.arrayContaining([
                'DECISION_NOT_CONFIRMED',
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
                    manifest: { ...base.solution.manifest, assessments: base.solution.manifest.assessments.map(assessment => assessment.moveUci === 'a2a3' ? { ...assessment, quality: 'GOOD', qualitySupport: 'SUPPORTED' } : assessment) },
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
                evidenceHash: 'evidence-1',
            })
        ).not.toBe(
            masterCandidateKey({
                snapshotId: 'snapshot',
                personId: 'person-b',
                decisionPly: 12,
                configHash: 'config',
                evidenceHash: 'evidence-1',
            })
        );
    });
    it('pins a different candidate when physical evidence changes without changing the source', () => {
        const source = { snapshotId: 'snapshot', personId: 'person', decisionPly: 12, configHash: 'config' };
        expect(masterCandidateKey({...source,evidenceHash:'old'})).not.toBe(masterCandidateKey({...source,evidenceHash:'new'}));
    });

});
