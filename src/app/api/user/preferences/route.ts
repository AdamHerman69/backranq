import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
    AUTO_ANALYSIS_RESULT_SCOPES,
    canonicalPreferences,
    gameAutomationHasAutomaticAnalysis,
    GAME_AUTOMATION_EXISTING_GAME_SCOPES,
    GAME_AUTOMATION_MODES,
    GAME_AUTOMATION_PROVIDER_KEYS,
    GAME_AUTOMATION_TIME_CONTROL_KEYS,
    mergePreferences,
    providerImportPolicyHash,
    TRAINING_SESSION_MIXES,
    type PartialPreferences,
} from '@/lib/preferences';
import { isAnalysisQuality } from '@/lib/analysis/quality';
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
    const auto = preferences.gameAutomation.analysis;
    if (
        auto.dailyGameLimit !== null &&
        auto.monthlyGameLimit !== null &&
        auto.dailyGameLimit > auto.monthlyGameLimit
    ) {
        return 'gameAutomation.analysis.dailyGameLimit must not exceed gameAutomation.analysis.monthlyGameLimit';
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

function validateGameAutomationPatch(
    raw: Record<string, unknown>
):
    | { value: NonNullable<PartialPreferences['gameAutomation']> }
    | { error: string } {
    const value: NonNullable<PartialPreferences['gameAutomation']> = {};
    for (const [key, nestedRaw] of Object.entries(raw)) {
        if (key === 'paused') {
            if (typeof nestedRaw !== 'boolean') {
                return { error: 'Invalid gameAutomation.paused' };
            }
            value.paused = nestedRaw;
            continue;
        }
        if (key === 'rules') {
            if (!isRecord(nestedRaw)) {
                return { error: 'Invalid gameAutomation.rules' };
            }
            const rules: NonNullable<
                NonNullable<PartialPreferences['gameAutomation']>['rules']
            > = {};
            for (const [provider, rawProviderRules] of Object.entries(
                nestedRaw
            )) {
                if (
                    !GAME_AUTOMATION_PROVIDER_KEYS.includes(
                        provider as (typeof GAME_AUTOMATION_PROVIDER_KEYS)[number]
                    )
                ) {
                    return {
                        error: `Unknown gameAutomation.rules.${provider}`,
                    };
                }
                if (!isRecord(rawProviderRules)) {
                    return {
                        error: `Invalid gameAutomation.rules.${provider}`,
                    };
                }
                const providerKey =
                    provider as (typeof GAME_AUTOMATION_PROVIDER_KEYS)[number];
                const providerRules: Partial<Record<
                    (typeof GAME_AUTOMATION_TIME_CONTROL_KEYS)[number],
                    (typeof GAME_AUTOMATION_MODES)[number]
                >> = {};
                for (const [timeControl, mode] of Object.entries(
                    rawProviderRules
                )) {
                    if (
                        !GAME_AUTOMATION_TIME_CONTROL_KEYS.includes(
                            timeControl as (typeof GAME_AUTOMATION_TIME_CONTROL_KEYS)[number]
                        )
                    ) {
                        return {
                            error: `Unknown gameAutomation.rules.${provider}.${timeControl}`,
                        };
                    }
                    if (
                        typeof mode !== 'string' ||
                        !GAME_AUTOMATION_MODES.includes(
                            mode as (typeof GAME_AUTOMATION_MODES)[number]
                        )
                    ) {
                        return {
                            error: `Invalid gameAutomation.rules.${provider}.${timeControl}`,
                        };
                    }
                    providerRules[
                        timeControl as (typeof GAME_AUTOMATION_TIME_CONTROL_KEYS)[number]
                    ] = mode as (typeof GAME_AUTOMATION_MODES)[number];
                }
                rules[providerKey] = providerRules;
            }
            value.rules = rules;
            continue;
        }
        if (key === 'analysis') {
            if (!isRecord(nestedRaw)) {
                return { error: 'Invalid gameAutomation.analysis' };
            }
            const analysis: NonNullable<
                NonNullable<PartialPreferences['gameAutomation']>['analysis']
            > = {};
            for (const [analysisKey, analysisRaw] of Object.entries(nestedRaw)) {
                if (analysisKey === 'enabledAt') {
                    return {
                        error: 'gameAutomation.analysis.enabledAt is server-controlled',
                    };
                }
                if (analysisKey === 'ratedOnly') {
                    if (typeof analysisRaw !== 'boolean') {
                        return {
                            error: 'Invalid gameAutomation.analysis.ratedOnly',
                        };
                    }
                    analysis.ratedOnly = analysisRaw;
                    continue;
                }
                if (analysisKey === 'resultScope') {
                    if (
                        typeof analysisRaw !== 'string' ||
                        !AUTO_ANALYSIS_RESULT_SCOPES.includes(
                            analysisRaw as (typeof AUTO_ANALYSIS_RESULT_SCOPES)[number]
                        )
                    ) {
                        return {
                            error: 'Invalid gameAutomation.analysis.resultScope',
                        };
                    }
                    analysis.resultScope =
                        analysisRaw as (typeof AUTO_ANALYSIS_RESULT_SCOPES)[number];
                    continue;
                }
                if (analysisKey === 'existingGames') {
                    if (
                        typeof analysisRaw !== 'string' ||
                        !GAME_AUTOMATION_EXISTING_GAME_SCOPES.includes(
                            analysisRaw as (typeof GAME_AUTOMATION_EXISTING_GAME_SCOPES)[number]
                        )
                    ) {
                        return {
                            error: 'Invalid gameAutomation.analysis.existingGames',
                        };
                    }
                    analysis.existingGames = analysisRaw as (
                        typeof GAME_AUTOMATION_EXISTING_GAME_SCOPES
                    )[number];
                    continue;
                }
                const integerRules = {
                    minPlies: { min: 0, max: 1_000 },
                    dailyGameLimit: { min: 1, max: 10_000, nullable: true },
                    monthlyGameLimit: { min: 1, max: 100_000, nullable: true },
                    creditReserve: { min: 0, max: 100_000 },
                } as const;
                if (analysisKey in integerRules) {
                    const parsed = validatedInteger(
                        analysisRaw,
                        `gameAutomation.analysis.${analysisKey}`,
                        integerRules[analysisKey as keyof typeof integerRules]
                    );
                    if ('error' in parsed) return parsed;
                    if (analysisKey === 'minPlies' && parsed.value !== null) {
                        analysis.minPlies = parsed.value;
                    } else if (analysisKey === 'dailyGameLimit') {
                        analysis.dailyGameLimit = parsed.value;
                    } else if (analysisKey === 'monthlyGameLimit') {
                        analysis.monthlyGameLimit = parsed.value;
                    } else if (
                        analysisKey === 'creditReserve' &&
                        parsed.value !== null
                    ) {
                        analysis.creditReserve = parsed.value;
                    }
                    continue;
                }
                return {
                    error: `Unknown gameAutomation.analysis.${analysisKey}`,
                };
            }
            value.analysis = analysis;
            continue;
        }
        return { error: `Unknown gameAutomation.${key}` };
    }
    return { value };
}

function validatePreferencesPatch(
    value: unknown
): { patch: PartialPreferences } | { error: string; status?: number } {
    if (!isRecord(value)) return { error: 'Invalid preferences patch' };

    const patch = {} as PartialPreferences & Record<string, unknown>;
    for (const [key, raw] of Object.entries(value)) {
        if (key === 'analysisQuality') {
            if (!isAnalysisQuality(raw)) {
                return { error: 'Invalid analysisQuality' };
            }
            patch.analysisQuality = raw;
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

        if (key === 'gameAutomation') {
            if (!isRecord(raw)) return { error: 'Invalid gameAutomation' };
            const parsedAutomation = validateGameAutomationPatch(raw);
            if ('error' in parsedAutomation) return parsedAutomation;
            patch.gameAutomation = parsedAutomation.value;
            continue;
        }

        if (key === 'filters') {
            if (!isRecord(raw)) return { error: 'Invalid filters' };
            const filters = {} as NonNullable<PartialPreferences['filters']> &
                Record<string, unknown>;
            for (const [filterKey, filterRaw] of Object.entries(raw)) {
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
                    if (
                        filterRaw !== 'any' &&
                        filterRaw !== 'rated' &&
                        filterRaw !== 'casual'
                    ) {
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
    if (
        gameAutomationHasAutomaticAnalysis(next.gameAutomation) &&
        result.automationPolicyChanged
    ) {
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
                    const previousAnalysisEnabled =
                        gameAutomationHasAutomaticAnalysis(
                            previous.gameAutomation
                        );
                    const nextAnalysisEnabled =
                        gameAutomationHasAutomaticAnalysis(
                            next.gameAutomation
                        );
                    const needsNewBacklogBoundary =
                        nextAnalysisEnabled &&
                        ((!previousAnalysisEnabled && nextAnalysisEnabled) ||
                            (previous.gameAutomation.analysis.existingGames !==
                                'new' &&
                                next.gameAutomation.analysis.existingGames ===
                                    'new'));
                    if (needsNewBacklogBoundary) {
                        next = mergePreferences(next, {
                            gameAutomation: {
                                analysis: {
                                    enabledAt: new Date().toISOString(),
                                },
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
                    if (requestedPatch.gameAutomation !== undefined) {
                        // Queued auto-analysis jobs may reflect a cell that is
                        // now Import only or Ignore. Reconciliation recreates
                        // only jobs allowed by the new matrix.
                        await cancelQueuedAutoAnalysisJobsInTransaction({
                            tx,
                            userId,
                        });
                        for (const provider of GAME_AUTOMATION_PROVIDER_KEYS) {
                            const previousHash = providerImportPolicyHash(
                                previous.gameAutomation,
                                provider
                            );
                            const nextHash = providerImportPolicyHash(
                                next.gameAutomation,
                                provider
                            );
                            if (previousHash === nextHash) continue;
                            await tx.providerSyncState.updateMany({
                                where: {
                                    userId,
                                    provider:
                                        provider === 'lichess'
                                            ? 'LICHESS'
                                            : 'CHESSCOM',
                                },
                                data: {
                                    importPolicyHash: nextHash,
                                    lastSyncedPlayedAt: null,
                                    cursorSincePlayedAt: null,
                                    cursorUntilPlayedAt: null,
                                    cursorWindowEnd: null,
                                    etag: null,
                                    lastModified: null,
                                    lastSuccessAt: null,
                                    lastError: null,
                                },
                            });
                        }
                    }
                    return {
                        preferences: next,
                        crossFieldError: null,
                        automationPolicyChanged:
                            requestedPatch.gameAutomation !== undefined,
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
