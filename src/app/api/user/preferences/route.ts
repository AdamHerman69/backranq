import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
    ANALYSIS_NUMERIC_PREFERENCE_RULES,
    defaultPreferences,
    mergePreferences,
    TRAINING_SESSION_MIXES,
    validateAnalysisNumericPreference,
    type AnalysisNumericPreferenceKey,
    type PartialPreferences,
} from '@/lib/preferences';
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
    'autoAnalyzeEnabled',
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
    return null;
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

    const prefs = mergePreferences(
        defaultPreferences(),
        (user?.preferences ?? {}) as PartialPreferences
    );

    return NextResponse.json({ preferences: prefs });
}

export async function PUT(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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

    const cur = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
    });

    const merged = mergePreferences(
        defaultPreferences(),
        (cur?.preferences ?? {}) as PartialPreferences
    );
    const next = mergePreferences(merged, parsed.patch);
    const crossFieldError = validatePreferenceCrossFields(next);
    if (crossFieldError) {
        return NextResponse.json(
            { error: crossFieldError },
            { status: 400 }
        );
    }

    await prisma.user.update({
        where: { id: userId },
        data: { preferences: next as unknown as Prisma.InputJsonValue },
    });

    return NextResponse.json({ preferences: next });
}
