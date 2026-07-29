import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import {
    boundedJsonBody,
    isRecord,
    stringValue,
} from '@/lib/api/validation';
import { isValidSourcePgn } from '@/lib/chess/pgn';
import {
    GameDeletionConflictError,
    deleteOwnedGameSafely,
    GameDeletionNotFoundError,
    GameDeletionSettlementError,
} from '@/lib/services/gameDeletion';

export const runtime = 'nodejs';

const MAX_PGN_LENGTH = 2_000_000;
const MAX_PATCH_BODY_BYTES = 2_100_000;
const PATCH_FIELDS = new Set([
    'url',
    'pgn',
    'result',
    'termination',
    'openingEco',
    'openingName',
    'openingVariation',
]);

type GamePatch = {
    url?: string | null;
    pgn?: string;
    result?: string | null;
    termination?: string | null;
    openingEco?: string | null;
    openingName?: string | null;
    openingVariation?: string | null;
};

function nullableString(
    value: unknown,
    field: string,
    maxLength: number
): { ok: true; value: string | null } | { ok: false; error: string; status?: number } {
    if (value === null) return { ok: true, value: null };
    const parsed = stringValue(value, field, { maxLength });
    if (!parsed.ok) return parsed;
    return { ok: true, value: parsed.value ?? null };
}

function parsePatch(value: unknown):
    | { ok: true; patch: GamePatch }
    | { ok: false; error: string; status?: number } {
    if (!isRecord(value)) return { ok: false, error: 'Invalid body' };
    if ('analyzedAt' in value) {
        return {
            ok: false,
            error: 'analyzedAt is managed by analysis completion',
        };
    }
    for (const key of Object.keys(value)) {
        if (!PATCH_FIELDS.has(key)) {
            return { ok: false, error: `Unknown field ${key}` };
        }
    }

    const patch: GamePatch = {};
    if ('pgn' in value) {
        const parsed = stringValue(value.pgn, 'pgn', {
            required: true,
            maxLength: MAX_PGN_LENGTH,
        });
        if (!parsed.ok) return parsed;
        if (!isValidSourcePgn(parsed.value ?? '')) {
            return { ok: false, error: 'Invalid pgn' };
        }
        patch.pgn = parsed.value;
    }

    const fields = [
        ['url', 2_048],
        ['result', 64],
        ['termination', 256],
        ['openingEco', 16],
        ['openingName', 512],
        ['openingVariation', 512],
    ] as const;
    for (const [field, maxLength] of fields) {
        if (!(field in value)) continue;
        const parsed = nullableString(value[field], field, maxLength);
        if (!parsed.ok) return parsed;
        patch[field] = parsed.value;
    }
    return { ok: true, patch };
}

class GameNotFoundError extends Error {}
class ActiveAnalysisConflictError extends Error {}
class ConcurrentGameMutationError extends Error {}

function isSerializationConflict(error: unknown) {
    return (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2034'
    );
}

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const game = await prisma.analyzedGame.findFirst({
        where: { id, userId },
        select: {
            id: true,
            provider: true,
            externalId: true,
            url: true,
            pgn: true,
            analysis: true,
            analyzedAt: true,
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
        },
    });
    if (!game)
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ game });
}

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const requestBody = await boundedJsonBody(req, MAX_PATCH_BODY_BYTES);
    if (!requestBody.ok) {
        return NextResponse.json(
            { error: requestBody.error },
            { status: requestBody.status ?? 400 }
        );
    }
    const { id } = await params;
    const parsed = parsePatch(requestBody.value);
    if (!parsed.ok) {
        return NextResponse.json(
            { error: parsed.error },
            { status: parsed.status ?? 400 }
        );
    }
    const body = parsed.patch;

    const data: Prisma.AnalyzedGameUpdateManyMutationInput = {
        url: body.url,
        pgn: body.pgn,
        result: body.result,
        termination: body.termination,
        openingEco: body.openingEco,
        openingName: body.openingName,
        openingVariation: body.openingVariation,
    };

    try {
        const game = await prisma.$transaction(
            async (tx) => {
                const exists = await tx.analyzedGame.findFirst({
                    where: { id, userId },
                });
                if (!exists) throw new GameNotFoundError();

                const pgnChanged =
                    body.pgn !== undefined && body.pgn !== exists.pgn;
                if (pgnChanged) {
                    const activeJob = await tx.analysisJob.findFirst({
                        where: {
                            gameId: id,
                            userId,
                            status: { in: ['QUEUED', 'RUNNING'] },
                        },
                        select: { id: true },
                    });
                    if (activeJob) throw new ActiveAnalysisConflictError();
                }

                if (Object.keys(body).length === 0) return exists;
                const updated = await tx.analyzedGame.updateMany({
                    where: {
                        id,
                        userId,
                        ...(pgnChanged ? { pgn: exists.pgn } : {}),
                    },
                    data: {
                        ...data,
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
                        where: { gameId: id, archivedAt: null },
                        data: {
                            status: 'INVALIDATED',
                            archivedAt,
                        },
                    });
                }
                return tx.analyzedGame.findUniqueOrThrow({ where: { id } });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        );

        return NextResponse.json({ game });
    } catch (error) {
        if (error instanceof GameNotFoundError) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
        if (error instanceof ActiveAnalysisConflictError) {
            return NextResponse.json(
                { error: 'Cannot replace PGN while analysis is active' },
                { status: 409 }
            );
        }
        if (
            error instanceof ConcurrentGameMutationError ||
            isSerializationConflict(error)
        ) {
            return NextResponse.json(
                { error: 'Game changed concurrently; retry the update' },
                { status: 409 }
            );
        }
        throw error;
    }
}

export async function DELETE(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    try {
        const result = await deleteOwnedGameSafely({ userId, gameId: id });
        return NextResponse.json({ ok: true, ...result });
    } catch (error) {
        if (error instanceof GameDeletionNotFoundError) {
            return NextResponse.json({ error: 'Not found' }, { status: 404 });
        }
        if (isSerializationConflict(error)) {
            return NextResponse.json(
                { error: 'Game changed concurrently; retry deletion' },
                { status: 409 }
            );
        }
        if (error instanceof GameDeletionConflictError) {
            return NextResponse.json(
                { error: 'Game changed concurrently; retry deletion' },
                { status: 409 }
            );
        }
        if (error instanceof GameDeletionSettlementError) {
            return NextResponse.json(
                {
                    error: 'Could not safely settle analysis before deletion',
                },
                { status: 503 }
            );
        }
        return NextResponse.json(
            { error: 'Failed to delete game' },
            { status: 500 }
        );
    }
}
