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
export const AUTO_ANALYSIS_RESULT_SCOPES = ['losses', 'draws', 'all'] as const;
export const AUTO_ANALYSIS_BACKLOG_MODES = ['all', 'new'] as const;
export const AUTO_ANALYSIS_PROVIDER_KEYS = ['lichess', 'chesscom'] as const;
export const AUTO_ANALYSIS_TIME_CONTROL_KEYS = [
    'bullet',
    'blitz',
    'rapid',
    'classical',
    'unknown',
] as const;
export type AutoAnalysisResultScope =
    (typeof AUTO_ANALYSIS_RESULT_SCOPES)[number];
export type AutoAnalysisBacklogMode =
    (typeof AUTO_ANALYSIS_BACKLOG_MODES)[number];
export type AutoAnalysisProviderKey =
    (typeof AUTO_ANALYSIS_PROVIDER_KEYS)[number];
export type AutoAnalysisTimeControlKey =
    (typeof AUTO_ANALYSIS_TIME_CONTROL_KEYS)[number];

export type AutoAnalysisPolicy = {
    enabled: boolean;
    providers: Record<AutoAnalysisProviderKey, boolean>;
    timeControls: Record<AutoAnalysisTimeControlKey, boolean>;
    ratedOnly: boolean;
    resultScope: AutoAnalysisResultScope;
    minPlies: number;
    dailyCap: number | null;
    monthlyCap: number | null;
    reserveCredits: number;
    backlogMode: AutoAnalysisBacklogMode;
    /**
     * Controlled by the preferences route. For `backlogMode: "new"`, only
     * games imported at or after this instant are eligible.
     */
    enabledAt: string | null;
};
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
    autoSyncProviders: {
        lichess: boolean;
        chesscom: boolean;
    };
    autoAnalysis: AutoAnalysisPolicy;

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
    'filters' | 'autoSyncProviders' | 'autoAnalysis'
> & {
    filters?: Partial<Filters>;
    autoSyncProviders?: Partial<PreferencesSchema['autoSyncProviders']>;
    autoAnalysis?: Omit<
        Partial<AutoAnalysisPolicy>,
        'providers' | 'timeControls'
    > & {
        providers?: Partial<AutoAnalysisPolicy['providers']>;
        timeControls?: Partial<AutoAnalysisPolicy['timeControls']>;
    };
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
            reserveCredits: 10,
            backlogMode: 'new',
            enabledAt: null,
        },
        trainingCoveragePreset: 'ALL_CONFIRMED',
        trainingGradingTolerance: 'PRACTICAL',
        trainingSessionMix: 'ALL',
        analysisNodesPerPosition: '100000',
        confirmationNodes: '200000',
        themeLookaheadPlies: '4',
    };
}

/**
 * Single defensive reader for persisted preference JSON. Write-time validation
 * remains strict and only the current nested policy is recognized.
 */
