import type { TimeClass } from '@/lib/types/game';
import type {
    TrainingMomentExtractionOptions,
} from '@/lib/analysis/extractTrainingMoments';
import {
    resolveTrainingConfig,
    type TrainingCoveragePreset,
    type TrainingGradingTolerance,
} from '@/lib/training/config';
import type { TrainingSourceKind } from '@/lib/training/contracts';

export type RatedFilter = 'any' | 'rated' | 'casual';
export const TRAINING_SESSION_MIXES = [
    'ALL',
    'MY_MISTAKES',
    'MISSED_OPPORTUNITIES',
] as const;
export type TrainingSessionMix = (typeof TRAINING_SESSION_MIXES)[number];

export type Filters = {
    lichessUsername: string;
    chesscomUsername: string;
    timeClass: TimeClass | 'any';
    rated: RatedFilter;
    since: string; // yyyy-mm-dd
    until: string; // yyyy-mm-dd
    minElo: string;
    maxElo: string;
    max: string;
};

export type PreferencesSchema = {
    filters: Filters;

    // server-side automation
    autoSyncEnabled: boolean;
    autoAnalyzeEnabled: boolean;
    autoSyncProviders: {
        lichess: boolean;
        chesscom: boolean;
    };
    autoAnalysis?: {
        enabled?: boolean;
        providers?: {
            lichess?: boolean;
            chesscom?: boolean;
        };
        resultScope?: 'losses' | 'draws' | 'all';
        timeControls?: {
            bullet?: boolean;
            blitz?: boolean;
            rapid?: boolean;
            classical?: boolean;
            unknown?: boolean;
        };
        ratedOnly?: boolean;
        minPlies?: number | string;
        dailyCap?: number | string | null;
        monthlyCap?: number | string | null;
    };

    // Deterministic extraction work budgets and metadata lookahead. Coverage
    // and grading policy live in the canonical training configuration.
    trainingCoveragePreset: TrainingCoveragePreset;
    trainingGradingTolerance: TrainingGradingTolerance;
    trainingSessionMix: TrainingSessionMix;
    analysisNodesPerPosition: string;
    confirmationNodes: string;
    themeLookaheadPlies: string;
};

export type PartialPreferences = Omit<
    Partial<PreferencesSchema>,
    'filters' | 'autoSyncProviders'
> & {
    filters?: Partial<Filters>;
    autoSyncProviders?: Partial<PreferencesSchema['autoSyncProviders']>;
    autoAnalysis?: Partial<NonNullable<PreferencesSchema['autoAnalysis']>>;
};

export type AnalysisDefaults = Pick<
    PreferencesSchema,
    | 'analysisNodesPerPosition'
    | 'confirmationNodes'
    | 'themeLookaheadPlies'
    | 'trainingCoveragePreset'
    | 'trainingGradingTolerance'
>;

export const ANALYSIS_NUMERIC_PREFERENCE_RULES = {
    analysisNodesPerPosition: {
        min: 1_000,
        max: 10_000_000,
        integer: true,
        allowBlank: false,
    },
    confirmationNodes: {
        min: 1_000,
        max: 20_000_000,
        integer: true,
        allowBlank: true,
    },
    themeLookaheadPlies: {
        min: 0,
        max: 32,
        integer: true,
        allowBlank: false,
    },
} as const;

export type AnalysisNumericPreferenceKey =
    keyof typeof ANALYSIS_NUMERIC_PREFERENCE_RULES;

export function validateAnalysisNumericPreference(
    key: AnalysisNumericPreferenceKey,
    value: string
): boolean {
    const rule = ANALYSIS_NUMERIC_PREFERENCE_RULES[key];
    const trimmed = value.trim();
    if (!trimmed) return rule.allowBlank;
    const number = Number(trimmed);
    return (
        Number.isFinite(number) &&
        (!rule.integer || Number.isInteger(number)) &&
        number >= rule.min &&
        number <= rule.max
    );
}

