import {
    evaluationLoss,
    negateScore,
    reverseWdl,
    scoreToOrderingCp,
    type EvaluationLoss,
} from '@/lib/analysis/evaluation';
import type { EngineWdl, Score } from '@/lib/analysis/stockfishClient';

export type EngineEvaluation = {
    score: Score | null;
    wdl?: EngineWdl;
};

export type CoachInterventionSeverity =
    | 'inaccuracy'
    | 'mistake'
    | 'blunder';

export type UserMoveAssessment = {
    loss: EvaluationLoss;
    shouldIntervene: boolean;
    severity: CoachInterventionSeverity;
    playerEvaluationAfter: EngineEvaluation;
    outcomeReason:
        | 'allowed-forced-mate'
        | 'lost-forced-mate'
        | null;
};

function severityForLoss(
    loss: EvaluationLoss
): CoachInterventionSeverity {
    if (loss.cp != null && loss.cp >= 200) return 'blunder';
    if (loss.cp != null && loss.cp >= 100) return 'mistake';
    return 'inaccuracy';
}

/**
 * Both engine results use UCI's side-to-move POV. After a user move the
 * opponent is to move, so that evidence must be reversed before comparison.
 */
export function assessUserMove(args: {
    before: EngineEvaluation;
    after: EngineEvaluation;
    thresholdCp: number;
}): UserMoveAssessment {
    const playerEvaluationAfter = {
        score: negateScore(args.after.score),
        wdl: reverseWdl(args.after.wdl),
    };
    const genericLoss = evaluationLoss(
        args.before,
        playerEvaluationAfter
    );
    const beforeCp =
        args.before.score?.type === 'cp'
            ? scoreToOrderingCp(args.before.score)
            : null;
    const afterCp =
        playerEvaluationAfter.score?.type === 'cp'
            ? scoreToOrderingCp(playerEvaluationAfter.score)
            : null;
    const loss: EvaluationLoss = {
        ...genericLoss,
        cp:
            beforeCp == null || afterCp == null
                ? null
                : Math.max(0, beforeCp - afterCp),
    };
    const outcomeReason =
        playerEvaluationAfter.score?.type === 'mate' &&
        playerEvaluationAfter.score.value < 0 &&
        !(
            args.before.score?.type === 'mate' &&
            args.before.score.value < 0
        )
            ? 'allowed-forced-mate'
            : args.before.score?.type === 'mate' &&
                args.before.score.value > 0 &&
                !(
                    playerEvaluationAfter.score?.type === 'mate' &&
                    playerEvaluationAfter.score.value > 0
                )
              ? 'lost-forced-mate'
              : null;
    const thresholdCp = Math.max(1, Math.trunc(args.thresholdCp));
    return {
        loss,
        shouldIntervene:
            outcomeReason != null ||
            (loss.cp != null &&
                Number.isFinite(loss.cp) &&
                loss.cp >= thresholdCp),
        severity:
            outcomeReason != null ? 'blunder' : severityForLoss(loss),
        playerEvaluationAfter,
        outcomeReason,
    };
}

export function coachInterventionLabel(
    severity: CoachInterventionSeverity
): string {
    if (severity === 'blunder') return 'Big mistake';
    if (severity === 'mistake') return 'Mistake';
    return 'Inaccuracy';
}
