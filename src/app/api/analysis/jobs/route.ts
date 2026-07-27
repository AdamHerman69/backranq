import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    analysisJobCreditsMetadata,
    analysisJobStatusFilter,
    enqueueAnalysisJobsForGames,
    getAnalysisJobDurationMs,
    getAnalysisRunSummaryForJob,
    SERVER_ANALYSIS_EXECUTION_MODE,
    serverAnalysisConfigFromPreferences,
} from '@/lib/services/analysisJobs';
import { dispatchQueuedAnalysisJobs } from '@/lib/services/analysisScheduler';
import { isRecord } from '@/lib/api/validation';

export const runtime = 'nodejs';
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clampInt(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

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
    const limit = clampInt(Number(url.searchParams.get('limit') ?? 25), 1, 100);
    const idsParam = url.searchParams.get('ids');
    const ids = Array.from(
        new Set(
            (idsParam ?? '')
                .split(',')
                .map((id) => id.trim())
                .filter((id) => UUID_PATTERN.test(id))
                .slice(0, 100)
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
        take: limit,
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

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json().catch(() => null)) as unknown;
    if (!isRecord(body) || !Array.isArray(body.gameIds)) {
        return NextResponse.json({ error: 'Invalid gameIds' }, { status: 400 });
    }
    const gameIds = body.gameIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0
    );
    if (gameIds.length === 0) {
        return NextResponse.json({ error: 'No games provided' }, { status: 400 });
    }
    if (gameIds.length > 200) {
        return NextResponse.json(
            { error: 'gameIds exceeds limit of 200' },
            { status: 413 }
        );
    }

    const requestedIds = Array.from(new Set(gameIds));
    const owned = await prisma.analyzedGame.findMany({
        where: { userId, id: { in: requestedIds } },
        select: { id: true },
    });
    const ownedIds = owned.map((game) => game.id);
    if (ownedIds.length === 0) {
        return NextResponse.json({ error: 'No matching games' }, { status: 404 });
    }

    const force = body.force === true;
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true },
    });
    const { config } = serverAnalysisConfigFromPreferences(user?.preferences);
    const batch = await enqueueAnalysisJobsForGames({
        userId,
        gameIds: ownedIds,
        queuedReason: force ? 'manual-reanalysis' : 'manual',
        force,
        config,
    });

    const dispatch = await dispatchQueuedAnalysisJobs({
        globalLimit: 25,
        perUserLimit: 1,
    });

    return NextResponse.json({
        jobs: await Promise.all(
            batch.results.map(async (result) => ({
                ...(await analysisJobResponse(result.job)),
                acceptedInBatch: result.queued,
            }))
        ),
        requested: requestedIds.length,
        accepted: ownedIds.length,
        queued: batch.results.filter((result) => result.queued).length,
        skipped: batch.results.filter((result) => !result.queued).length,
        errors: [
            ...requestedIds
                .filter((id) => !ownedIds.includes(id))
                .map((gameId) => ({
                    gameId,
                    error: 'Game is not available for this user',
                })),
            ...batch.errors,
        ],
        dispatch,
    });
}
