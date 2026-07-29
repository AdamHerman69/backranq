import {
    TRAINING_CONTRACT_VERSION,
    hashCanonicalTrainingValue,
    type GradingPolicyV2,
} from './contracts';

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
    coveragePreset?: TrainingCoveragePreset;
    minWinChanceLoss?: number;
    fallbackMinCpLoss?: number;
    gradingTolerance?: TrainingGradingTolerance;
    gradingPolicy?: Partial<{
        best: Partial<GradingPolicyV2['best']>;
        success: Partial<GradingPolicyV2['success']>;
        improvement: Partial<GradingPolicyV2['improvement']>;
    }>;
};

export type ResolvedTrainingConfig = {
    version: typeof TRAINING_CONTRACT_VERSION;
    coveragePreset: TrainingCoveragePreset;
    minWinChanceLoss: number;
    fallbackMinCpLoss: number;
    gradingTolerance: TrainingGradingTolerance;
    gradingPolicy: GradingPolicyV2;
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

const gradingDefaults: Record<
    TrainingGradingTolerance,
    Pick<GradingPolicyV2, 'best' | 'success' | 'improvement'>
> = {
    STRICT: {
        best: { maxCpLoss: 5, maxWinChanceLoss: 0.01 },
        success: {
            maxCpLoss: 25,
            maxWinChanceLoss: 0.025,
            preserveOutcome: true,
        },
        improvement: {
            minRecoveredCp: 50,
            minRecoveredWinChance: 0.05,
        },
    },
    PRACTICAL: {
        best: { maxCpLoss: 15, maxWinChanceLoss: 0.02 },
        success: {
            maxCpLoss: 50,
            maxWinChanceLoss: 0.05,
            preserveOutcome: true,
        },
        improvement: {
            minRecoveredCp: 50,
            minRecoveredWinChance: 0.05,
        },
    },
    LENIENT: {
        best: { maxCpLoss: 25, maxWinChanceLoss: 0.03 },
        success: {
            maxCpLoss: 80,
            maxWinChanceLoss: 0.08,
            preserveOutcome: true,
        },
        improvement: {
            minRecoveredCp: 30,
            minRecoveredWinChance: 0.03,
        },
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
    input: TrainingConfigInput['gradingPolicy'],
    tolerance: TrainingGradingTolerance = 'PRACTICAL'
): GradingPolicyV2 {
    const safeTolerance = validTolerance(tolerance)
        ? tolerance
        : 'PRACTICAL';
    const defaults = gradingDefaults[safeTolerance];
    const best = {
        maxCpLoss: clampCp(
            input?.best?.maxCpLoss,
            defaults.best.maxCpLoss
        ),
        maxWinChanceLoss: clampProbability(
            input?.best?.maxWinChanceLoss,
            defaults.best.maxWinChanceLoss
        ),
    };
    const success = {
        maxCpLoss: Math.max(
            best.maxCpLoss,
            clampCp(
                input?.success?.maxCpLoss,
                defaults.success.maxCpLoss
            )
        ),
        maxWinChanceLoss: Math.max(
            best.maxWinChanceLoss,
            clampProbability(
                input?.success?.maxWinChanceLoss,
                defaults.success.maxWinChanceLoss
            )
        ),
        preserveOutcome:
            typeof input?.success?.preserveOutcome === 'boolean'
                ? input.success.preserveOutcome
                : defaults.success.preserveOutcome,
    };

    return {
        version: TRAINING_CONTRACT_VERSION,
        pov: 'TRAINING_SIDE',
        best,
        success,
        improvement: {
            minRecoveredCp: clampCp(
                input?.improvement?.minRecoveredCp,
                defaults.improvement.minRecoveredCp
            ),
            minRecoveredWinChance: clampProbability(
                input?.improvement?.minRecoveredWinChance,
                defaults.improvement.minRecoveredWinChance
            ),
        },
        unknownMove: 'DYNAMIC',
        matePolicy: 'EXACT',
        tablebasePolicy: 'EXACT',
    };
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
            gradingTolerance
        ),
    };
}

export function trainingConfigHash(
    config: TrainingConfigInput | ResolvedTrainingConfig
): string {
    return hashCanonicalTrainingValue(resolveTrainingConfig(config));
}
