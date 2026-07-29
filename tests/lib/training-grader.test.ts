import { describe, expect, it } from 'vitest';

import { normalizeGradingPolicy } from '@/lib/training/config';
import {
    gradeTrainingMove,
    type TrainingMoveMetrics,
} from '@/lib/training/grader';

const policy = normalizeGradingPolicy(undefined, 'PRACTICAL');

function metrics(
    overrides: Partial<TrainingMoveMetrics> = {}
): TrainingMoveMetrics {
    return {
        moveUci: 'e2e4',
        originalMoveUci: 'a2a3',
        stable: true,
        bestGapCp: 0,
        bestGapWinChance: null,
        recoveredCp: 120,
        recoveredWinChance: null,
        preservesOutcome: true,
        ...overrides,
    };
}

describe('gradeTrainingMove', () => {
    it('grades a practically optimal move as BEST', () => {
        expect(gradeTrainingMove(metrics({ bestGapCp: 10 }), policy)).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
    });

    it('accepts a good equivalent without requiring exact bestmove equality', () => {
        expect(gradeTrainingMove(metrics({ bestGapCp: 35 }), policy)).toEqual({
            status: 'GRADED',
            grade: 'GOOD',
            accepted: true,
        });
    });

    it('reports a meaningful improvement separately from success', () => {
        expect(
            gradeTrainingMove(
                metrics({ bestGapCp: 90, recoveredCp: 60 }),
                policy
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'IMPROVED',
            accepted: false,
        });
    });

    it('recognizes the original move as a repeated mistake', () => {
        expect(
            gradeTrainingMove(
                metrics({ moveUci: ' A2A3 ', bestGapCp: 250 }),
                policy
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'REPEATED_MISTAKE',
            accepted: false,
        });
    });

    it('distinguishes another serious mistake from the original one', () => {
        expect(
            gradeTrainingMove(
                metrics({ bestGapCp: 250, recoveredCp: 10 }),
                policy
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'DIFFERENT_MISTAKE',
            accepted: false,
        });
    });

    it('does not call unstable or missing evidence wrong', () => {
        expect(
            gradeTrainingMove(metrics({ stable: false }), policy)
        ).toEqual({
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
        expect(
            gradeTrainingMove(
                metrics({
                    bestGapCp: null,
                    bestGapWinChance: null,
                }),
                policy
            )
        ).toEqual({
            status: 'UNRESOLVED',
            reason: 'MISSING_OUTCOME_EVIDENCE',
        });
        expect(
            gradeTrainingMove(
                metrics({
                    preservesOutcome: null,
                }),
                policy
            )
        ).toEqual({
            status: 'UNRESOLVED',
            reason: 'MISSING_OUTCOME_EVIDENCE',
        });
    });

    it('uses winning-chance evidence before contradictory centipawn evidence', () => {
        expect(
            gradeTrainingMove(
                metrics({
                    bestGapCp: 500,
                    bestGapWinChance: 0.01,
                }),
                policy
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
    });

    it('requires outcome preservation when the policy says so', () => {
        expect(
            gradeTrainingMove(
                metrics({
                    bestGapCp: 0,
                    recoveredCp: 0,
                    preservesOutcome: false,
                }),
                policy
            )
        ).toEqual({
            status: 'GRADED',
            grade: 'DIFFERENT_MISTAKE',
            accepted: false,
        });
    });
});
