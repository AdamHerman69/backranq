import type {
    AttemptGrade,
    GradingPolicyV2,
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
 * Winning-chance evidence is authoritative when present. Centipawns are the
 * fallback for engines/positions without usable WDL evidence.
 */
function withinLoss(
    metrics: TrainingMoveMetrics,
    threshold: { maxCpLoss: number; maxWinChanceLoss: number }
): boolean {
    const chanceLoss = finiteNonNegative(metrics.bestGapWinChance);
    if (chanceLoss != null) return chanceLoss <= threshold.maxWinChanceLoss;
    const cpLoss = finiteNonNegative(metrics.bestGapCp);
    return cpLoss != null && cpLoss <= threshold.maxCpLoss;
}

function isMeaningfulImprovement(
    metrics: TrainingMoveMetrics,
    policy: GradingPolicyV2
): boolean {
    const recoveredChance = finiteNonNegative(metrics.recoveredWinChance);
    if (recoveredChance != null) {
        return (
            recoveredChance >= policy.improvement.minRecoveredWinChance
        );
    }
    const recoveredCp = finiteNonNegative(metrics.recoveredCp);
    return (
        recoveredCp != null &&
        recoveredCp >= policy.improvement.minRecoveredCp
    );
}

function hasOutcomeEvidence(metrics: TrainingMoveMetrics): boolean {
    return (
        finiteNonNegative(metrics.bestGapWinChance) != null ||
        finiteNonNegative(metrics.bestGapCp) != null
    );
}

function hasRequiredPreservationEvidence(
    metrics: TrainingMoveMetrics,
    policy: GradingPolicyV2
): boolean {
    return (
        !policy.success.preserveOutcome ||
        typeof metrics.preservesOutcome === 'boolean'
    );
}

/**
 * Server-authoritative grading for one user decision.
 *
 * The result compares the move with both the best known outcome and the
 * original game mistake. It never treats missing or unstable evidence as an
 * automatic wrong answer.
 */
export function gradeTrainingMove(
    metrics: TrainingMoveMetrics,
    policy: GradingPolicyV2
): TrainingMoveGradeResult {
    if (!metrics.stable) {
        return { status: 'UNRESOLVED', reason: 'UNSTABLE_EVIDENCE' };
    }
    if (
        !hasOutcomeEvidence(metrics) ||
        !hasRequiredPreservationEvidence(metrics, policy)
    ) {
        return { status: 'UNRESOLVED', reason: 'MISSING_OUTCOME_EVIDENCE' };
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

    const preservesRequiredOutcome =
        !policy.success.preserveOutcome || metrics.preservesOutcome === true;
    if (
        preservesRequiredOutcome &&
        withinLoss(metrics, policy.best)
    ) {
        return { status: 'GRADED', grade: 'BEST', accepted: true };
    }
    if (
        preservesRequiredOutcome &&
        withinLoss(metrics, policy.success)
    ) {
        return { status: 'GRADED', grade: 'GOOD', accepted: true };
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
