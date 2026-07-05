import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    analysisJobStatusFilter,
    enqueueAnalysisJobsForGames,
} from '@/lib/services/analysisJobs';
import { publishBackranqQueueMessage } from '@/lib/queues/backranq';
import { isRecord } from '@/lib/api/validation';

export const runtime = 'nodejs';

function clampInt(value: number, min: number, max: number) {
    return Math.max(min, Math.min(max, Math.trunc(value)));
}

function analysisQueueIdempotencyKey(args: {
    gameId: string;
    force: boolean;
    updatedAt?: Date | string;
}) {
    if (!args.force) return `analysis:${args.gameId}`;
    const updatedAt =
        args.updatedAt instanceof Date
            ? args.updatedAt.toISOString()
            : (args.updatedAt ?? new Date().toISOString());
    return `analysis:${args.gameId}:reanalysis:${updatedAt}`;
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

    const jobs = await prisma.analysisJob.findMany({
        where: { userId, ...(status ? { status } : {}) },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        take: limit,
        select: {
            id: true,
            gameId: true,
            status: true,
            attempts: true,
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

    return NextResponse.json({ jobs });
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

    const owned = await prisma.analyzedGame.findMany({
        where: { userId, id: { in: Array.from(new Set(gameIds)) } },
        select: { id: true },
    });
    const ownedIds = owned.map((game) => game.id);
    if (ownedIds.length === 0) {
        return NextResponse.json({ error: 'No matching games' }, { status: 404 });
    }

    const force = body.force === true;
    const results = await enqueueAnalysisJobsForGames({
        userId,
        gameIds: ownedIds,
        queuedReason: force ? 'manual-reanalysis' : 'manual',
        force,
    });

    for (const result of results) {
        if (!result.queued) continue;
        await publishBackranqQueueMessage(
            { type: 'analysis-job', jobId: result.job.id },
            {
                idempotencyKey: analysisQueueIdempotencyKey({
                    gameId: result.job.gameId,
                    force,
                    updatedAt: result.job.updatedAt,
                }),
            }
        );
    }

    return NextResponse.json({
        jobs: results.map((result) => result.job),
        queued: results.filter((result) => result.queued).length,
        skipped: results.filter((result) => !result.queued).length,
    });
}
