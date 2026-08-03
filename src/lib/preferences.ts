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
export const GAME_AUTOMATION_EXISTING_GAME_SCOPES = ['all', 'new'] as const;
export const GAME_AUTOMATION_PROVIDER_KEYS = ['lichess', 'chesscom'] as const;
export const GAME_AUTOMATION_TIME_CONTROL_KEYS = [
    'bullet',
    'blitz',
    'rapid',
    'classical',
    'unknown',
] as const;
export const GAME_AUTOMATION_MODES = [
    'IGNORE',
    'IMPORT_ONLY',
    'AUTO_ANALYZE',
] as const;
export type AutoAnalysisResultScope =
    (typeof AUTO_ANALYSIS_RESULT_SCOPES)[number];
export type GameAutomationExistingGameScope =
    (typeof GAME_AUTOMATION_EXISTING_GAME_SCOPES)[number];
export type GameAutomationProviderKey =
    (typeof GAME_AUTOMATION_PROVIDER_KEYS)[number];
export type GameAutomationTimeControlKey =
    (typeof GAME_AUTOMATION_TIME_CONTROL_KEYS)[number];
export type GameAutomationMode = (typeof GAME_AUTOMATION_MODES)[number];
export type GameAutomationRules = Record<
    GameAutomationProviderKey,
    Record<GameAutomationTimeControlKey, GameAutomationMode>
>;

export type GameAutomationPolicy = {
    paused: boolean;
    rules: GameAutomationRules;
    analysis: {
        ratedOnly: boolean;
        resultScope: AutoAnalysisResultScope;
        minPlies: number;
        dailyCap: number | null;
        monthlyCap: number | null;
        reserveCredits: number;
        existingGames: GameAutomationExistingGameScope;
        /**
         * Controlled by the preferences route. For `existingGames: "new"`, only
         * games imported at or after this instant are eligible.
         */
        enabledAt: string | null;
    };
};

