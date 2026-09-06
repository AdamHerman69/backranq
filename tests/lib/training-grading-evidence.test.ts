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
    > = {},
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
    it('requires the cp tolerance even when matched WDL is saturated', () => {
        const metrics = matched();

        expect(metrics).toMatchObject({
            bestGapCp: 1_000,
            bestGapWinChance: 0.005,
            preservesOutcome: null,
            stable: true,
        });
        expect(gradeTrainingMove(metrics, policy)).toEqual({
            status: 'GRADED',
            grade: 'IMPROVED',
            accepted: false,
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
            preservesOutcome: null,
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
            preservesOutcome: null,
        });
        expect(gradeTrainingMove(metrics, policy)).toEqual({
            status: 'GRADED',
            grade: 'STRONG',
            accepted: true,
        });
    });

    it('keeps unstable and missing matched evidence unresolved', () => {
        expect(
            gradeTrainingMove(
                matched({
                    stable: false,
                }),
                policy,
            ),
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
                policy,
            ),
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
        expect(gradeTrainingMove(nonTablebase, policy)).toMatchObject({
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

describe('mixed exact and statistical outcome direction', () => {
    const loss = { kind: 'mate', plies: 5, winner: 'BLACK' } as const;
    const win = { kind: 'mate', plies: 5, winner: 'WHITE' } as const;
    const draw = { kind: 'tablebase', wdl: 'DRAW', pov: 'WHITE' } as const;
    it('can reject a forced losing mate using a compatible matched expected-score loss without assigning exact outcome to cp', () => {
        const metrics = matched({
            bestScore: cp(200),
            submittedScore: loss,
            bestWdlChance: 0.9,
            submittedWdlChance: 0,
        });
        expect(metrics).toMatchObject({
            bestGapCp: null,
            bestGapWinChance: 0.9,
            preservesOutcome: null,
            evidenceModel: 'MATCHED_WDL',
            referenceOutdated: false,
        });
        expect(gradeTrainingMove(metrics, policy)).toMatchObject({
            status: 'GRADED',
            accepted: false,
        });
    });
    it('requires a new reference for a proven winning move beyond a cp reference', () => {
        expect(
            matched({
                bestScore: cp(200),
                submittedScore: win,
                bestWdlChance: 0.9,
                submittedWdlChance: 1,
            }).referenceOutdated,
        ).toBe(true);
    });
    it('does not label a known draw as a new best when matched expected score is lower', () => {
        const metrics = matched({
            bestScore: cp(200),
            submittedScore: draw,
            bestWdlChance: 0.9,
            submittedWdlChance: 0.5,
        });
        expect(metrics.referenceOutdated).toBe(false);
        expect(gradeTrainingMove(metrics, policy)).toMatchObject({
            status: 'GRADED',
            accepted: false,
        });
    });
    it('cannot reject or accept a close mixed result solely because a cp gap is unavailable', () => {
        const metrics = matched({
            bestScore: cp(20),
            submittedScore: draw,
            bestWdlChance: 0.55,
            submittedWdlChance: 0.5,
        });
        expect(gradeTrainingMove(metrics, policy).status).toBe('UNRESOLVED');
        expect(
            gradeTrainingMove(
                matched({
                    bestScore: cp(200),
                    submittedScore: loss,
                    bestWdlChance: null,
                    submittedWdlChance: null,
                }),
                policy,
            ).status,
        ).toBe('UNRESOLVED');
    });
    it('compares proven mate and tablebase outcomes without requiring the same encoding', () => {
        const metrics = matched({
            bestScore: win,
            submittedScore: { kind: 'tablebase', wdl: 'WIN', pov: 'WHITE' },
        });
        expect(gradeTrainingMove(metrics, policy)).toMatchObject({
            status: 'GRADED',
            accepted: true,
        });
        expect(
            matched({ bestScore: draw, submittedScore: win }).referenceOutdated,
        ).toBe(true);
    });
});
