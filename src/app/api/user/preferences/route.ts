import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { Prisma } from '@prisma/client';
import {
    defaultPreferences,
    mergePreferences,
    type PartialPreferences,
} from '@/lib/preferences';
import { isRecord, stringArrayValue, stringValue } from '@/lib/api/validation';

export const runtime = 'nodejs';

const STRING_PREF_KEYS = new Set<keyof PartialPreferences>([
    'puzzleOpeningFilter',
    'maxPuzzlesPerGame',
    'blunderSwingCp',
    'missedTacticSwingCp',
    'evalBandMinCp',
    'evalBandMaxCp',
    'tacticalLookaheadPlies',
    'openingSkipPlies',
    'minPvMoves',
    'minNonKingPieces',
    'confirmMovetimeMs',
    'engineMoveTimeMs',
    'uniquenessMarginCp',
]);
const BOOLEAN_PREF_KEYS = new Set<keyof PartialPreferences>([
    'requireTactical',
    'skipTrivialEndgames',
]);
const FILTER_STRING_KEYS = new Set([
    'lichessUsername',
    'chesscomUsername',
    'since',
    'until',
    'minElo',
    'maxElo',
    'max',
]);

function validatePreferencesPatch(value: unknown): { patch: PartialPreferences } | { error: string; status?: number } {
    if (!isRecord(value)) return { error: 'Invalid preferences patch' };

    const patch = {} as PartialPreferences & Record<string, unknown>;
    for (const [key, raw] of Object.entries(value)) {
        if (STRING_PREF_KEYS.has(key as keyof PartialPreferences)) {
            const parsed = stringValue(raw, key, { maxLength: 500 });
            if (!parsed.ok) return parsed;
            patch[key] = parsed.value ?? '';
            continue;
        }

        if (BOOLEAN_PREF_KEYS.has(key as keyof PartialPreferences)) {
            if (typeof raw !== 'boolean') return { error: `Invalid ${key}` };
            patch[key] = raw;
            continue;
        }

        if (key === 'puzzleMode') {
            if (raw !== 'avoidBlunder' && raw !== 'punishBlunder' && raw !== 'both') {
                return { error: 'Invalid puzzleMode' };
            }
            patch.puzzleMode = raw;
            continue;
        }

        if (key === 'puzzleIdx') {
            if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
                return { error: 'Invalid puzzleIdx' };
            }
            patch.puzzleIdx = raw;
            continue;
        }

        if (key === 'puzzleTagFilter') {
            const parsed = stringArrayValue(raw, key, {
                maxItems: 50,
                maxLength: 100,
                dedupe: true,
            });
            if (!parsed.ok) return parsed;
            patch.puzzleTagFilter = parsed.value;
            continue;
        }

        if (key === 'puzzles') {
            if (!Array.isArray(raw)) return { error: 'Invalid puzzles' };
            if (raw.length > 200) {
                return { error: 'puzzles exceeds limit of 200', status: 413 };
            }
            if (!raw.every(isRecord)) return { error: 'Invalid puzzles' };
            patch.puzzles = raw as PartialPreferences['puzzles'];
            continue;
        }

        if (key === 'filters') {
            if (!isRecord(raw)) return { error: 'Invalid filters' };
            const filters = {} as NonNullable<PartialPreferences['filters']> &
                Record<string, unknown>;
            for (const [filterKey, filterRaw] of Object.entries(raw)) {
                if (FILTER_STRING_KEYS.has(filterKey)) {
                    const parsed = stringValue(filterRaw, `filters.${filterKey}`, {
                        maxLength: 500,
                    });
                    if (!parsed.ok) return parsed;
                    filters[filterKey] = parsed.value ?? '';
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

    const parsed = validatePreferencesPatch(await req.json().catch(() => null));
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

    await prisma.user.update({
        where: { id: userId },
        data: { preferences: next as unknown as Prisma.InputJsonValue },
    });

    return NextResponse.json({ preferences: next });
}
