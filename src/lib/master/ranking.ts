import { createHash } from 'node:crypto';
import type { TrainingMomentCandidate } from '@/lib/training/contracts';
import { stableCanonicalStringify } from '@/lib/training/contracts';

export type MasterCandidateRanking = {
    hardGatePassed: boolean;
    rejectionReasons: string[];
    freshnessScore: number;
    recognitionScore: number;
    clarityScore: number;
    engineConfidenceScore: number;
    humanInterestScore: number;
    solutionLengthScore: number;
    totalScore: number;
};

function clamp01(value: number) {
    return Math.max(0, Math.min(1, value));
}

function rounded(value: number) {
    return Math.round(value * 10_000) / 10_000;
}

export function rankMasterCandidate(args: {
    moment: TrainingMomentCandidate;
    playedAt: Date;
    personPriority: number;
    now?: Date;
}): MasterCandidateRanking {
    const now = args.now ?? new Date();
    const solution = args.moment.solution;
    const reasons: string[] = [];
    const acceptedCount = solution.acceptedMovesUci.length;
    const lineLength = solution.bestLineUci.length;
    const cpLoss = args.moment.originalDecision.cpLoss ?? 0;
    const winChanceLoss = args.moment.originalDecision.winChanceLoss ?? 0;

    if (!solution.trainable) reasons.push('NOT_TRAINABLE');
    if (solution.verificationStatus !== 'VERIFIED') {
        reasons.push('NOT_VERIFIED');
    }
    if (solution.solutionShape === 'OPEN') reasons.push('OPEN_SOLUTION');
    if (solution.acceptanceFrontier.status !== 'STABLE') {
        reasons.push('ACCEPTANCE_FRONTIER_NOT_STABLE');
    }
    if (acceptedCount < 1 || acceptedCount > 3) {
        reasons.push('ACCEPTED_MOVE_FRONTIER_UNCLEAR');
    }
    if (lineLength < 1 || lineLength > 10) {
        reasons.push('SOLUTION_LENGTH_UNSUITABLE');
    }
    if ((args.moment.confidence ?? 0) < 0.95) {
        reasons.push('LOW_ENGINE_CONFIDENCE');
    }
    if (
        solution.acceptedMovesUci.some(
            (move) =>
                move.toLowerCase() ===
                args.moment.originalMoveUci.toLowerCase()
        )
    ) {
        reasons.push('ORIGINAL_MOVE_IS_ACCEPTED');
    }
    // Avoid marketing a merely non-best move as a dramatic mistake. Either
    // evaluation family must independently clear a meaningful-loss threshold.
    if (winChanceLoss < 0.03 && cpLoss < 80) {
        reasons.push('MISTAKE_NOT_MEANINGFUL');
    }

    const ageDays = Math.max(
        0,
        (now.getTime() - args.playedAt.getTime()) / 86_400_000
    );
    const freshnessScore = clamp01(1 - ageDays / 21);
    const recognitionScore = clamp01(args.personPriority / 100);
    const clarityScore =
        solution.solutionShape === 'UNIQUE'
            ? 1
            : acceptedCount === 2
              ? 0.78
              : 0.58;
    const engineConfidenceScore = clamp01(args.moment.confidence ?? 0);
    const humanInterestScore = clamp01(
        Math.max(winChanceLoss / 0.25, cpLoss / 500)
    );
    const solutionLengthScore = clamp01(
        lineLength <= 2
            ? 0.7
            : lineLength <= 6
              ? 1
              : 1 - (lineLength - 6) * 0.15
    );
    const totalScore =
        freshnessScore * 22 +
        recognitionScore * 15 +
        clarityScore * 18 +
        engineConfidenceScore * 20 +
        humanInterestScore * 15 +
        solutionLengthScore * 10;

    return {
        hardGatePassed: reasons.length === 0,
        rejectionReasons: reasons,
        freshnessScore: rounded(freshnessScore),
        recognitionScore: rounded(recognitionScore),
        clarityScore: rounded(clarityScore),
        engineConfidenceScore: rounded(engineConfidenceScore),
        humanInterestScore: rounded(humanInterestScore),
        solutionLengthScore: rounded(solutionLengthScore),
        totalScore: rounded(totalScore),
    };
}

export function masterCandidateKey(args: {
    snapshotId: string;
    personId: string;
    decisionPly: number;
    configHash: string;
}) {
    return createHash('sha256')
        .update(
            stableCanonicalStringify({
                version: 1,
                snapshotId: args.snapshotId,
                personId: args.personId,
                decisionPly: args.decisionPly,
                configHash: args.configHash,
            })
        )
        .digest('hex');
}

export function masterContentHash(value: unknown) {
    return createHash('sha256')
        .update(stableCanonicalStringify(value))
        .digest('hex');
}
