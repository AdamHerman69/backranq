import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
    ANALYSIS_NUMERIC_PREFERENCE_RULES,
    AUTO_ANALYSIS_BACKLOG_MODES,
    AUTO_ANALYSIS_PROVIDER_KEYS,
    AUTO_ANALYSIS_RESULT_SCOPES,
    AUTO_ANALYSIS_TIME_CONTROL_KEYS,
    canonicalPreferences,
    mergePreferences,
    TRAINING_SESSION_MIXES,
    validateAnalysisNumericPreference,
    type AnalysisNumericPreferenceKey,
    type PartialPreferences,
} from '@/lib/preferences';
import { cancelQueuedAutoAnalysisJobsInTransaction } from '@/lib/services/analysisJobs';
import { scheduleAutoAnalysisWakeup } from '@/lib/services/autoAnalysisBacklog';
import {
    boundedJsonBody,
    isRecord,
    isStrictIsoDate,
    stringValue,
} from '@/lib/api/validation';
import {
    TRAINING_COVERAGE_PRESETS,
    TRAINING_GRADING_TOLERANCES,
} from '@/lib/training/config';

export const runtime = 'nodejs';
const MAX_PREFERENCES_BODY_BYTES = 256_000;

const BOOLEAN_PREF_KEYS = new Set<keyof PartialPreferences>([
    'autoSyncEnabled',
]);
const FILTER_STRING_KEYS = new Set(['lichessUsername', 'chesscomUsername']);

function isBlankOrIntegerInRange(
    value: string,
    min: number,
    max: number
): boolean {
    const trimmed = value.trim();
    if (!trimmed) return true;
    const number = Number(trimmed);
    return (
        Number.isSafeInteger(number) && number >= min && number <= max
    );
}

function validatePreferenceCrossFields(
    preferences: ReturnType<typeof mergePreferences>
): string | null {
    const { since, until, minElo, maxElo } = preferences.filters;
    if (since && until && since > until) {
        return 'filters.since must not be after filters.until';
    }
    if (minElo && maxElo && Number(minElo) > Number(maxElo)) {
        return 'filters.minElo must not exceed filters.maxElo';
    }
    const auto = preferences.autoAnalysis;
    if (
        auto.dailyCap !== null &&
        auto.monthlyCap !== null &&
        auto.dailyCap > auto.monthlyCap
    ) {
        return 'autoAnalysis.dailyCap must not exceed autoAnalysis.monthlyCap';
    }
    if (auto.enabled && !Object.values(auto.providers).some(Boolean)) {
        return 'autoAnalysis requires at least one provider when enabled';
    }
    if (auto.enabled && !Object.values(auto.timeControls).some(Boolean)) {
        return 'autoAnalysis requires at least one time control when enabled';
    }
    return null;
}

function validatedInteger(
    raw: unknown,
    path: string,
    options: { min: number; max: number; nullable?: boolean }
): { value: number | null } | { error: string } {
    if (raw === null && options.nullable) return { value: null };
    if (
        typeof raw !== 'number' ||
        !Number.isSafeInteger(raw) ||
        raw < options.min ||
        raw > options.max
    ) {
        return {
            error: `Invalid ${path}; expected ${options.min}..${options.max}${
                options.nullable ? ' or null' : ''
            }`,
        };
    }
    return { value: raw };
}