/** A derived server-side view used by auto-analysis eligibility and budgets. */
export type AutoAnalysisPolicy = GameAutomationPolicy['analysis'] & {
    enabled: boolean;
    paused: boolean;
    rules: GameAutomationRules;
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

    // A single source of truth for automatic import and analysis.
    gameAutomation: GameAutomationPolicy;

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
    'filters' | 'gameAutomation'
> & {
    filters?: Partial<Filters>;
    gameAutomation?: Omit<
        Partial<GameAutomationPolicy>,
        'rules' | 'analysis'
    > & {
        rules?: Partial<{
            [P in GameAutomationProviderKey]: Partial<
                Record<GameAutomationTimeControlKey, GameAutomationMode>
            >;
        }>;
        analysis?: Partial<GameAutomationPolicy['analysis']>;
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
        gameAutomation: {
            paused: false,
            rules: {
                lichess: {
                    bullet: 'IMPORT_ONLY',
                    blitz: 'IMPORT_ONLY',
                    rapid: 'IMPORT_ONLY',
                    classical: 'IMPORT_ONLY',
                    unknown: 'IMPORT_ONLY',
                },
                chesscom: {
                    bullet: 'IMPORT_ONLY',
                    blitz: 'IMPORT_ONLY',
                    rapid: 'IMPORT_ONLY',
                    classical: 'IMPORT_ONLY',
                    unknown: 'IMPORT_ONLY',
                },
            },
            analysis: {
                resultScope: 'draws',
                ratedOnly: true,
                minPlies: 20,
                dailyCap: 10,
                monthlyCap: 50,
                reserveCredits: 10,
                existingGames: 'new',
                enabledAt: null,
            },
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
export function canonicalPreferences(
    rawPreferences: unknown
): PreferencesSchema {
    const raw = preferenceRecord(rawPreferences);
    const currentTopLevelKeys = new Set([
        'filters',
        'gameAutomation',
        'trainingCoveragePreset',
        'trainingGradingTolerance',
        'trainingSessionMix',
        'analysisNodesPerPosition',
        'confirmationNodes',
        'themeLookaheadPlies',
    ]);
    const base = defaultPreferences();
    const withoutAutomation = Object.fromEntries(
        Object.entries(raw).filter(
            ([key]) => currentTopLevelKeys.has(key) && key !== 'gameAutomation'
        )
    );
    const common = mergePreferences(
        base,
        withoutAutomation as PartialPreferences
    );
    const nested = optionalPreferenceRecord(raw.gameAutomation) ?? {};
    const defaults = base.gameAutomation;
    const ruleSource = optionalPreferenceRecord(nested.rules) ?? {};
    const analysisSource = optionalPreferenceRecord(nested.analysis) ?? {};
    const rules = Object.fromEntries(
        GAME_AUTOMATION_PROVIDER_KEYS.map((provider) => {
            const providerSource =
                optionalPreferenceRecord(ruleSource[provider]) ?? {};
            return [
                provider,
                Object.fromEntries(
                    GAME_AUTOMATION_TIME_CONTROL_KEYS.map((timeControl) => {
                        const rawMode = providerSource[timeControl];
                        return [
                            timeControl,
                            GAME_AUTOMATION_MODES.includes(
                                rawMode as GameAutomationMode
                            )
                                ? rawMode
                                : defaults.rules[provider][timeControl],
                        ];
                    })
                ),
            ];
        })
    ) as GameAutomationRules;
    const gameAutomation: GameAutomationPolicy = {
        paused: canonicalBoolean(nested.paused, defaults.paused),
        rules,
        analysis: {
            ratedOnly: canonicalBoolean(
                analysisSource.ratedOnly,
                defaults.analysis.ratedOnly
            ),
            resultScope: AUTO_ANALYSIS_RESULT_SCOPES.includes(
                analysisSource.resultScope as AutoAnalysisResultScope
            )
                ? (analysisSource.resultScope as AutoAnalysisResultScope)
                : defaults.analysis.resultScope,
            minPlies: canonicalInteger(
                analysisSource.minPlies,
                defaults.analysis.minPlies,
                0,
                1_000
            ),
            dailyCap: canonicalNullablePositiveInteger(
                analysisSource.dailyCap,
                defaults.analysis.dailyCap,
                10_000
            ),
            monthlyCap: canonicalNullablePositiveInteger(
                analysisSource.monthlyCap,
                defaults.analysis.monthlyCap,
                100_000
            ),
            reserveCredits: canonicalInteger(
                analysisSource.reserveCredits,
                defaults.analysis.reserveCredits,
                0,
                100_000
            ),
            existingGames: GAME_AUTOMATION_EXISTING_GAME_SCOPES.includes(
                analysisSource.existingGames as GameAutomationExistingGameScope
            )
                ? (analysisSource.existingGames as GameAutomationExistingGameScope)
                : defaults.analysis.existingGames,
            enabledAt: canonicalIsoTimestamp(analysisSource.enabledAt),
        },
    };

    return mergePreferences(common, {
        gameAutomation,
    });
}

export function automationModeImports(mode: GameAutomationMode) {
    return mode === 'IMPORT_ONLY' || mode === 'AUTO_ANALYZE';
}

export function automationModeAnalyzes(mode: GameAutomationMode) {
    return mode === 'AUTO_ANALYZE';
}

export function providerImportTimeControls(
    policy: GameAutomationPolicy,
    provider: GameAutomationProviderKey
) {
    if (policy.paused) return [];
    return GAME_AUTOMATION_TIME_CONTROL_KEYS.filter((timeControl) =>
        automationModeImports(policy.rules[provider][timeControl])
    );
}

export function gameAutomationHasAutomaticAnalysis(policy: GameAutomationPolicy) {
    return (
        !policy.paused &&
        GAME_AUTOMATION_PROVIDER_KEYS.some((provider) =>
            GAME_AUTOMATION_TIME_CONTROL_KEYS.some((timeControl) =>
                automationModeAnalyzes(policy.rules[provider][timeControl])
            )
        )
    );
}

export function resolveAutoAnalysisPolicy(
    preferences: unknown
): AutoAnalysisPolicy {
    const policy = canonicalPreferences(preferences).gameAutomation;
    return {
        ...policy.analysis,
        enabled: gameAutomationHasAutomaticAnalysis(policy),
        paused: policy.paused,
        rules: policy.rules,
    };
}

export function providerImportPolicyHash(
    policy: GameAutomationPolicy,
    provider: GameAutomationProviderKey
) {
    return `v1:${provider}:${GAME_AUTOMATION_TIME_CONTROL_KEYS.filter((timeControl) =>
        automationModeImports(policy.rules[provider][timeControl])
    ).join(',')}`;
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
        gameAutomation: {
            ...base.gameAutomation,
            ...(patch.gameAutomation ?? {}),
            rules: {
                lichess: {
                    ...base.gameAutomation.rules.lichess,
                    ...(patch.gameAutomation?.rules?.lichess ?? {}),
                },
                chesscom: {
                    ...base.gameAutomation.rules.chesscom,
                    ...(patch.gameAutomation?.rules?.chesscom ?? {}),
                },
            },
            analysis: {
                ...base.gameAutomation.analysis,
                ...(patch.gameAutomation?.analysis ?? {}),
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