export function canonicalPreferences(rawPreferences: unknown): PreferencesSchema {
    const raw = preferenceRecord(rawPreferences);
    const currentTopLevelKeys = new Set([
        'filters',
        'autoSyncEnabled',
        'autoSyncProviders',
        'trainingCoveragePreset',
        'trainingGradingTolerance',
        'trainingSessionMix',
        'analysisNodesPerPosition',
        'confirmationNodes',
        'themeLookaheadPlies',
    ]);
    const withoutAutomation = Object.fromEntries(
        Object.entries(raw).filter(([key]) => currentTopLevelKeys.has(key))
    );
    const base = mergePreferences(
        defaultPreferences(),
        withoutAutomation as PartialPreferences
    );
    const nested = optionalPreferenceRecord(raw.autoAnalysis) ?? {};
    const defaults = defaultPreferences().autoAnalysis;
    const enabled =
        typeof nested.enabled === 'boolean'
            ? nested.enabled
            : defaults.enabled;
    const providerSource = optionalPreferenceRecord(nested.providers) ?? {};
    const timeControlSource = nested.timeControls;

    const autoAnalysis: AutoAnalysisPolicy = {
        enabled,
        providers: canonicalBooleanRecord(
            defaults.providers,
            providerSource
        ),
        timeControls: canonicalSelectionRecord(
            defaults.timeControls,
            timeControlSource,
            AUTO_ANALYSIS_TIME_CONTROL_KEYS
        ),
        ratedOnly: canonicalBoolean(
            nested.ratedOnly,
            defaults.ratedOnly
        ),
        resultScope: AUTO_ANALYSIS_RESULT_SCOPES.includes(
            nested.resultScope as AutoAnalysisResultScope
        )
            ? (nested.resultScope as AutoAnalysisResultScope)
            : defaults.resultScope,
        minPlies: canonicalInteger(
            nested.minPlies,
            defaults.minPlies,
            0,
            1_000
        ),
        dailyCap: canonicalNullablePositiveInteger(
            nested.dailyCap,
            defaults.dailyCap,
            10_000
        ),
        monthlyCap: canonicalNullablePositiveInteger(
            nested.monthlyCap,
            defaults.monthlyCap,
            100_000
        ),
        reserveCredits: canonicalInteger(
            nested.reserveCredits,
            defaults.reserveCredits,
            0,
            100_000
        ),
        backlogMode: AUTO_ANALYSIS_BACKLOG_MODES.includes(
            nested.backlogMode as AutoAnalysisBacklogMode
        )
            ? (nested.backlogMode as AutoAnalysisBacklogMode)
            : defaults.backlogMode,
        enabledAt: canonicalIsoTimestamp(nested.enabledAt),
    };

    return mergePreferences(base, {
        autoAnalysis,
    });
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
    const patchHasCanonicalEnabled =
        patch.autoAnalysis != null &&
        Object.prototype.hasOwnProperty.call(patch.autoAnalysis, 'enabled');
    const enabled = patchHasCanonicalEnabled
        ? patch.autoAnalysis?.enabled === true
        : base.autoAnalysis.enabled;
    const merged: PreferencesSchema = {
        ...base,
        ...patch,
        filters: { ...base.filters, ...(patch.filters ?? {}) },
        autoSyncProviders: {
            ...base.autoSyncProviders,
            ...(patch.autoSyncProviders ?? {}),
        },
        autoAnalysis: {
            ...base.autoAnalysis,
            ...(patch.autoAnalysis ?? {}),
            enabled,
            providers: {
                ...base.autoAnalysis.providers,
                ...(patch.autoAnalysis?.providers ?? {}),
            },
            timeControls: {
                ...base.autoAnalysis.timeControls,
                ...(patch.autoAnalysis?.timeControls ?? {}),
            },
        },
    };

    return merged;
}

function preferenceRecord(value: unknown): Record<string, unknown> {
    return optionalPreferenceRecord(value) ?? {};
}

function optionalPreferenceRecord(
    value: unknown
): Record<string, unknown> | null {
    return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function canonicalBoolean(value: unknown, fallback: boolean) {
    return typeof value === 'boolean' ? value : fallback;
}

function canonicalBooleanRecord<K extends string>(
    defaults: Record<K, boolean>,
    raw: Record<string, unknown>
) {
    return Object.fromEntries(
        (Object.keys(defaults) as K[]).map((key) => [
            key,
            canonicalBoolean(raw[key], defaults[key]),
        ])
    ) as Record<K, boolean>;
}

function canonicalSelectionRecord<K extends string>(
    defaults: Record<K, boolean>,
    raw: unknown,
    keys: readonly K[]
) {
    if (Array.isArray(raw)) {
        const selected = new Set(
            raw.filter(
                (value): value is K =>
                    typeof value === 'string' && keys.includes(value as K)
            )
        );
        return Object.fromEntries(
            keys.map((key) => [key, selected.has(key)])
        ) as Record<K, boolean>;
    }
    return canonicalBooleanRecord(defaults, preferenceRecord(raw));
}

function canonicalInteger(
    value: unknown,
    fallback: number,
    min: number,
    max: number
) {
    const number =
        typeof value === 'string' && value.trim()
            ? Number(value)
            : value;
    return typeof number === 'number' &&
        Number.isSafeInteger(number) &&
        number >= min &&
        number <= max
        ? number
        : fallback;
}

function canonicalNullablePositiveInteger(
    value: unknown,
    fallback: number | null,
    max: number
) {
    if (value === null) return null;
    const defaultValue = fallback ?? 1;
    const parsed = canonicalInteger(value, defaultValue, 1, max);
    return parsed;
}

function canonicalIsoTimestamp(value: unknown) {
    if (typeof value !== 'string') return null;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}
