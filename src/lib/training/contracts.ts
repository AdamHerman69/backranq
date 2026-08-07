import { createHash } from 'node:crypto';
import type { GameSource } from '@/lib/types/game';
import {
    canonicalMoveAssessmentEvidence,
    canonicalSolutionTreeSemantics,
} from '@/lib/training/solutionSemantics';

export const TRAINING_CONTRACT_VERSION = 3 as const;
export const TRAINING_MOMENT_KEY_VERSION = 1 as const;

export const TRAINING_SOURCE_KINDS = [
    'MY_MISTAKE',
    'MISSED_OPPORTUNITY',
] as const;
export type TrainingSourceKind = (typeof TRAINING_SOURCE_KINDS)[number];

export const TRAINING_LESSON_KINDS = [
    'AVOID_MISTAKE',
    'PUNISH_MISTAKE',
    'SAVE_DRAW',
    'PRESERVE_WIN',
    'CONVERT_ADVANTAGE',
    'IMPROVE_POSITION',
] as const;
export type TrainingLessonKind = (typeof TRAINING_LESSON_KINDS)[number];

export const VERIFICATION_STATUSES = [
    'VERIFIED',
    'AMBIGUOUS',
    'UNSTABLE',
    'INVALID',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const SOLUTION_SHAPES = ['UNIQUE', 'MULTIPLE', 'OPEN'] as const;
export type SolutionShape = (typeof SOLUTION_SHAPES)[number];

export const GRADING_STRATEGIES = [
    'PRECOMPUTED',
    'OUTCOME_TOLERANCE',
    'DYNAMIC',
    'TABLEBASE',
] as const;
export type GradingStrategy = (typeof GRADING_STRATEGIES)[number];

export const CONTINUATION_SHAPES = [
    'SINGLE_DECISION',
    'CONDITIONAL_LINE',
] as const;
export type ContinuationShape = (typeof CONTINUATION_SHAPES)[number];

export const ATTEMPT_GRADES = [
    'BEST',
    'STRONG',
    'GOOD',
    'IMPROVED',
    'REPEATED_MISTAKE',
    'DIFFERENT_MISTAKE',
] as const;
export type AttemptGrade = (typeof ATTEMPT_GRADES)[number];

/**
 * A score whose point of view is explicit. Mate and tablebase outcomes are
 * deliberately not collapsed into synthetic centipawn values.
 */
export type PovScore =
    | { kind: 'cp'; cp: number; pov: 'WHITE' }
    | {
          kind: 'mate';
          plies: number;
          winner: 'WHITE' | 'BLACK';
      }
    | {
          kind: 'tablebase';
          wdl: 'WIN' | 'DRAW' | 'LOSS';
          pov: 'WHITE';
          dtz?: number;
      };

export type TrainingMomentIdentity = {
    gameId: string;
    sourcePgnHash: string;
    decisionPly: number;
};

export type TrainingMomentMetadata = {
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
};

export type GradingPolicyV3 = {
    version: 3;
    pov: 'TRAINING_SIDE';
    best: {
        maxCpLoss: number;
        maxWinChanceLoss: number;
    };
    strong: {
        maxCpLoss: number;
        maxWinChanceLoss: number;
    };
    success: {
        maxCpLoss: number;
        maxWinChanceLoss: number;
        preserveOutcome: boolean;
    };
    improvement: {
        minRecoveredCp: number;
        minRecoveredWinChance: number;
    };
    unknownMove: 'REJECT_OUTSIDE_ACCEPTED_SET';
    matePolicy: 'EXACT';
    tablebasePolicy: 'EXACT';
};

export const ACCEPTANCE_FRONTIER_STATUSES = [
    'STABLE',
    'OPEN',
    'UNSTABLE',
] as const;
export type AcceptanceFrontierStatus =
    (typeof ACCEPTANCE_FRONTIER_STATUSES)[number];

export type AcceptedMoveTier = 'BEST' | 'STRONG' | 'GOOD';

/**
 * Authoritative root grading boundary. Every move in `moves` is accepted;
 * every other legal move is rejected only when `status` is STABLE.
 */
export type AcceptanceFrontier = {
    version: 1;
    status: AcceptanceFrontierStatus;
    targetCutoffCp: number;
    effectiveCutoffCp: number | null;
    boundaryGapCp: number | null;
    moves: Array<{
        moveUci: string;
        tier: AcceptedMoveTier;
    }>;
    firstRejectedMoveUci: string | null;
};

export type SolutionMoveAssessmentInput = {
    positionKey: string;
    decisionIndex: number;
    fen: string;
    moveUci: string;
    source: 'PRECOMPUTED' | 'TABLEBASE';
    grade: AcceptedMoveTier;
    scoreAfter: PovScore | null;
    evidence: unknown;
};

export type SolutionRevisionInput = {
    solutionHash: string;
    verificationStatus: VerificationStatus;
    solutionShape: SolutionShape;
    gradingStrategy: GradingStrategy;
    continuationShape: ContinuationShape;
    trainable: boolean;
    bestMoveUci: string;
    acceptedMovesUci: string[];
    acceptanceFrontier: AcceptanceFrontier;
    moveAssessments: SolutionMoveAssessmentInput[];
    bestLineUci: string[];
    solutionTree: unknown;
    scoreAtStart: PovScore | null;
    playedMoveScore: PovScore | null;
    targetOutcome: unknown;
    gradingPolicy: GradingPolicyV3;
    evidence: unknown;
    generatorVersion: string;
    configHash: string;
};

export type TrainingMomentCandidate = {
    sourceGameId: string;
    sourceProvider: GameSource;
    sourcePlayedAt: string;
    sourcePgnHash: string;
    decisionPly: number;
    fen: string;
    positionHistory: string[];
    sideToMove: 'w' | 'b';
    originalMoveUci: string;
    sourceKinds: TrainingSourceKind[];
    lessonKinds: TrainingLessonKind[];
    themes: string[];
    originalDecision: {
        scoreBefore: PovScore;
        scoreAfter: PovScore;
        cpLoss?: number;
        winChanceLoss?: number;
    };
    confidence?: number;
    phase?: 'OPENING' | 'MIDDLEGAME' | 'ENDGAME';
    solution: SolutionRevisionInput;
};

function requiredCanonicalPart(value: string, field: string): string {
    const normalized = value.trim().toLowerCase();
    if (!normalized) throw new Error(`${field} is required`);
    return normalized;
}

function nonNegativeSafeInteger(value: number, field: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
    }
    return value;
}

