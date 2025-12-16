import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { NormalizedGame } from '@/lib/types/game';
import type { GameAnalysis } from '@/lib/analysis/classification';
import {
    normalizedGameToDb,
    parseExternalId,
    providerToDb,
    timeClassToDb,
    gameAnalysisToJson,
} from '@/lib/api/games';
import { Prisma } from '@prisma/client';

export const runtime = 'nodejs';

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
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
    if (provider === 'lichess' || provider === 'chesscom') {
        where.provider = providerToDb(provider);
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
    if (since) {
        const d = new Date(since);
        if (!Number.isNaN(d.getTime())) {
            const cur =
                typeof where.playedAt === 'object' && where.playedAt
                    ? (where.playedAt as Prisma.DateTimeFilter)
                    : {};
            where.playedAt = { ...cur, gte: d };
        }
    }
    if (until) {
        const d = new Date(until);
        if (!Number.isNaN(d.getTime())) {
            const cur =
                typeof where.playedAt === 'object' && where.playedAt
                    ? (where.playedAt as Prisma.DateTimeFilter)
                    : {};
            where.playedAt = { ...cur, lte: d };
        }
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

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = (await req.json().catch(() => ({}))) as {
        games?: NormalizedGame[];
        analyses?: Record<string, GameAnalysis>;
    };

    const games = Array.isArray(body.games) ? body.games : [];
    const analyses = body.analyses ?? {};
    if (games.length === 0) {
        return NextResponse.json({ saved: 0, skipped: 0 });
    }

    let saved = 0;
    let skipped = 0;
    const ids: Record<string, string> = {};

    for (const g of games) {
        try {
            const provider = providerToDb(g.provider);
            const externalId = parseExternalId(g);

            const analysis = analyses[g.id];
            const createData = normalizedGameToDb(g, userId);

            const data: Prisma.AnalyzedGameUncheckedCreateInput = {
                ...createData,
                provider,
                externalId,
                analysis: analysis
                    ? (gameAnalysisToJson(analysis) as Prisma.InputJsonValue)
                    : ({} as Prisma.InputJsonValue),
                analyzedAt: analysis ? new Date() : null,
            };

            const row = await prisma.analyzedGame.upsert({
                where: {
                    userId_provider_externalId: {
                        userId,
                        provider,
                        externalId,
                    },
                },
                create: data,
                update: {
                    url: data.url,
                    pgn: data.pgn,
                    playedAt: data.playedAt,
                    timeClass: data.timeClass,
                    rated: data.rated,
                    result: data.result,
                    termination: data.termination,
                    whiteName: data.whiteName,
                    whiteRating: data.whiteRating,
                    blackName: data.blackName,
                    blackRating: data.blackRating,
                    ...(analysis
                        ? {
                              analysis: data.analysis,
                              analyzedAt: new Date(),
                          }
                        : {}),
                },
                select: { id: true },
            });
            ids[g.id] = row.id;
            saved += 1;
        } catch {
            skipped += 1;
        }
    }

    return NextResponse.json({ saved, skipped, ids });
}

