import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import {
    boundedJsonBody,
    isRecord,
    isStrictIsoDate,
    isStrictIsoInstant,
} from '@/lib/api/validation';
import {
    getHistoryImportSnapshot,
    HISTORY_IMPORT_BODY_LIMIT_BYTES,
    HISTORY_IMPORT_REQUEST_LIMIT,
    HISTORY_CURSOR_MAX_LENGTH,
    HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES,
    HistoryImportConfigurationError,
    HistoryImportConcurrencyError,
    HistoryImportCursorError,
    HistoryImportProviderFetchError,
    HistoryImportProviderNotLinkedError,
    HistoryImportProviderTimeoutError,
    HistoryImportRateLimitError,
    importHistoricalGames,
    type HistoryImportProvider,
    type HistoryImportFilters,
} from '@/lib/services/historyImport';

export const runtime = 'nodejs';

function ownerConflict() {
    return NextResponse.json(
        {
            code: 'OWNER_MISMATCH',
            error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload before importing older games.`,
        },
        { status: 409 }
    );
}

function parseProvider(value: unknown): HistoryImportProvider | null {
    return value === 'lichess' || value === 'chesscom' ? value : null;
}

function parseSnapshotFilters(
    url: URL
): { filters: HistoryImportFilters } | { error: string } {
    const timeClassParam = url.searchParams.get('timeClass');
    const allowed = new Set([
        'bullet',
        'blitz',
        'rapid',
        'classical',
        'unknown',
    ]);
    const timeClasses = timeClassParam
        ? timeClassParam.split(',').map((value) => value.trim())
        : [];
    if (timeClasses.some((value) => !allowed.has(value))) {
        return { error: 'Invalid timeClass' };
    }
    const ratedParam = url.searchParams.get('rated');
    if (
        ratedParam !== null &&
        ratedParam !== 'rated' &&
        ratedParam !== 'casual'
    ) {
        return { error: 'Invalid rated filter' };
    }
    const sinceParam = url.searchParams.get('since');
    const untilParam = url.searchParams.get('until');
    const since = sinceParam
        ? isStrictIsoInstant(sinceParam)
            ? sinceParam
            : isStrictIsoDate(sinceParam)
              ? `${sinceParam}T00:00:00.000Z`
              : null
        : undefined;
    const until = untilParam
        ? isStrictIsoInstant(untilParam)
            ? untilParam
            : isStrictIsoDate(untilParam)
              ? `${untilParam}T23:59:59.999Z`
              : null
        : undefined;
    if (since === null || until === null) {
        return { error: 'Invalid date filter' };
    }
    if (
        since &&
        until &&
        new Date(since).getTime() > new Date(until).getTime()
    ) {
        return { error: 'since must not be after until' };
    }
    return {
        filters: {
            timeClasses:
                timeClasses as HistoryImportFilters['timeClasses'],
            rated:
                ratedParam === 'rated'
                    ? true
                    : ratedParam === 'casual'
                      ? false
                      : undefined,
            since,
            until,
        },
    };
}

function knownErrorResponse(error: unknown) {
    if (error instanceof HistoryImportCursorError) {
        return NextResponse.json(
            {
                error: error.message,
                resetRequired: error.resetRequired,
            },
            { status: error.httpStatus }
        );
    }
    if (error instanceof HistoryImportProviderNotLinkedError) {
        return NextResponse.json(
            { error: error.message },
            { status: 409 }
        );
    }
    if (error instanceof HistoryImportConcurrencyError) {
        return NextResponse.json(
            { error: error.message, retryable: true },
            { status: 409 }
        );
    }
    if (error instanceof HistoryImportConfigurationError) {
        return NextResponse.json(
            { error: error.message, retryable: false },
            { status: 500 }
        );
    }
    if (error instanceof HistoryImportProviderTimeoutError) {
        return NextResponse.json(
            {
                error: error.message,
                retryable: true,
                sourceStatus: null,
            },
            { status: 504 }
        );
    }
    if (error instanceof HistoryImportProviderFetchError) {
        return NextResponse.json(
            {
                error: error.message,
                retryable: error.retryable,
                sourceStatus: error.sourceStatus,
            },
            { status: error.httpStatus }
        );
    }
    if (error instanceof HistoryImportRateLimitError) {
        const retryAfterSeconds = Math.max(
            1,
            Math.ceil(error.retryAfterMs / 1_000)
        );
        return NextResponse.json(
            {
                error: error.message,
                retryable: true,
                retryAfterMs: error.retryAfterMs,
            },
            {
                status: 429,
                headers: {
                    'Retry-After': String(retryAfterSeconds),
                },
            }
        );
    }
    if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
    ) {
        return NextResponse.json(
            { error: 'History import changed concurrently; retry the import' },
            { status: 409 }
        );
    }
    return null;
}

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (expectedOwnerId(req) !== userId) return ownerConflict();

    const url = new URL(req.url);
    const provider = parseProvider(url.searchParams.get('provider'));
    if (!provider) {
        return NextResponse.json(
            { error: 'Invalid provider' },
            { status: 400 }
        );
    }
    const parsedFilters = parseSnapshotFilters(url);
    if ('error' in parsedFilters) {
        return NextResponse.json(
            { error: parsedFilters.error },
            { status: 400 }
        );
    }
    const cursors = url.searchParams.getAll('cursor');
    if (
        cursors.length > 1 ||
        (cursors[0]?.length ?? 0) > HISTORY_CURSOR_MAX_LENGTH
    ) {
        return NextResponse.json(
            {
                error: 'Invalid history page cursor',
                resetRequired: true,
            },
            { status: 400 }
        );
    }

    try {
        const snapshot = await getHistoryImportSnapshot({
            userId,
            provider,
            filters: parsedFilters.filters,
            cursor: cursors[0],
            signal: req.signal,
        });
        const body = JSON.stringify(snapshot);
        if (
            Buffer.byteLength(body, 'utf8') >
            HISTORY_SNAPSHOT_RESPONSE_LIMIT_BYTES
        ) {
            throw new Error('History snapshot response exceeds its limit');
        }
        return new NextResponse(body, {
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
            },
        });
    } catch (error) {
        const known = knownErrorResponse(error);
        if (known) return known;
        console.error('Failed to fetch older-games snapshot', error);
        return NextResponse.json(
            { error: 'Failed to fetch older games' },
            { status: 502 }
        );
    }
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (expectedOwnerId(req) !== userId) return ownerConflict();

    const parsedBody = await boundedJsonBody(
        req,
        HISTORY_IMPORT_BODY_LIMIT_BYTES
    );
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error },
            { status: parsedBody.status ?? 400 }
        );
    }
    if (!isRecord(parsedBody.value)) {
        return NextResponse.json(
            { error: 'Invalid body' },
            { status: 400 }
        );
    }
    const provider = parseProvider(parsedBody.value.provider);
    if (!provider) {
        return NextResponse.json(
            { error: 'Invalid provider' },
            { status: 400 }
        );
    }
    const items = parsedBody.value.items;
    if (!Array.isArray(items) || items.length === 0) {
        return NextResponse.json(
            { error: 'No history snapshot items provided' },
            { status: 400 }
        );
    }
    if (items.length > HISTORY_IMPORT_REQUEST_LIMIT) {
        return NextResponse.json(
            {
                error: `items exceeds limit of ${HISTORY_IMPORT_REQUEST_LIMIT}`,
            },
            { status: 413 }
        );
    }

    try {
        const result = await importHistoricalGames({
            userId,
            provider,
            items,
        });
        const status =
            result.imported === 0 &&
            result.duplicates === 0 &&
            result.errors.length > 0 &&
            result.capRejected === 0
                ? 400
                : 200;
        return NextResponse.json(
            {
                ownerId: userId,
                ...result,
            },
            { status }
        );
    } catch (error) {
        const known = knownErrorResponse(error);
        if (known) return known;
        return NextResponse.json(
            { error: 'Failed to import older games' },
            { status: 500 }
        );
    }
}
