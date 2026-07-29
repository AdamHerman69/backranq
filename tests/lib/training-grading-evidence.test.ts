import { describe, expect, it } from 'vitest';
import { normalizeGradingPolicy } from '@/lib/training/config';
import { metricsFromMatchedOutcomeEvidence } from '@/lib/training/gradingEvidence';
import { gradeTrainingMove } from '@/lib/training/grader';

const policy = normalizeGradingPolicy(undefined, 'PRACTICAL');
const cp = (value: number) =>
    ({ kind: 'cp', cp: value, pov: 'WHITE' }) as const;

function matched(
    overrides: Partial<
        Parameters<typeof metricsFromMatchedOutcomeEvidence>[0]
    > = {}
) {
    return metricsFromMatchedOutcomeEvidence({
        moveUci: 'e2e4',
        originalMoveUci: 'a2a3',
        trainingSide: 'w',
        bestScore: cp(1_000),
        submittedScore: cp(0),
        originalScore: cp(-100),
        bestWdlChance: 0.9,
        submittedWdlChance: 0.895,
        stable: true,
        ...overrides,
    });
}

describe('matched dynamic grading evidence', () => {
    it('uses matched WDL before a contradictory centipawn gap', () => {
        const metrics = matched();

        expect(metrics).toMatchObject({
            bestGapCp: 1_000,
            bestGapWinChance: 0.005,
            preservesOutcome: true,
            stable: true,
        });
        expect(gradeTrainingMove(metrics, policy)).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
    });

    it('does not accept a cp-equal move when WDL loses the outcome', () => {
        const metrics = matched({
            bestScore: cp(0),
            submittedScore: cp(0),
            originalScore: cp(0),
            bestWdlChance: 0.7,
            submittedWdlChance: 0.4,
        });

        expect(metrics).toMatchObject({
            bestGapCp: 0,
            bestGapWinChance: 0.3,
            preservesOutcome: false,
        });
        expect(gradeTrainingMove(metrics, policy)).toEqual({
            status: 'GRADED',
            grade: 'DIFFERENT_MISTAKE',
            accepted: false,
        });
    });

    it('falls back to cp without inventing WDL evidence', () => {
        const metrics = matched({
            bestScore: cp(100),
            submittedScore: cp(65),
            originalScore: cp(-100),
            bestWdlChance: null,
            submittedWdlChance: null,
        });

        expect(metrics).toMatchObject({
            bestGapCp: 35,
            bestGapWinChance: null,
            preservesOutcome: true,
        });
        expect(gradeTrainingMove(metrics, policy)).toEqual({
            status: 'GRADED',
            grade: 'GOOD',
            accepted: true,
        });
    });

    it('keeps unstable and missing matched evidence unresolved', () => {
        expect(
            gradeTrainingMove(
                matched({
                    stable: false,
                }),
                policy
            )
        ).toEqual({
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
        expect(
            gradeTrainingMove(
                matched({
                    bestScore: null,
                    submittedScore: null,
                    bestWdlChance: null,
                    submittedWdlChance: null,
                }),
                policy
            )
        ).toEqual({
            status: 'UNRESOLVED',
            reason: 'UNSTABLE_EVIDENCE',
        });
    });

    it('treats a forced mate as an explicit outcome', () => {
        const bestMate = {
            kind: 'mate',
            plies: 5,
            winner: 'WHITE',
        } as const;
        const lostMate = matched({
            bestScore: bestMate,
            submittedScore: cp(10_000),
            bestWdlChance: 1,
            submittedWdlChance: 1,
        });
        expect(lostMate).toMatchObject({
            bestGapCp: null,
            bestGapWinChance: 1,
            preservesOutcome: false,
        });
        expect(gradeTrainingMove(lostMate, policy)).toMatchObject({
            status: 'GRADED',
            accepted: false,
        });

        const preservedMate = matched({
            bestScore: bestMate,
            submittedScore: {
                kind: 'mate',
                plies: 9,
                winner: 'WHITE',
            },
            bestWdlChance: 1,
            submittedWdlChance: 1,
        });
        expect(gradeTrainingMove(preservedMate, policy)).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
    });

    it('does not mix an exact tablebase best outcome with cp evidence', () => {
        const bestTablebase = {
            kind: 'tablebase',
            wdl: 'WIN',
            pov: 'WHITE',
        } as const;
        const nonTablebase = matched({
            bestScore: bestTablebase,
            submittedScore: cp(10_000),
            bestWdlChance: 1,
            submittedWdlChance: 1,
        });
        expect(nonTablebase).toMatchObject({
            bestGapCp: null,
            bestGapWinChance: 1,
            preservesOutcome: false,
        });
        expect(
            gradeTrainingMove(nonTablebase, policy)
        ).toMatchObject({
            status: 'GRADED',
            accepted: false,
        });

        const exactWin = matched({
            bestScore: bestTablebase,
            submittedScore: {
                kind: 'tablebase',
                wdl: 'WIN',
                pov: 'WHITE',
                dtz: 7,
            },
        });
        expect(gradeTrainingMove(exactWin, policy)).toEqual({
            status: 'GRADED',
            grade: 'BEST',
            accepted: true,
        });
    });
});