function validateAutoAnalysisPatch(
    raw: Record<string, unknown>
):
    | { value: NonNullable<PartialPreferences['autoAnalysis']> }
    | { error: string } {
    const value: NonNullable<PartialPreferences['autoAnalysis']> = {};
    for (const [key, nestedRaw] of Object.entries(raw)) {
        if (key === 'enabledAt') {
            return { error: 'autoAnalysis.enabledAt is server-controlled' };
        }
        if (key === 'enabled' || key === 'ratedOnly') {
            if (typeof nestedRaw !== 'boolean') {
                return { error: `Invalid autoAnalysis.${key}` };
            }
            value[key] = nestedRaw;
            continue;
        }
        if (key === 'providers') {
            if (!isRecord(nestedRaw)) {
                return { error: 'Invalid autoAnalysis.providers' };
            }
            const providers: NonNullable<
                NonNullable<PartialPreferences['autoAnalysis']>['providers']
            > = {};
            for (const [provider, enabled] of Object.entries(nestedRaw)) {
                if (
                    !AUTO_ANALYSIS_PROVIDER_KEYS.includes(
                        provider as (typeof AUTO_ANALYSIS_PROVIDER_KEYS)[number]
                    )
                ) {
                    return {
                        error: `Unknown autoAnalysis.providers.${provider}`,
                    };
                }
                if (typeof enabled !== 'boolean') {
                    return {
                        error: `Invalid autoAnalysis.providers.${provider}`,
                    };
                }
                providers[
                    provider as (typeof AUTO_ANALYSIS_PROVIDER_KEYS)[number]
                ] = enabled;
            }
            value.providers = providers;
            continue;
        }
        if (key === 'timeControls') {
            if (!isRecord(nestedRaw)) {
                return { error: 'Invalid autoAnalysis.timeControls' };
            }
            const controls: NonNullable<
                NonNullable<PartialPreferences['autoAnalysis']>['timeControls']
            > = {};
            for (const [control, enabled] of Object.entries(nestedRaw)) {
                if (
                    !AUTO_ANALYSIS_TIME_CONTROL_KEYS.includes(
                        control as (typeof AUTO_ANALYSIS_TIME_CONTROL_KEYS)[number]
                    )
                ) {
                    return {
                        error: `Unknown autoAnalysis.timeControls.${control}`,
                    };
                }
                if (typeof enabled !== 'boolean') {
                    return {
                        error: `Invalid autoAnalysis.timeControls.${control}`,
                    };
                }
                controls[
                    control as (typeof AUTO_ANALYSIS_TIME_CONTROL_KEYS)[number]
                ] = enabled;
            }
            value.timeControls = controls;
            continue;
        }
        if (key === 'resultScope') {
            if (
                typeof nestedRaw !== 'string' ||
                !AUTO_ANALYSIS_RESULT_SCOPES.includes(
                    nestedRaw as (typeof AUTO_ANALYSIS_RESULT_SCOPES)[number]
                )
            ) {
                return { error: 'Invalid autoAnalysis.resultScope' };
            }
            value.resultScope =
                nestedRaw as (typeof AUTO_ANALYSIS_RESULT_SCOPES)[number];
            continue;
        }
        if (key === 'backlogMode') {
            if (
                typeof nestedRaw !== 'string' ||
                !AUTO_ANALYSIS_BACKLOG_MODES.includes(
                    nestedRaw as (typeof AUTO_ANALYSIS_BACKLOG_MODES)[number]
                )
            ) {
                return { error: 'Invalid autoAnalysis.backlogMode' };
            }
            value.backlogMode =
                nestedRaw as (typeof AUTO_ANALYSIS_BACKLOG_MODES)[number];
            continue;
        }
        const integerRules = {
            minPlies: { min: 0, max: 1_000 },
            dailyCap: { min: 1, max: 10_000, nullable: true },
            monthlyCap: { min: 1, max: 100_000, nullable: true },
            reserveCredits: { min: 0, max: 100_000 },
        } as const;
        if (key in integerRules) {
            const parsed = validatedInteger(
                nestedRaw,
                `autoAnalysis.${key}`,
                integerRules[key as keyof typeof integerRules]
            );
            if ('error' in parsed) return parsed;
            if (key === 'minPlies' && parsed.value !== null) {
                value.minPlies = parsed.value;
            } else if (key === 'dailyCap') {
                value.dailyCap = parsed.value;
            } else if (key === 'monthlyCap') {
                value.monthlyCap = parsed.value;
            } else if (key === 'reserveCredits' && parsed.value !== null) {
                value.reserveCredits = parsed.value;
            }
            continue;
        }
        return { error: `Unknown autoAnalysis.${key}` };
    }
    return { value };
}

