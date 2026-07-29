import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import type { NormalizedGame } from '@/lib/types/game';
import {
    normalizedGameToDb,
    parseExternalId,
    providerToDb,
    timeClassToDb,
} from '@/lib/api/games';
import {
    boundedJsonBody,
    isRecord,
    isStrictIsoDate,
    isStrictIsoInstant,
} from '@/lib/api/validation';
import { Prisma } from '@prisma/client';
import { isValidSourcePgn } from '@/lib/chess/pgn';

export const runtime = 'nodejs';
const MAX_IMPORT_GAMES = 200;
const MAX_PGN_LENGTH = 2_000_000;
const MAX_IMPORT_BODY_BYTES = 8_000_000;
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

function optionalRating(value: unknown): value is number | null | undefined {
    return (
        value == null ||
        (typeof value === 'number' &&
            Number.isSafeInteger(value) &&
            value >= 0 &&
            value <= 5_000)
    );
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
    if (!isStrictIsoInstant(value.playedAt)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid playedAt' } };
    }
    if (!isTimeClass(value.timeClass)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid timeClass' } };
    }
    if (!optionalString(value.url, 2_048) || !optionalString(value.result, 200) || !optionalString(value.termination, 500)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid game metadata' } };
    }
    if (
        !nonEmptyString(value.pgn, MAX_PGN_LENGTH) ||
        !isValidSourcePgn(value.pgn)
    ) {
        return { error: { index, id, kind: 'validation', error: 'Invalid pgn' } };
    }

    const white = isRecord(value.white) ? value.white : null;
    const black = isRecord(value.black) ? value.black : null;
    if (!white || !black || !nonEmptyString(white.name, 200) || !nonEmptyString(black.name, 200)) {
        return { error: { index, id, kind: 'validation', error: 'Invalid players' } };
    }
    if (!optionalRating(white.rating) || !optionalRating(black.rating)) {
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

class ActiveAnalysisConflictError extends Error {
    constructor() {
        super('Cannot replace PGN while analysis is active');
    }
}

class ConcurrentGameMutationError extends Error {
    constructor() {
        super('Game changed concurrently; retry import');
    }
}

function importSaveError(error: unknown): string {
    if (
        error instanceof ActiveAnalysisConflictError ||
        error instanceof ConcurrentGameMutationError
    ) {
        return error.message;
    }
    if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
    ) {
        return 'Game changed concurrently; retry import';
    }
    return 'Failed to save game';
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

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsedBody = await boundedJsonBody(req, MAX_IMPORT_BODY_BYTES);
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error },
            { status: parsedBody.status ?? 400 }
        );
    }
    const body = parsedBody.value;
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
    if (body.analyses != null) {
        return NextResponse.json(
            {
                error: 'Imported analyses are not supported; complete an analysis run instead',
            },
            { status: 400 }
        );
    }

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

            const createData = normalizedGameToDb(g, userId);

            const data: Prisma.AnalyzedGameUncheckedCreateInput = {
                ...createData,
                provider,
                externalId,
                analysis: {} as Prisma.InputJsonValue,
                analyzedAt: null,
            };

            const key = {
                userId_provider_externalId: {
                    userId,
                    provider,
                    externalId,
                },
            };
            const row = await prisma.$transaction(
                async (tx) => {
                    const existing = await tx.analyzedGame.findUnique({
                        where: key,
                        select: { id: true, pgn: true },
                    });
                    if (!existing) {
                        return tx.analyzedGame.create({
                            data,
                            select: { id: true },
                        });
                    }

                    const pgnChanged = existing.pgn !== data.pgn;
                    if (pgnChanged) {
                        const activeJob = await tx.analysisJob.findFirst({
                            where: {
                                gameId: existing.id,
                                userId,
                                status: { in: ['QUEUED', 'RUNNING'] },
                            },
                            select: { id: true },
                        });
                        if (activeJob) {
                            throw new ActiveAnalysisConflictError();
                        }
                    }

                    const updated = await tx.analyzedGame.updateMany({
                        where: {
                            id: existing.id,
                            userId,
                            ...(pgnChanged ? { pgn: existing.pgn } : {}),
                        },
                        data: {
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
                            ...(pgnChanged
                                ? {
                                      analysis: {} as Prisma.InputJsonValue,
                                      analyzedAt: null,
                                      currentAnalysisRunId: null,
                                  }
                                : {}),
                        },
                    });
                    if (updated.count !== 1) {
                        throw new ConcurrentGameMutationError();
                    }

                    if (pgnChanged) {
                        const archivedAt = new Date();
                        await tx.trainingMoment.updateMany({
                            where: {
                                gameId: existing.id,
                                archivedAt: null,
                            },
                            data: {
                                status: 'INVALIDATED',
                                archivedAt,
                            },
                        });
                    }
                    return { id: existing.id };
                },
                {
                    isolationLevel:
                        Prisma.TransactionIsolationLevel.Serializable,
                }
            );
            ids[g.id] = row.id;
            saved += 1;
        } catch (error) {
            errors.push({
                index,
                id: g.id,
                kind: 'save',
                error: importSaveError(error),
            });
        }
    }

    const skipped = errors.length;
    const hasConflict = errors.some(
        (error) =>
            error.kind === 'save' &&
            (error.error === 'Cannot replace PGN while analysis is active' ||
                error.error === 'Game changed concurrently; retry import')
    );
    const status =
        saved > 0
            ? 200
            : hasConflict
              ? 409
              : errors.some((error) => error.kind === 'save')
                ? 500
                : 400;
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
