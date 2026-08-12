import { NextResponse } from 'next/server';
import { after } from 'next/server';
import { auth } from '@/lib/auth';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { isAnalysisQuality } from '@/lib/analysis/quality';
import type { AnalysisDefaults } from '@/lib/preferences';
import {
    TRAINING_COVERAGE_PRESETS,
    TRAINING_GRADING_TOLERANCES,
} from '@/lib/training/config';
import {
    AnalysisBatchGamesUnavailableError,
    AnalysisBatchRequestConflictError,
    analysisBatchSummary,
    createAnalysisBatch,
    getOwnedAnalysisBatchByRequestId,
} from '@/lib/services/analysisBatches';
import { flushAnalysisOutbox } from '@/lib/services/analysisOutbox';

export const runtime = 'nodejs';

const MAX_POST_BODY_BYTES = 100_000;
const MAX_GAMES = 2_000;
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const requestId = new URL(req.url).searchParams.get('requestId')?.trim();
    if (!requestId || !UUID_PATTERN.test(requestId)) {
        return NextResponse.json({ error: 'Invalid requestId' }, { status: 400 });
    }
    const batch = await getOwnedAnalysisBatchByRequestId(userId, requestId);
    if (!batch) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json(
        { batch: await analysisBatchSummary(batch) },
        { headers: { 'Cache-Control': 'private, no-store' } }
    );
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const body = await boundedJsonBody(req, MAX_POST_BODY_BYTES);
    if (!body.ok) {
        return NextResponse.json(
            { error: body.error },
            { status: body.status ?? 400 }
        );
    }
    const parsed = parseCreateBatchRequest(body.value);
    if (!parsed.ok) {
        return NextResponse.json(
            { error: parsed.error },
            { status: parsed.status ?? 400 }
        );
    }

    try {
        const result = await createAnalysisBatch({ userId, ...parsed.value });
        after(() =>
            flushAnalysisOutbox({ limit: 1 }).catch((error) => {
                console.error(
                    '[analysis batches] best-effort outbox wakeup failed',
                    error
                );
            })
        );
        return NextResponse.json(
            {
                batch: await analysisBatchSummary(result.batch),
                idempotentReplay: !result.created,
            },
            {
                status: 202,
                headers: {
                    Location: `/api/analysis/batches/${result.batch.id}`,
                    'Cache-Control': 'private, no-store',
                },
            }
        );
    } catch (error) {
        if (error instanceof AnalysisBatchRequestConflictError) {
            return NextResponse.json(
                { error: error.message, code: 'REQUEST_ID_CONFLICT' },
                { status: 409 }
            );
        }
        if (error instanceof AnalysisBatchGamesUnavailableError) {
            return NextResponse.json(
                { error: error.message, code: 'GAMES_UNAVAILABLE' },
                { status: 404 }
            );
        }
        throw error;
    }
}

function parseCreateBatchRequest(value: unknown):
    | {
          ok: true;
          value: {
              requestId: string;
              gameIds: string[];
              force: boolean;
              analysisDefaults?: AnalysisDefaults;
          };
      }
    | { ok: false; error: string; status?: number } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid request' };
    const allowed = new Set([
        'requestId',
        'gameIds',
        'force',
        'analysisDefaults',
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key))) {
        return { ok: false, error: 'Invalid analysis batch request' };
    }
    if (typeof value.requestId !== 'string' || !UUID_PATTERN.test(value.requestId.trim())) {
        return { ok: false, error: 'Invalid requestId' };
    }
    if (!Array.isArray(value.gameIds) || value.gameIds.length === 0) {
        return { ok: false, error: 'Invalid gameIds' };
    }
    if (value.gameIds.length > MAX_GAMES) {
        return {
            ok: false,
            error: `gameIds exceeds limit of ${MAX_GAMES}`,
            status: 413,
        };
    }
    if (
        !value.gameIds.every(
            (id) => typeof id === 'string' && UUID_PATTERN.test(id.trim())
        )
    ) {
        return { ok: false, error: 'Invalid gameIds' };
    }
    if ('force' in value && typeof value.force !== 'boolean') {
        return { ok: false, error: 'Invalid force' };
    }
    const analysisDefaults =
        value.analysisDefaults === undefined
            ? undefined
            : parseAnalysisDefaults(value.analysisDefaults);
    if (value.analysisDefaults !== undefined && !analysisDefaults) {
        return { ok: false, error: 'Invalid analysisDefaults' };
    }
    return {
        ok: true,
        value: {
            requestId: value.requestId.trim(),
            gameIds: Array.from(
                new Set(value.gameIds.map((id) => (id as string).trim()))
            ),
            force: value.force === true,
            analysisDefaults: analysisDefaults ?? undefined,
        },
    };
}

function parseAnalysisDefaults(value: unknown): AnalysisDefaults | null {
    if (!isRecord(value)) return null;
    if (
        Object.keys(value).some(
            (key) =>
                key !== 'analysisQuality' &&
                key !== 'trainingCoveragePreset' &&
                key !== 'trainingGradingTolerance'
        ) ||
        !isAnalysisQuality(value.analysisQuality) ||
        !TRAINING_COVERAGE_PRESETS.includes(
            value.trainingCoveragePreset as (typeof TRAINING_COVERAGE_PRESETS)[number]
        ) ||
        !TRAINING_GRADING_TOLERANCES.includes(
            value.trainingGradingTolerance as (typeof TRAINING_GRADING_TOLERANCES)[number]
        )
    ) {
        return null;
    }
    return value as AnalysisDefaults;
}
