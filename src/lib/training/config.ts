import { T2_SELECTION_POLICY_ID, type SelectionPolicyId } from '@/lib/analysis/t2Policy';
import { TRAINING_CONTRACT_VERSION } from './contracts';
import { DEFAULT_ASSESSMENT_POLICY, T2_ASSESSMENT_POLICY, type AssessmentPolicy } from './practiceContract';

export const TRAINING_COVERAGE_PRESETS = [
    'ALL_CONFIRMED',
    'BALANCED',
    'HIGH_CONFIDENCE',
] as const;
export type TrainingCoveragePreset =
    (typeof TRAINING_COVERAGE_PRESETS)[number];

export const TRAINING_GRADING_TOLERANCES = [
    'STRICT',
    'PRACTICAL',
    'LENIENT',
] as const;
export type TrainingGradingTolerance =
    (typeof TRAINING_GRADING_TOLERANCES)[number];

export type TrainingConfigInput = {
    selectionPolicyId?: SelectionPolicyId;
    coveragePreset?: TrainingCoveragePreset;
    minWinChanceLoss?: number;
    fallbackMinCpLoss?: number;
    gradingTolerance?: TrainingGradingTolerance;
    gradingPolicy?: AssessmentPolicy;
};

export type ResolvedTrainingConfig = {
    version: typeof TRAINING_CONTRACT_VERSION;
    coveragePreset: TrainingCoveragePreset;
    minWinChanceLoss: number;
    fallbackMinCpLoss: number;
    gradingTolerance: TrainingGradingTolerance;
    gradingPolicy: AssessmentPolicy;
};

const coverageDefaults: Record<
    TrainingCoveragePreset,
    Pick<ResolvedTrainingConfig, 'minWinChanceLoss' | 'fallbackMinCpLoss'>
> = {
    ALL_CONFIRMED: {
        minWinChanceLoss: 0.03,
        fallbackMinCpLoss: 30,
    },
    BALANCED: {
        minWinChanceLoss: 0.08,
        fallbackMinCpLoss: 100,
    },
    HIGH_CONFIDENCE: {
        minWinChanceLoss: 0.12,
        fallbackMinCpLoss: 150,
    },
};

function finiteOr(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fallback;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function clampCp(value: unknown, fallback: number): number {
    return Math.round(clamp(finiteOr(value, fallback), 0, 10_000));
}

function clampProbability(value: unknown, fallback: number): number {
    return clamp(finiteOr(value, fallback), 0, 1);
}

function validPreset(
    value: unknown
): value is TrainingCoveragePreset {
    return (
        typeof value === 'string' &&
        (TRAINING_COVERAGE_PRESETS as readonly string[]).includes(value)
    );
}

function validTolerance(
    value: unknown
): value is TrainingGradingTolerance {
    return (
        typeof value === 'string' &&
        (TRAINING_GRADING_TOLERANCES as readonly string[]).includes(value)
    );
}

export function normalizeGradingPolicy(
    input: AssessmentPolicy | undefined,
    tolerance: TrainingGradingTolerance = 'PRACTICAL',
    selectionPolicyId: SelectionPolicyId = T2_SELECTION_POLICY_ID
): AssessmentPolicy {
    if (input) {
        const keys = Object.keys(DEFAULT_ASSESSMENT_POLICY);
        if (input.version !== 4 || !input.id.trim() || Object.keys(input).length !== keys.length
            || keys.some(key => !(key in input))
            || Object.entries(input).some(([key,value]) => key !== 'id' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0))
            || input.minToleranceCp > input.maxToleranceCp || input.bestMaxLossCp > input.strongMaxLossCp
            || input.strongMaxLossCp > input.minToleranceCp || input.maxExpectedScoreLoss > 1
            || input.bestMaxLossExpectedScore > input.strongMaxLossExpectedScore
            || input.strongMaxLossExpectedScore > input.maxExpectedScoreLoss) throw new Error('Invalid v4 assessment policy');
        return structuredClone(input);
    }
    const policy = structuredClone(selectionPolicyId === T2_SELECTION_POLICY_ID ? T2_ASSESSMENT_POLICY : DEFAULT_ASSESSMENT_POLICY);
    if (tolerance === 'STRICT') return { ...policy, id: `${policy.id}:strict`,
        minToleranceCp: 75, maxToleranceCp: 225, winningToleranceFraction: 0.45,
        maxExpectedScoreLoss: 0.075, bestMaxLossCp: 10, bestMaxLossExpectedScore: 0.01,
        strongMaxLossCp: 30, strongMaxLossExpectedScore: 0.03 };
    if (tolerance === 'LENIENT') return { ...policy, id: `${policy.id}:lenient`,
        minToleranceCp: 130, maxToleranceCp: 390, winningToleranceFraction: 0.78,
        maxExpectedScoreLoss: 0.13, bestMaxLossCp: 30, bestMaxLossExpectedScore: 0.03,
        strongMaxLossCp: 70, strongMaxLossExpectedScore: 0.07 };
    return policy;
}

export function resolveTrainingConfig(
    input: TrainingConfigInput = {}
): ResolvedTrainingConfig {
    const coveragePreset = validPreset(input.coveragePreset)
        ? input.coveragePreset
        : 'ALL_CONFIRMED';
    const gradingTolerance = validTolerance(input.gradingTolerance)
        ? input.gradingTolerance
        : 'PRACTICAL';
    const defaults = coverageDefaults[coveragePreset];

    return {
        version: TRAINING_CONTRACT_VERSION,
        coveragePreset,
        minWinChanceLoss: clampProbability(
            input.minWinChanceLoss,
            defaults.minWinChanceLoss
        ),
        fallbackMinCpLoss: clampCp(
            input.fallbackMinCpLoss,
            defaults.fallbackMinCpLoss
        ),
        gradingTolerance,
        gradingPolicy: normalizeGradingPolicy(
            input.gradingPolicy,
            gradingTolerance,
            input.selectionPolicyId
        ),
    };
}
