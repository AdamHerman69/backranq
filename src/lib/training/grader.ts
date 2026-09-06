import type {
    AttemptGrade,
    GradingPolicyV3,
} from '@/lib/training/contracts';

export type TrainingMoveMetrics = {
    moveUci: string;
    originalMoveUci: string;
    stable: boolean;
    bestGapCp?: number | null;
    bestGapWinChance?: number | null;
    recoveredCp?: number | null;
    recoveredWinChance?: number | null;
    preservesOutcome?: boolean | null;
    evidenceModel?: 'MATCHED_WDL' | 'CP_ONLY' | 'EXACT_OUTCOME';
    referenceOutdated?: boolean;
};

export type TrainingMoveGradeResult =
    | {
          status: 'GRADED';
          grade: AttemptGrade;
          accepted: boolean;
      }
    | {
          status: 'UNRESOLVED';
          reason: 'UNSTABLE_EVIDENCE' | 'MISSING_OUTCOME_EVIDENCE';
      };

function normalizeMove(move: string): string {
    return move.trim().toLowerCase();
}

function finiteNonNegative(value: number | null | undefined): number | null {
    return typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0
        ? value
        : null;
}

/**
 * Cp and matched expected-score tolerances are both necessary when present.
 * Exact outcomes use their own comparison, without synthetic centipawns.
 */
function withinLoss(
    metrics: TrainingMoveMetrics,
    threshold: { maxCpLoss: number; maxWinChanceLoss: number }
): boolean {
    const chanceLoss = finiteNonNegative(metrics.bestGapWinChance);
    const cpLoss = finiteNonNegative(metrics.bestGapCp);
    if (metrics.evidenceModel === 'EXACT_OUTCOME') {
        return chanceLoss != null && chanceLoss <= threshold.maxWinChanceLoss;
    }
    return cpLoss != null && cpLoss <= threshold.maxCpLoss &&
        (chanceLoss == null || chanceLoss <= threshold.maxWinChanceLoss);
}

function isMeaningfulImprovement(
    metrics: TrainingMoveMetrics,
    policy: GradingPolicyV3
): boolean {
    const recoveredChance = finiteNonNegative(metrics.recoveredWinChance);
    const recoveredCp = finiteNonNegative(metrics.recoveredCp);
    return (recoveredChance != null && recoveredChance >= policy.improvement.minRecoveredWinChance) ||
        (metrics.evidenceModel !== 'EXACT_OUTCOME' && recoveredCp != null && recoveredCp >= policy.improvement.minRecoveredCp);

}

function hasOutcomeEvidence(metrics: TrainingMoveMetrics): boolean {
    return (
        finiteNonNegative(metrics.bestGapWinChance) != null ||
        finiteNonNegative(metrics.bestGapCp) != null
    );
}

function hasRequiredPreservationEvidence(
    metrics: TrainingMoveMetrics,
    policy: GradingPolicyV3
): boolean {
    return (
        metrics.evidenceModel !== 'EXACT_OUTCOME' ||
        !policy.success.preserveOutcome ||
        typeof metrics.preservesOutcome === 'boolean'
    );
}

/**
 * Shared grading policy for one user decision. Practice runs this in the
 * browser; extraction and verification can use the same deterministic rules.
 *
 * The result compares the move with both the best known outcome and the
 * original game mistake. It never treats missing or unstable evidence as an
 * automatic wrong answer.
 */
export function gradeTrainingMove(
    metrics: TrainingMoveMetrics,
    policy: GradingPolicyV3
): TrainingMoveGradeResult {
    if (!metrics.stable || metrics.referenceOutdated) {
        return { status: 'UNRESOLVED', reason: 'UNSTABLE_EVIDENCE' };
    }
    if (
        !hasOutcomeEvidence(metrics) ||
        !hasRequiredPreservationEvidence(metrics, policy)
    ) {
        return { status: 'UNRESOLVED', reason: 'MISSING_OUTCOME_EVIDENCE' };
    }

    if (metrics.evidenceModel === 'MATCHED_WDL' && finiteNonNegative(metrics.bestGapCp) == null &&
        finiteNonNegative(metrics.bestGapWinChance) != null && metrics.bestGapWinChance! <= policy.success.maxWinChanceLoss) {
        // A mixed cp/exact comparison can prove a large WDL loss, but cannot
        // certify quality without the required centipawn comparison.
        return { status: 'UNRESOLVED', reason: 'MISSING_OUTCOME_EVIDENCE' };
    }

    const preservesRequiredOutcome =
        metrics.evidenceModel !== 'EXACT_OUTCOME' ||
        !policy.success.preserveOutcome || metrics.preservesOutcome === true;
    if (
        preservesRequiredOutcome &&
        withinLoss(metrics, policy.best)
    ) {
        return { status: 'GRADED', grade: 'BEST', accepted: true };
    }
    if (
        preservesRequiredOutcome &&
        withinLoss(metrics, policy.strong)
    ) {
        return { status: 'GRADED', grade: 'STRONG', accepted: true };
    }
    if (
        preservesRequiredOutcome &&
        withinLoss(metrics, policy.success)
    ) {
        return { status: 'GRADED', grade: 'GOOD', accepted: true };
    }
    const repeated =
        normalizeMove(metrics.moveUci) ===
        normalizeMove(metrics.originalMoveUci);
    if (repeated) {
        return {
            status: 'GRADED',
            grade: 'REPEATED_MISTAKE',
            accepted: false,
        };
    }

    if (isMeaningfulImprovement(metrics, policy)) {
        return { status: 'GRADED', grade: 'IMPROVED', accepted: false };
    }
    return {
        status: 'GRADED',
        grade: 'DIFFERENT_MISTAKE',
        accepted: false,
    };
}