export function defaultPreferences(): PreferencesSchema {
    return {
        filters: {
            lichessUsername: '',
            chesscomUsername: '',
            timeClass: 'any',
            rated: 'any',
            since: '',
            until: '',
            minElo: '',
            maxElo: '',
            max: '100',
        },
        autoSyncEnabled: true,
        autoAnalyzeEnabled: false,
        autoSyncProviders: {
            lichess: true,
            chesscom: true,
        },
        autoAnalysis: {
            enabled: false,
            providers: {
                lichess: true,
                chesscom: true,
            },
            resultScope: 'draws',
            timeControls: {
                bullet: false,
                blitz: false,
                rapid: true,
                classical: true,
                unknown: false,
            },
            ratedOnly: true,
            minPlies: 20,
            dailyCap: 10,
            monthlyCap: 50,
        },
        trainingCoveragePreset: 'ALL_CONFIRMED',
        trainingGradingTolerance: 'PRACTICAL',
        trainingSessionMix: 'ALL',
        analysisNodesPerPosition: '100000',
        confirmationNodes: '200000',
        themeLookaheadPlies: '4',
    };
}

export function pickAnalysisDefaults(
    prefs: PreferencesSchema
): AnalysisDefaults {
    return {
        analysisNodesPerPosition: prefs.analysisNodesPerPosition,
        confirmationNodes: prefs.confirmationNodes,
        themeLookaheadPlies: prefs.themeLookaheadPlies,
        trainingCoveragePreset: prefs.trainingCoveragePreset,
        trainingGradingTolerance: prefs.trainingGradingTolerance,
    };
}

function parseBoundedNumberOrDefault(
    key: AnalysisNumericPreferenceKey,
    value: string,
    fallback: number
): number {
    if (!validateAnalysisNumericPreference(key, value)) return fallback;
    const number = Number(value.trim());
    return ANALYSIS_NUMERIC_PREFERENCE_RULES[key].integer
        ? Math.trunc(number)
        : number;
}

function parseOptionalBoundedNumber(
    key: AnalysisNumericPreferenceKey,
    value: string
): number | null {
    if (!value.trim()) return null;
    if (!validateAnalysisNumericPreference(key, value)) return null;
    const number = Number(value.trim());
    return ANALYSIS_NUMERIC_PREFERENCE_RULES[key].integer
        ? Math.trunc(number)
        : number;
}

export function analysisDefaultsToExtractOptions(
    a: AnalysisDefaults,
    opts?: { returnAnalysis?: boolean }
): TrainingMomentExtractionOptions {
    const trainingConfig = resolveTrainingConfig({
        coveragePreset: a.trainingCoveragePreset,
        gradingTolerance: a.trainingGradingTolerance,
    });
    return {
        nodesPerPosition: parseBoundedNumberOrDefault(
            'analysisNodesPerPosition',
            a.analysisNodesPerPosition,
            100_000
        ),
        themeLookaheadPlies: parseBoundedNumberOrDefault(
            'themeLookaheadPlies',
            a.themeLookaheadPlies,
            4
        ),
        confirmNodes: parseOptionalBoundedNumber(
            'confirmationNodes',
            a.confirmationNodes
        ),
        minWinningChanceLoss: trainingConfig.minWinChanceLoss,
        fallbackMinCpLoss: trainingConfig.fallbackMinCpLoss,
        maxAcceptedWinningChanceLoss:
            trainingConfig.gradingPolicy.success.maxWinChanceLoss,
        fallbackMaxAcceptedCpLoss:
            trainingConfig.gradingPolicy.success.maxCpLoss,
        gradingPolicy: trainingConfig.gradingPolicy,
        returnAnalysis: opts?.returnAnalysis ?? false,
    };
}

export function trainingSourceKindsForSessionMix(
    mix: TrainingSessionMix
): TrainingSourceKind[] {
    if (mix === 'MY_MISTAKES') return ['MY_MISTAKE'];
    if (mix === 'MISSED_OPPORTUNITIES') {
        return ['MISSED_OPPORTUNITY'];
    }
    return [];
}

export function mergePreferences(
    base: PreferencesSchema,
    patch: PartialPreferences
): PreferencesSchema {
    const merged: PreferencesSchema = {
        ...base,
        ...patch,
        filters: { ...base.filters, ...(patch.filters ?? {}) },
        autoSyncProviders: {
            ...base.autoSyncProviders,
            ...(patch.autoSyncProviders ?? {}),
        },
        autoAnalysis: {
            ...(base.autoAnalysis ?? {}),
            ...(patch.autoAnalysis ?? {}),
            providers: {
                ...(base.autoAnalysis?.providers ?? {}),
                ...(patch.autoAnalysis?.providers ?? {}),
            },
            timeControls: {
                ...(base.autoAnalysis?.timeControls ?? {}),
                ...(patch.autoAnalysis?.timeControls ?? {}),
            },
        },
    };

    return merged;
}
