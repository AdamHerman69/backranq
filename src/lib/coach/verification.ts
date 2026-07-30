import type { MultiPvResult } from '@/lib/analysis/stockfishClient';
import {
    assessUserMove,
    type EngineEvaluation,
    type UserMoveAssessment,
} from '@/lib/coach/assessment';

export const COACH_THRESHOLD_MIN_CP = 20;
export const COACH_THRESHOLD_MAX_CP = 1_000;
export const COACH_THRESHOLD_DEFAULT_CP = 100;
export const COACH_FIRST_PASS_NODES = 70_000;
export const COACH_CONFIRMATION_NODES = 240_000;
export const COACH_OPPONENT_NODES = 90_000;
export const COACH_OPPONENT_MULTIPV = 5;

export type CoachVerificationEvidence = {
    firstPassNodes: number;
    confirmationNodes: number | null;
    firstPassLossCp: number | null;
    confirmedLossCp: number | null;
    confirmationRan: boolean;
    stable: boolean;
    interventionConfirmed: boolean;
};

export function normalizeCoachThresholdCp(value: unknown): number {
    const parsed =
        typeof value === 'number'
            ? value
            : typeof value === 'string' && value.trim()
              ? Number(value)
              : Number.NaN;
    if (!Number.isFinite(parsed)) return COACH_THRESHOLD_DEFAULT_CP;
    return Math.min(
        COACH_THRESHOLD_MAX_CP,
        Math.max(COACH_THRESHOLD_MIN_CP, Math.round(parsed))
    );
}

/**
 * Search deeper before interrupting on a likely threshold crossing. The
 * 50-centipawn approach band catches near-boundary moves without paying the
 * confirmation cost on every ordinary move.
 */
export function shouldConfirmCoachAssessment(
    assessment: UserMoveAssessment,
    thresholdCp: number
): boolean {
    if (assessment.outcomeReason != null) return true;
    const lossCp = assessment.loss.cp;
    if (lossCp == null || !Number.isFinite(lossCp)) return false;
    const threshold = normalizeCoachThresholdCp(thresholdCp);
    if (threshold <= 30) return true;
    const approachBand = Math.min(
        100,
        Math.max(30, Math.round(threshold * 0.25))
    );
    return lossCp >= Math.max(0, threshold - approachBand);
}

export function firstEvaluation(
    analysis: MultiPvResult
): EngineEvaluation {
    const line = analysis.lines
        .slice()
        .sort((left, right) => left.multipv - right.multipv)[0];
    return {
        score: line?.score ?? null,
        wdl: line?.wdl,
    };
}

export function buildCoachVerification(args: {
    firstPassBefore: EngineEvaluation;
    firstPassAfter: EngineEvaluation;
    confirmedBefore?: EngineEvaluation;
    confirmedAfter?: EngineEvaluation;
    thresholdCp: number;
}): {
    assessment: UserMoveAssessment;
    evidence: CoachVerificationEvidence;
} {
    const thresholdCp = normalizeCoachThresholdCp(args.thresholdCp);
    const firstPass = assessUserMove({
        before: args.firstPassBefore,
        after: args.firstPassAfter,
        thresholdCp,
    });
    if (!args.confirmedBefore || !args.confirmedAfter) {
        return {
            assessment: firstPass,
            evidence: {
                firstPassNodes: COACH_FIRST_PASS_NODES,
                confirmationNodes: null,
                firstPassLossCp: firstPass.loss.cp,
                confirmedLossCp: null,
                confirmationRan: false,
                stable: true,
                interventionConfirmed: false,
            },
        };
    }

    const confirmed = assessUserMove({
        before: args.confirmedBefore,
        after: args.confirmedAfter,
        thresholdCp,
    });
    const threshold = thresholdCp;
    const firstBeforeCp =
        args.firstPassBefore.score?.type === 'cp'
            ? args.firstPassBefore.score.value
            : null;
    const confirmedBeforeCp =
        args.confirmedBefore.score?.type === 'cp'
            ? args.confirmedBefore.score.value
            : null;
    const firstAfterCp =
        args.firstPassAfter.score?.type === 'cp'
            ? args.firstPassAfter.score.value
            : null;
    const confirmedAfterCp =
        args.confirmedAfter.score?.type === 'cp'
            ? args.confirmedAfter.score.value
            : null;
    const mateEvidence =
        firstPass.outcomeReason != null ||
        confirmed.outcomeReason != null;
    const gapTolerance = Math.max(
        35,
        Math.min(100, Math.round(threshold * 0.25))
    );
    const stable = mateEvidence
        ? firstPass.outcomeReason === confirmed.outcomeReason
        : firstBeforeCp != null &&
          confirmedBeforeCp != null &&
          firstAfterCp != null &&
          confirmedAfterCp != null &&
          Math.abs(firstBeforeCp - confirmedBeforeCp) <= 75 &&
          Math.abs(firstAfterCp - confirmedAfterCp) <= 75 &&
          Math.abs(
              (firstPass.loss.cp ?? 0) -
                  (confirmed.loss.cp ?? 0)
          ) <= gapTolerance;
    const assessment = {
        ...confirmed,
        shouldIntervene: confirmed.shouldIntervene && stable,
    };
    return {
        assessment,
        evidence: {
            firstPassNodes: COACH_FIRST_PASS_NODES,
            confirmationNodes: COACH_CONFIRMATION_NODES,
            firstPassLossCp: firstPass.loss.cp,
            confirmedLossCp: confirmed.loss.cp,
            confirmationRan: true,
            stable,
            interventionConfirmed: assessment.shouldIntervene,
        },
    };
}