/**
 * Stable identity for one user decision in one exact source-game revision.
 * Avoid/punish are intentionally absent: they are mergeable metadata on the
 * same decision rather than competing identities.
 */
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

const sourceKindOrder = new Map(
    TRAINING_SOURCE_KINDS.map((value, index) => [value, index])
);
const lessonKindOrder = new Map(
    TRAINING_LESSON_KINDS.map((value, index) => [value, index])
);

function canonicalEnumValues<T extends string>(
    values: readonly T[],
    order: ReadonlyMap<T, number>
): T[] {
    return Array.from(new Set(values)).sort(
        (left, right) =>
            (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right) ?? Number.MAX_SAFE_INTEGER)
    );
}

function canonicalThemes(values: readonly string[]): string[] {
    return Array.from(
        new Set(
            values
                .map(normalizeThemeId)
                .filter(Boolean)
                .map((value) => value.slice(0, 64))
        )
    )
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 64);
}

export function normalizeThemeId(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Merge extraction reasons for the same decision without making either
 * source kind part of the moment identity.
 */
export function mergeTrainingMomentMetadata(
    ...metadata: Array<
        Partial<
            Pick<
                TrainingMomentMetadata,
                'sourceKinds' | 'lessonKinds' | 'themes'
            >
        >
    >
): TrainingMomentMetadata {
    const sourceKinds = canonicalEnumValues(
        metadata.flatMap((item) => item.sourceKinds ?? []),
        sourceKindOrder
    );
    const lessonKinds = canonicalEnumValues(
        metadata.flatMap((item) => item.lessonKinds ?? []),
        lessonKindOrder
    );
    const themes = canonicalThemes(
        metadata.flatMap((item) => item.themes ?? [])
    );

    return {
        sourceKinds,
        lessonKinds,
        themes,
    };
}

function canonicalize(value: unknown): unknown {
    if (value == null) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalize);
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value !== 'object') return value;

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const item = (value as Record<string, unknown>)[key];
        if (item !== undefined) output[key] = canonicalize(item);
    }
    return output;
}

export function stableCanonicalStringify(value: unknown): string {
    return JSON.stringify(canonicalize(value));
}

export function hashCanonicalTrainingValue(value: unknown): string {
    return createHash('sha256')
        .update(stableCanonicalStringify(value))
        .digest('hex');
}

/**
 * Hash only grading-relevant solution semantics. Engine provenance and
 * verification evidence may produce a new immutable revision without making
 * an otherwise equivalent solution appear different.
 */
export function solutionSemanticsHash(
    input: Pick<
        SolutionRevisionInput,
        | 'verificationStatus'
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
    const normalizeUci = (move: string) => move.trim().toLowerCase();
    return hashCanonicalTrainingValue({
        version: 1,
        verificationStatus: input.verificationStatus,
        solutionShape: input.solutionShape,
        gradingStrategy: input.gradingStrategy,
        continuationShape: input.continuationShape,
        trainable: input.trainable,
        bestMoveUci: normalizeUci(input.bestMoveUci),
        acceptedMovesUci: Array.from(
            new Set(
                [input.bestMoveUci, ...input.acceptedMovesUci]
                    .map(normalizeUci)
                    .filter(Boolean)
            )
        ).sort(),
        acceptanceFrontier: input.acceptanceFrontier,
        moveAssessments: input.moveAssessments
            .map((assessment) => ({
                positionKey: assessment.positionKey,
                decisionIndex: assessment.decisionIndex,
                fen: assessment.fen,
                moveUci: normalizeUci(assessment.moveUci),
                source: assessment.source,
                grade: assessment.grade,
                scoreAfter: assessment.scoreAfter,
                evidence: canonicalMoveAssessmentEvidence(
                    assessment.evidence
                ),
            }))
            .sort((left, right) =>
                `${left.decisionIndex}\u0000${left.positionKey}\u0000${left.moveUci}`.localeCompare(
                    `${right.decisionIndex}\u0000${right.positionKey}\u0000${right.moveUci}`
                )
            ),
        bestLineUci: input.bestLineUci.map(normalizeUci),
        solutionTree: canonicalSolutionTreeSemantics(input.solutionTree),
        scoreAtStart: input.scoreAtStart,
        playedMoveScore: input.playedMoveScore,
        targetOutcome: input.targetOutcome,
        gradingPolicy: input.gradingPolicy,
    });
}
