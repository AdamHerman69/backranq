import { describe, expect, it } from 'vitest';

import type { UserMoveAssessment } from '@/lib/coach/assessment';
import {
    buildCoachVerification,
    COACH_CONFIRMATION_NODES,
    COACH_FIRST_PASS_NODES,
    COACH_THRESHOLD_DEFAULT_CP,
    COACH_THRESHOLD_MAX_CP,
    COACH_THRESHOLD_MIN_CP,
    normalizeCoachThresholdCp,
    shouldConfirmCoachAssessment,
} from '@/lib/coach/verification';

function cpAssessment(lossCp: number | null): UserMoveAssessment {
    return {
        loss: {
            cp: lossCp,
            winningChance: null,
        },
        shouldIntervene: lossCp != null,
        severity: 'inaccuracy',
        playerEvaluationAfter: {
            score: { type: 'cp', value: 0 },
        },
        outcomeReason: null,
    };
}

describe('coach threshold normalization', () => {
    it('parses, rounds, clamps, and defaults custom threshold input', () => {
        expect(normalizeCoachThresholdCp(COACH_THRESHOLD_MIN_CP - 1)).toBe(
            COACH_THRESHOLD_MIN_CP
        );
        expect(normalizeCoachThresholdCp('149.6')).toBe(150);
        expect(normalizeCoachThresholdCp(20.5)).toBe(21);
        expect(normalizeCoachThresholdCp(COACH_THRESHOLD_MAX_CP + 1)).toBe(
            COACH_THRESHOLD_MAX_CP
        );
        for (const invalid of [undefined, null, '', 'nope', Number.NaN, Infinity]) {
            expect(normalizeCoachThresholdCp(invalid)).toBe(
                COACH_THRESHOLD_DEFAULT_CP
            );
        }
    });

    it('gates confirmation to the configured approach band', () => {
        expect(shouldConfirmCoachAssessment(cpAssessment(null), 100)).toBe(
            false
        );
        expect(shouldConfirmCoachAssessment(cpAssessment(69), 100)).toBe(
            false
        );
        expect(shouldConfirmCoachAssessment(cpAssessment(70), 100)).toBe(
            true
        );
        expect(shouldConfirmCoachAssessment(cpAssessment(299), 400)).toBe(
            false
        );
        expect(shouldConfirmCoachAssessment(cpAssessment(300), 400)).toBe(
            true
        );
    });

    it('confirms every measurable move at the strictest threshold and every mate transition', () => {
        expect(shouldConfirmCoachAssessment(cpAssessment(0), 20)).toBe(true);
        expect(
            shouldConfirmCoachAssessment(
                {
                    ...cpAssessment(null),
                    outcomeReason: 'allowed-forced-mate',
                },
                1_000
            )
        ).toBe(true);
    });
});

