import { createHash } from 'node:crypto';

import {
    TRAINING_MOMENT_KEY_VERSION,
    canonicalSolutionSemantics,
    nonNegativeSafeInteger,
    requiredCanonicalPart,
    stableCanonicalStringify,
    type SolutionRevisionInput,
    type TrainingMomentIdentity,
} from '@/lib/training/contracts';

export function hashCanonicalTrainingValue(value: unknown): string {
    return createHash('sha256')
        .update(stableCanonicalStringify(value))
        .digest('hex');
}

/** Stable identity for one user decision in one exact source-game revision. */
export function trainingMomentKey(identity: TrainingMomentIdentity): string {
    const canonical = stableCanonicalStringify({
        decisionPly: nonNegativeSafeInteger(
            identity.decisionPly,
            'decisionPly'
        ),
        gameId: requiredCanonicalPart(identity.gameId, 'gameId'),
        sourcePgnHash: requiredCanonicalPart(
            identity.sourcePgnHash,
            'sourcePgnHash'
        ),
        version: TRAINING_MOMENT_KEY_VERSION,
    });
    return createHash('sha256')
        .update(`backranq-training-moment\u0000${canonical}`)
        .digest('hex');
}

export function solutionSemanticsHash(
    input: Pick<
        SolutionRevisionInput,
        | 'verificationStatus'
        | 'decision'
        | 'answerCoverage'
        | 'continuation'
        | 'solutionShape'
        | 'gradingStrategy'
        | 'continuationShape'
        | 'trainable'
        | 'bestMoveUci'
        | 'acceptedMovesUci'
        | 'acceptanceFrontier'
        | 'moveAssessments'
        | 'bestLineUci'
        | 'solutionTree'
        | 'scoreAtStart'
        | 'playedMoveScore'
        | 'targetOutcome'
        | 'gradingPolicy'
    >
): string {
    return hashCanonicalTrainingValue(canonicalSolutionSemantics(input));
}
