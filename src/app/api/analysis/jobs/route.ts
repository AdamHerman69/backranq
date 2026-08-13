import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    analysisJobCreditsMetadata,
    analysisJobStatusFilter,
    getAnalysisJobDurationMs,
    getAnalysisRunSummaryForJob,
    SERVER_ANALYSIS_EXECUTION_MODE,
} from '@/lib/services/analysisJobs';

export const runtime = 'nodejs';
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type AnalysisJobApiRecord = {
    id: string;
    gameId: string;
    status: string;
    priority?: number;
    attempts: number;
    lockedAt?: Date | null;
    startedAt?: Date | null;
    completedAt?: Date | null;
    lastError: string | null;
    queuedReason: string | null;
    createdAt: Date;
    updatedAt: Date;
};

async function analysisJobResponse(job: AnalysisJobApiRecord) {
    const run = await getAnalysisRunSummaryForJob(job.id);
    return {
        ...job,
        executionMode: run?.executionMode ?? SERVER_ANALYSIS_EXECUTION_MODE,
        configHash: run?.configHash ?? null,
        durationMs:
            run?.durationMs ??
            getAnalysisJobDurationMs({
                startedAt: job.startedAt ?? null,
                completedAt: job.completedAt ?? null,
            }),
        credits: analysisJobCreditsMetadata(run),
        run,
    };
}

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const status = analysisJobStatusFilter(url.searchParams.get('status'));
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        return NextResponse.json(
            { error: 'limit must be an integer between 1 and 200' },
            { status: 400 }
        );
    }
    const idsParam = url.searchParams.get('ids');
    const ids = Array.from(
        new Set(
            (idsParam ?? '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => UUID_PATTERN.test(id))
                .slice(0, 200)
        )
    );
    if (idsParam != null && ids.length === 0) {
        return NextResponse.json({ jobs: [] });
    }

    const jobs = await prisma.analysisJob.findMany({
        where: {
            userId,
            ...(status ? { status } : {}),
            ...(ids.length > 0 ? { id: { in: ids } } : {}),
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: ids.length > 0 ? Math.max(limit, ids.length) : limit,
        select: {
            id: true,
            gameId: true,
            status: true,
            attempts: true,
            priority: true,
            lockedAt: true,
            startedAt: true,
            completedAt: true,
            lastError: true,
            queuedReason: true,
            createdAt: true,
            updatedAt: true,
            game: {
                select: {
                    provider: true,
                    playedAt: true,
                    whiteName: true,
                    blackName: true,
                    analyzedAt: true,
                },
            },
        },
    });

    return NextResponse.json({
        jobs: await Promise.all(jobs.map(analysisJobResponse)),
    });
}

/** Mutations use the idempotent /api/analysis/batches contract. */
export async function POST(request: Request) {
    void request;
    return NextResponse.json(
        {
            error: 'Use POST /api/analysis/batches',
            code: 'ANALYSIS_BATCH_REQUIRED',
        },
        {
            status: 405,
            headers: { Allow: 'GET' },
        }
    );
}