describe('two-pass coach verification', () => {
    it('returns transparent first-pass evidence when confirmation is not supplied', () => {
        const result = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 80 },
            },
            firstPassAfter: {
                // Player POV after inversion is -40, so loss is 120.
                score: { type: 'cp', value: 40 },
            },
            thresholdCp: 100,
        });

        expect(result.assessment.loss.cp).toBe(120);
        expect(result.assessment.shouldIntervene).toBe(true);
        expect(result.evidence).toEqual({
            firstPassNodes: COACH_FIRST_PASS_NODES,
            confirmationNodes: null,
            firstPassLossCp: 120,
            confirmedLossCp: null,
            confirmationRan: false,
            stable: true,
            interventionConfirmed: false,
        });
    });

    it('confirms a stable CP threshold crossing', () => {
        const result = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 100 },
            },
            firstPassAfter: {
                score: { type: 'cp', value: 80 },
            },
            confirmedBefore: {
                score: { type: 'cp', value: 110 },
            },
            confirmedAfter: {
                score: { type: 'cp', value: 70 },
            },
            thresholdCp: 100,
        });

        expect(result.assessment.loss.cp).toBe(180);
        expect(result.assessment.shouldIntervene).toBe(true);
        expect(result.evidence).toMatchObject({
            firstPassNodes: COACH_FIRST_PASS_NODES,
            confirmationNodes: COACH_CONFIRMATION_NODES,
            firstPassLossCp: 180,
            confirmedLossCp: 180,
            confirmationRan: true,
            stable: true,
            interventionConfirmed: true,
        });
    });

    it('suppresses an unstable CP crossing even when confirmation exceeds the threshold', () => {
        const result = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 100 },
            },
            firstPassAfter: {
                score: { type: 'cp', value: 20 },
            },
            confirmedBefore: {
                score: { type: 'cp', value: 160 },
            },
            confirmedAfter: {
                score: { type: 'cp', value: 40 },
            },
            thresholdCp: 100,
        });

        expect(result.evidence.firstPassLossCp).toBe(120);
        expect(result.evidence.confirmedLossCp).toBe(200);
        expect(result.evidence.stable).toBe(false);
        expect(result.evidence.interventionConfirmed).toBe(false);
        expect(result.assessment.shouldIntervene).toBe(false);
    });

    it('keeps a stable confirmed result below threshold non-intervening', () => {
        const result = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 60 },
            },
            firstPassAfter: {
                score: { type: 'cp', value: 40 },
            },
            confirmedBefore: {
                score: { type: 'cp', value: 50 },
            },
            confirmedAfter: {
                score: { type: 'cp', value: 30 },
            },
            thresholdCp: 100,
        });

        expect(result.evidence.stable).toBe(true);
        expect(result.evidence.confirmedLossCp).toBe(80);
        expect(result.assessment.shouldIntervene).toBe(false);
        expect(result.evidence.interventionConfirmed).toBe(false);
    });

    it('confirms the same explicit mate transition across both passes', () => {
        const result = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 0 },
            },
            firstPassAfter: {
                score: { type: 'mate', value: 3 },
            },
            confirmedBefore: {
                score: { type: 'cp', value: 15 },
            },
            confirmedAfter: {
                score: { type: 'mate', value: 2 },
            },
            thresholdCp: 1_000,
        });

        expect(result.assessment.outcomeReason).toBe(
            'allowed-forced-mate'
        );
        expect(result.evidence.stable).toBe(true);
        expect(result.evidence.interventionConfirmed).toBe(true);
        expect(result.assessment.shouldIntervene).toBe(true);
    });

    it('suppresses contradictory mate evidence between passes', () => {
        const result = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 0 },
            },
            firstPassAfter: {
                score: { type: 'mate', value: 3 },
            },
            confirmedBefore: {
                score: { type: 'cp', value: 0 },
            },
            confirmedAfter: {
                score: { type: 'cp', value: 250 },
            },
            thresholdCp: 100,
        });

        expect(result.evidence.stable).toBe(false);
        expect(result.evidence.interventionConfirmed).toBe(false);
        expect(result.assessment.shouldIntervene).toBe(false);
    });

    it('applies normalized custom threshold bounds throughout verification', () => {
        const belowMinimum = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 10 },
            },
            firstPassAfter: {
                // 15 cp loss after inversion.
                score: { type: 'cp', value: 5 },
            },
            thresholdCp: 0,
        });
        const aboveMaximum = buildCoachVerification({
            firstPassBefore: {
                score: { type: 'cp', value: 500 },
            },
            firstPassAfter: {
                // 1,000 cp loss after inversion.
                score: { type: 'cp', value: 500 },
            },
            thresholdCp: 2_000,
        });

        expect(belowMinimum.assessment.loss.cp).toBe(15);
        expect(belowMinimum.assessment.shouldIntervene).toBe(false);
        expect(aboveMaximum.assessment.loss.cp).toBe(1_000);
        expect(aboveMaximum.assessment.shouldIntervene).toBe(true);
    });
});