function validatePreferencesPatch(value: unknown): { patch: PartialPreferences } | { error: string; status?: number } {
    if (!isRecord(value)) return { error: 'Invalid preferences patch' };

    const patch = {} as PartialPreferences & Record<string, unknown>;
    for (const [key, raw] of Object.entries(value)) {
        if (key in ANALYSIS_NUMERIC_PREFERENCE_RULES) {
            const parsed = stringValue(raw, key, { maxLength: 32 });
            if (!parsed.ok) return parsed;
            const normalized = parsed.value ?? '';
            if (
                !validateAnalysisNumericPreference(
                    key as AnalysisNumericPreferenceKey,
                    normalized
                )
            ) {
                const rule =
                    ANALYSIS_NUMERIC_PREFERENCE_RULES[
                        key as AnalysisNumericPreferenceKey
                    ];
                return {
                    error: `Invalid ${key}; expected ${rule.min}..${rule.max}${
                        rule.allowBlank ? ' or blank' : ''
                    }`,
                };
            }
            patch[key] = normalized;
            continue;
        }

        if (BOOLEAN_PREF_KEYS.has(key as keyof PartialPreferences)) {
            if (typeof raw !== 'boolean') return { error: `Invalid ${key}` };
            patch[key] = raw;
            continue;
        }

        if (key === 'trainingCoveragePreset') {
            if (
                typeof raw !== 'string' ||
                !TRAINING_COVERAGE_PRESETS.includes(
                    raw as (typeof TRAINING_COVERAGE_PRESETS)[number]
                )
            ) {
                return { error: 'Invalid trainingCoveragePreset' };
            }
            patch.trainingCoveragePreset =
                raw as (typeof TRAINING_COVERAGE_PRESETS)[number];
            continue;
        }

        if (key === 'trainingGradingTolerance') {
            if (
                typeof raw !== 'string' ||
                !TRAINING_GRADING_TOLERANCES.includes(
                    raw as (typeof TRAINING_GRADING_TOLERANCES)[number]
                )
            ) {
                return { error: 'Invalid trainingGradingTolerance' };
            }
            patch.trainingGradingTolerance =
                raw as (typeof TRAINING_GRADING_TOLERANCES)[number];
            continue;
        }

        if (key === 'trainingSessionMix') {
            if (
                typeof raw !== 'string' ||
                !TRAINING_SESSION_MIXES.includes(
                    raw as (typeof TRAINING_SESSION_MIXES)[number]
                )
            ) {
                return { error: 'Invalid trainingSessionMix' };
            }
            patch.trainingSessionMix =
                raw as (typeof TRAINING_SESSION_MIXES)[number];
            continue;
        }

        if (key === 'autoSyncProviders') {
            if (!isRecord(raw)) return { error: 'Invalid autoSyncProviders' };
            const providers: NonNullable<PartialPreferences['autoSyncProviders']> =
                {};
            for (const [providerKey, providerRaw] of Object.entries(raw)) {
                if (providerKey !== 'lichess' && providerKey !== 'chesscom') {
                    return { error: `Unknown autoSyncProviders.${providerKey}` };
                }
                if (typeof providerRaw !== 'boolean') {
                    return { error: `Invalid autoSyncProviders.${providerKey}` };
                }
                providers[providerKey] = providerRaw;
            }
            patch.autoSyncProviders = providers;
            continue;
        }

        if (key === 'autoAnalysis') {
            if (!isRecord(raw)) return { error: 'Invalid autoAnalysis' };
            const parsedAutoAnalysis = validateAutoAnalysisPatch(raw);
            if ('error' in parsedAutoAnalysis) return parsedAutoAnalysis;
            patch.autoAnalysis = parsedAutoAnalysis.value;
            continue;
        }

        if (key === 'filters') {
            if (!isRecord(raw)) return { error: 'Invalid filters' };
            const filters = {} as NonNullable<PartialPreferences['filters']> &
                Record<string, unknown>;
            for (const [filterKey, filterRaw] of Object.entries(raw)) {
                if (FILTER_STRING_KEYS.has(filterKey)) {
                    const parsed = stringValue(filterRaw, `filters.${filterKey}`, {
                        maxLength: 128,
                    });
                    if (!parsed.ok) return parsed;
                    filters[filterKey] = parsed.value ?? '';
                    continue;
                }
                if (filterKey === 'since' || filterKey === 'until') {
                    const parsed = stringValue(
                        filterRaw,
                        `filters.${filterKey}`,
                        { maxLength: 10 }
                    );
                    if (!parsed.ok) return parsed;
                    const date = parsed.value ?? '';
                    if (date && !isStrictIsoDate(date)) {
                        return { error: `Invalid filters.${filterKey}` };
                    }
                    filters[filterKey] = date;
                    continue;
                }
                if (filterKey === 'minElo' || filterKey === 'maxElo') {
                    const parsed = stringValue(
                        filterRaw,
                        `filters.${filterKey}`,
                        { maxLength: 4 }
                    );
                    if (!parsed.ok) return parsed;
                    const rating = parsed.value ?? '';
                    if (!isBlankOrIntegerInRange(rating, 0, 5_000)) {
                        return { error: `Invalid filters.${filterKey}` };
                    }
                    filters[filterKey] = rating;
                    continue;
                }
                if (filterKey === 'max') {
                    const parsed = stringValue(filterRaw, 'filters.max', {
                        maxLength: 4,
                    });
                    if (!parsed.ok) return parsed;
                    const max = parsed.value ?? '';
                    if (!isBlankOrIntegerInRange(max, 1, 1_000)) {
                        return { error: 'Invalid filters.max' };
                    }
                    filters.max = max;
                    continue;
                }
                if (filterKey === 'timeClass') {
                    if (
                        filterRaw !== 'any' &&
                        filterRaw !== 'bullet' &&
                        filterRaw !== 'blitz' &&
                        filterRaw !== 'rapid' &&
                        filterRaw !== 'classical' &&
                        filterRaw !== 'unknown'
                    ) {
                        return { error: 'Invalid filters.timeClass' };
                    }
                    filters.timeClass = filterRaw;
                    continue;
                }
                if (filterKey === 'rated') {
                    if (filterRaw !== 'any' && filterRaw !== 'rated' && filterRaw !== 'casual') {
                        return { error: 'Invalid filters.rated' };
                    }
                    filters.rated = filterRaw;
                    continue;
                }
                return { error: `Unknown filters.${filterKey}` };
            }
            patch.filters = filters;
            continue;
        }

        return { error: `Unknown preference ${key}` };
    }

    return { patch };
}

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
    });

    const prefs = canonicalPreferences(user?.preferences ?? {});

    return NextResponse.json({ ownerId: userId, preferences: prefs });
}

