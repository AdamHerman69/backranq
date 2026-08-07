import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { gameSourceToDb, timeClassToDb } from '@/lib/api/games';
import {
    isStrictIsoDate,
    isStrictIsoInstant,
} from '@/lib/api/validation';
import { Prisma } from '@prisma/client';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function parseDateFilter(
    value: string | null,
    endOfDay: boolean
): Date | null | undefined {
    if (!value) return undefined;
    if (isStrictIsoInstant(value)) return new Date(value);
    if (!isStrictIsoDate(value)) return null;
    return new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
}

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const page = clampInt(
        Number(url.searchParams.get('page') ?? 1) || 1,
        1,
        10_000
    );
    const limit = clampInt(
        Number(url.searchParams.get('limit') ?? 20) || 20,
        1,
        200
    );

    const provider = url.searchParams.get('provider');
    const timeClass = url.searchParams.get('timeClass');
    const result = url.searchParams.get('result');
    const q = url.searchParams.get('q');
    const since = url.searchParams.get('since');
    const until = url.searchParams.get('until');
    const hasAnalysis = url.searchParams.get('hasAnalysis');

    const where: Prisma.AnalyzedGameWhereInput = { userId };
    const sinceDate = parseDateFilter(since, false);
    const untilDate = parseDateFilter(until, true);
    if (sinceDate === null || untilDate === null) {
        return NextResponse.json(
            { error: 'Invalid date filter' },
            { status: 400 }
        );
    }
    if (
        sinceDate &&
        untilDate &&
        sinceDate.getTime() > untilDate.getTime()
    ) {
        return NextResponse.json(
            { error: 'since must not be after until' },
            { status: 400 }
        );
    }
    if (provider === 'lichess' || provider === 'chesscom') {
        where.provider = gameSourceToDb(provider);
    }
    if (
        timeClass === 'bullet' ||
        timeClass === 'blitz' ||
        timeClass === 'rapid' ||
        timeClass === 'classical' ||
        timeClass === 'unknown'
    ) {
        where.timeClass = timeClassToDb(timeClass);
    }
    if (typeof result === 'string' && result.trim()) {
        where.result = result.trim();
    }
    if (typeof q === 'string' && q.trim()) {
        const term = q.trim();
        where.OR = [
            { whiteName: { contains: term, mode: 'insensitive' } },
            { blackName: { contains: term, mode: 'insensitive' } },
        ];
    }
    if (sinceDate) {
        const cur =
            typeof where.playedAt === 'object' && where.playedAt
                ? (where.playedAt as Prisma.DateTimeFilter)
                : {};
        where.playedAt = { ...cur, gte: sinceDate };
    }
    if (untilDate) {
        const cur =
            typeof where.playedAt === 'object' && where.playedAt
                ? (where.playedAt as Prisma.DateTimeFilter)
                : {};
        where.playedAt = { ...cur, lte: untilDate };
    }
    if (hasAnalysis === 'true') where.analyzedAt = { not: null };
    if (hasAnalysis === 'false') where.analyzedAt = null;

    const [total, games] = await Promise.all([
        prisma.analyzedGame.count({ where }),
        prisma.analyzedGame.findMany({
            where,
            orderBy: { playedAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                provider: true,
                externalId: true,
                url: true,
                playedAt: true,
                timeClass: true,
                rated: true,
                result: true,
                termination: true,
                whiteName: true,
                whiteRating: true,
                blackName: true,
                blackRating: true,
                openingEco: true,
                openingName: true,
                openingVariation: true,
                analyzedAt: true,
                createdAt: true,
                updatedAt: true,
            },
        }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    return NextResponse.json({ games, total, page, totalPages });
}

export async function POST() {
    return NextResponse.json(
        {
            error: 'Direct game import is unavailable. Use /api/sync/history.',
        },
        {
            status: 405,
            headers: { Allow: 'GET' },
        }
    );
}
