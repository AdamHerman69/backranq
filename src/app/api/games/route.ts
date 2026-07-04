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
import { isRecord } from '@/lib/api/validation';
import { Prisma } from '@prisma/client';

export const runtime = 'nodejs';
const MAX_IMPORT_GAMES = 200;
const MAX_TEXT_LENGTH = 20_000;

type ImportError = {
    index: number;
    id?: string;
    kind: 'validation' | 'save';
    error: string;
};

function clampInt(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v));
}

function isProvider(value: unknown): value is NormalizedGame['provider'] {
    return value === 'lichess' || value === 'chesscom';
}

function isTimeClass(value: unknown): value is NormalizedGame['timeClass'] {
    return (
        value === 'bullet' ||
        value === 'blitz' ||
        value === 'rapid' ||
        value === 'classical' ||
        value === 'unknown'
    );
}

function nonEmptyString(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function optionalString(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string | null | undefined {
    return value == null || (typeof value === 'string' && value.length <= maxLength);
}

function optionalNumber(value: unknown): value is number | null | undefined {
    return value == null || (typeof value === 'number' && Number.isFinite(value));
}

function validateGame(value: unknown, index: number): { game: NormalizedGame } | { error: ImportError } {
    if (!isRecord(value)) {
        return { error: { index, kind: 'validation', error: 'Invalid game' } };
    }
    if (!nonEmptyString(value.id, 500)) {
        return { error: { index, kind: 'validation', error: 'Invalid game id' } };
    }
    const id = value.id;
    if (!isProvider(value.provider)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid provider' } };
    }
    if (!nonEmptyString(value.playedAt, 100) || Number.isNaN(new Date(value.playedAt).getTime())) {
        return { error: { index, id, kind: 'validation', error: 'Invalid playedAt' } };
    }
    if (!isTimeClass(value.timeClass)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid timeClass' } };
    }
    if (!optionalString(value.url, 2_048) || !optionalString(value.result, 200) || !optionalString(value.termination, 500)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid game metadata' } };
    }
    if (!nonEmptyString(value.pgn)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid pgn' } };
    }

    const white = isRecord(value.white) ? value.white : null;
    const black = isRecord(value.black) ? value.black : null;
    if (!white || !black || !nonEmptyString(white.name, 200) || !nonEmptyString(black.name, 200)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid players' } };
    }
    if (!optionalNumber(white.rating) || !optionalNumber(black.rating)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid ratings' } };
    }
    if (value.rated != null && typeof value.rated !== 'boolean') {
        return { error: { index, id, kind: 'validation', error: 'Invalid rated flag' } };
    }

    return {
        game: {
            id,
            provider: value.provider,
            url: typeof value.url === 'string' ? value.url : undefined,
            playedAt: value.playedAt,
            timeClass: value.timeClass,
            rated: typeof value.rated === 'boolean' ? value.rated : undefined,
            white: {
                name: white.name,
                rating: typeof white.rating === 'number' ? white.rating : undefined,
            },
            black: {
                name: black.name,
                rating: typeof black.rating === 'number' ? black.rating : undefined,
            },
            result: typeof value.result === 'string' ? value.result : undefined,
            termination:
                typeof value.termination === 'string' ? value.termination : undefined,
            pgn: value.pgn,
        },
    };
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

    const body = (await req.json().catch(() => null)) as unknown;
    if (!isRecord(body)) {
        return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
    }
    if (!Array.isArray(body.games)) {
        return NextResponse.json({ error: 'Invalid games' }, { status: 400 });
    }
    if (body.games.length === 0) {
        return NextResponse.json({ error: 'No games provided' }, { status: 400 });
    }
    if (body.games.length > MAX_IMPORT_GAMES) {
        return NextResponse.json(
            { error: `games exceeds limit of ${MAX_IMPORT_GAMES}` },
            { status: 413 }
        );
    }
    if (body.analyses != null && !isRecord(body.analyses)) {
        return NextResponse.json({ error: 'Invalid analyses' }, { status: 400 });
    }

    const analyses = (body.analyses ?? {}) as Record<string, GameAnalysis>;
    let saved = 0;
    const errors: ImportError[] = [];
    const ids: Record<string, string> = {};

    for (let index = 0; index < body.games.length; index += 1) {
        const parsed = validateGame(body.games[index], index);
        if ('error' in parsed) {
            errors.push(parsed.error);
            continue;
        }
        const g = parsed.game;
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
            errors.push({
                index,
                id: g.id,
                kind: 'save',
                error: 'Failed to save game',
            });
        }
    }

    const skipped = errors.length;
    const status = saved > 0 ? 200 : errors.some((e) => e.kind === 'save') ? 500 : 400;
    return NextResponse.json(
        {
            saved,
            skipped,
            errors,
            ids,
            ...(saved === 0 ? { error: 'No games saved' } : {}),
        },
        { status }
    );
}