export async function PUT(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (expectedOwnerId(req) !== userId) {
        return NextResponse.json(
            {
                code: 'OWNER_MISMATCH',
                error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload Settings before saving.`,
            },
            { status: 409 }
        );
    }

    const requestBody = await boundedJsonBody(req, MAX_PREFERENCES_BODY_BYTES);
    if (!requestBody.ok) {
        return NextResponse.json(
            { error: requestBody.error },
            { status: requestBody.status ?? 400 }
        );
    }

    const parsed = validatePreferencesPatch(requestBody.value);
    if ('error' in parsed) {
        return NextResponse.json(
            { error: parsed.error },
            { status: parsed.status ?? 400 }
        );
    }

    const result = await updatePreferencesTransactionally(
        userId,
        parsed.patch
    );
    if (result.crossFieldError) {
        return NextResponse.json(
            { error: result.crossFieldError },
            { status: 400 }
        );
    }
    const next = result.preferences;
    if (next.autoAnalysis.enabled && result.automationPolicyChanged) {
        scheduleAutoAnalysisWakeup(userId, 'preferences');
    }

    return NextResponse.json({ ownerId: userId, preferences: next });
}

async function updatePreferencesTransactionally(
    userId: string,
    requestedPatch: PartialPreferences
) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await prisma.$transaction(
                async (tx) => {
                    const current = await tx.user.findUnique({
                        where: { id: userId },
                        select: { preferences: true },
                    });
                    const previous = canonicalPreferences(
                        current?.preferences ?? {}
                    );
                    let next = mergePreferences(previous, requestedPatch);
                    const needsNewBacklogBoundary =
                        next.autoAnalysis.enabled &&
                        ((!previous.autoAnalysis.enabled &&
                            next.autoAnalysis.enabled) ||
                            (previous.autoAnalysis.backlogMode !== 'new' &&
                                next.autoAnalysis.backlogMode === 'new'));
                    if (needsNewBacklogBoundary) {
                        next = mergePreferences(next, {
                            autoAnalysis: {
                                enabledAt: new Date().toISOString(),
                            },
                        });
                    }

                    const crossFieldError =
                        validatePreferenceCrossFields(next);
                    if (crossFieldError) {
                        return {
                            preferences: next,
                            crossFieldError,
                            automationPolicyChanged: false,
                        };
                    }

                    await tx.user.update({
                        where: { id: userId },
                        data: {
                            preferences:
                                next as unknown as Prisma.InputJsonValue,
                        },
                    });
                    if (
                        previous.autoAnalysis.enabled &&
                        !next.autoAnalysis.enabled
                    ) {
                        await cancelQueuedAutoAnalysisJobsInTransaction({
                            tx,
                            userId,
                        });
                    }
                    return {
                        preferences: next,
                        crossFieldError: null,
                        automationPolicyChanged:
                            requestedPatch.autoAnalysis !== undefined,
                    };
                },
                {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                }
            );
        } catch (error) {
            if (attempt < maxAttempts && isTransactionWriteConflict(error)) {
                continue;
            }
            throw error;
        }
    }
    throw new Error('Preferences transaction retry limit exceeded');
}

function isTransactionWriteConflict(error: unknown) {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 'P2034'
    );
}
