import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';

import { parseExternalId } from '@/lib/api/games';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { auth } from '@/lib/auth';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    MAX_COACH_GAME_PGN_BYTES,
    MAX_COACH_SESSION_ID_LENGTH,
} from '@/lib/coach/completedGameContract';
import {
    CompletedCoachGameError,
    normalizedCompletedCoachGame,
} from '@/lib/coach/completedGameServer';
import { prisma } from '@/lib/prisma';
import { saveNormalizedGamesForUser } from '@/lib/services/gameImport';

export const runtime = 'nodejs';

const MAX_REQUEST_BYTES = MAX_COACH_GAME_PGN_BYTES + 16 * 1024;
const MAX_SERIALIZABLE_ATTEMPTS = 3;
const ALLOWED_KEYS = new Set(['sessionId', 'pgn', 'userSide', 'completedAt']);

class RetryableCoachSaveError extends Error {
    constructor() {
        super('The Coach game changed concurrently');
        this.name = 'RetryableCoachSaveError';
    }
}

function parseBody(value: unknown):
    | {
          ok: true;
          value: {
              sessionId: string;
              pgn: string;
              userSide: 'white' | 'black';
              completedAt: string;
          };
      }
    | { ok: false; error: string; code: string } {
    if (
        !isRecord(value) ||
        Object.keys(value).some((key) => !ALLOWED_KEYS.has(key))
    ) {
        return { ok: false, error: 'Invalid request body', code: 'INVALID_BODY' };
    }
    const sessionId =
        typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
    if (
        !sessionId ||
        sessionId.length > MAX_COACH_SESSION_ID_LENGTH ||
        !/^[A-Za-z0-9:_-]+$/.test(sessionId)
    ) {
        return {
            ok: false,
            error: 'Invalid Coach session identity',
            code: 'INVALID_SESSION',
        };
    }
    if (
        typeof value.pgn !== 'string' ||
        new TextEncoder().encode(value.pgn).byteLength >
            MAX_COACH_GAME_PGN_BYTES
    ) {
        return {
            ok: false,
            error: 'Invalid Coach PGN',
            code: 'INVALID_PGN',
        };
    }
    if (value.userSide !== 'white' && value.userSide !== 'black') {
        return {
            ok: false,
            error: 'Invalid Coach player side',
            code: 'INVALID_SIDE',
        };
    }
    if (
        typeof value.completedAt !== 'string' ||
        !value.completedAt ||
        value.completedAt.length > 64
    ) {
        return {
            ok: false,
            error: 'Invalid Coach completion time',
            code: 'INVALID_COMPLETION_TIME',
        };
    }
    return {
        ok: true,
        value: {
            sessionId,
            pgn: value.pgn,
            userSide: value.userSide,
            completedAt: value.completedAt,
        },
    };
}

function isRetryable(error: unknown) {
    return (
        error instanceof RetryableCoachSaveError ||
        (error instanceof Prisma.PrismaClientKnownRequestError &&
            (error.code === 'P2002' || error.code === 'P2034'))
    );
}

export async function POST(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const requestBody = await boundedJsonBody(req, MAX_REQUEST_BYTES);
    if (!requestBody.ok) {
        return NextResponse.json(
            { error: requestBody.error, code: 'INVALID_BODY' },
            { status: requestBody.status ?? 400 }
        );
    }
    const parsed = parseBody(requestBody.value);
    if (!parsed.ok) {
        return NextResponse.json(
            { error: parsed.error, code: parsed.code },
            { status: 400 }
        );
    }

    let game;
    try {
        game = normalizedCompletedCoachGame(parsed.value);
    } catch (error) {
        return NextResponse.json(
            {
                error:
                    error instanceof CompletedCoachGameError
                        ? error.message
                        : 'The completed Coach game is invalid.',
                code:
                    error instanceof CompletedCoachGameError
                        ? error.code
                        : 'INVALID_PGN',
            },
            { status: 400 }
        );
    }

    const externalId = parseExternalId(game);
    try {
        for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
            try {
                const saved = await prisma.$transaction(
                    async (tx) => {
                        const result = await saveNormalizedGamesForUser({
                            userId,
                            games: [game],
                            client: tx,
                        });
                        const failure = result.errors[0];
                        if (failure?.code === 'CONCURRENT_MODIFICATION') {
                            throw new RetryableCoachSaveError();
                        }
                        if (failure) {
                            if (
                                failure.code !== 'PROVENANCE_CONFLICT' &&
                                failure.code !== 'SOURCE_SNAPSHOT_CONFLICT'
                            ) {
                                throw new Error('Coach persistence failed');
                            }
                            return {
                                ok: false as const,
                                code: failure.code,
                                error:
                                    failure.code === 'PROVENANCE_CONFLICT'
                                        ? 'The saved game has a different player perspective.'
                                        : 'This Coach session was already saved with different moves.',
                            };
                        }
                        const gameId = result.ids[game.id];
                        if (!gameId) throw new Error('Saved Coach game id is missing');
                        return {
                            ok: true as const,
                            gameId,
                            created: result.created === 1,
                            needsAnalysis: result.created === 1,
                        };
                    },
                    {
                        isolationLevel:
                            Prisma.TransactionIsolationLevel.Serializable,
                    }
                );
                if (!saved.ok) {
                    return NextResponse.json(
                        { error: saved.error, code: saved.code },
                        { status: 409 }
                    );
                }
                return NextResponse.json({
                    ownerId: userId,
                    gameId: saved.gameId,
                    created: saved.created,
                    needsAnalysis: saved.needsAnalysis,
                });
            } catch (error) {
                if (attempt < MAX_SERIALIZABLE_ATTEMPTS && isRetryable(error)) {
                    continue;
                }
                throw error;
            }
        }
    } catch (error) {
        if (isRetryable(error)) {
            const existing = await prisma.analyzedGame.findUnique({
                where: {
                    userId_provider_externalId: {
                        userId,
                        provider: 'BACKRANQ_COACH',
                        externalId,
                    },
                },
                select: {
                    id: true,
                    sourcePgnHash: true,
                    sourceUsername: true,
                    userSide: true,
                },
            });
            if (existing) {
                const expectedUserSide =
                    game.provenance?.userSide === 'white' ? 'WHITE' : 'BLACK';
                if (
                    existing.userSide !== expectedUserSide ||
                    existing.sourceUsername.toLocaleLowerCase('en-US') !==
                        game.provenance?.username.toLocaleLowerCase('en-US')
                ) {
                    return NextResponse.json(
                        {
                            error: 'The saved game has a different player perspective.',
                            code: 'PROVENANCE_CONFLICT',
                        },
                        { status: 409 }
                    );
                }
                if (existing.sourcePgnHash !== hashSourcePgn(game.pgn)) {
                    return NextResponse.json(
                        {
                            error: 'This Coach session was already saved with different moves.',
                            code: 'SOURCE_SNAPSHOT_CONFLICT',
                        },
                        { status: 409 }
                    );
                }
                return NextResponse.json({
                    ownerId: userId,
                    gameId: existing.id,
                    created: false,
                    needsAnalysis: false,
                });
            }
            return NextResponse.json(
                {
                    error: 'The completed game changed concurrently. Try again.',
                    code: 'CONCURRENT_MODIFICATION',
                },
                { status: 409 }
            );
        }
        return NextResponse.json(
            {
                error: 'The completed Coach game could not be saved.',
                code: 'SAVE_FAILED',
            },
            { status: 500 }
        );
    }
    return NextResponse.json(
        { error: 'The completed Coach game could not be saved.', code: 'SAVE_FAILED' },
        { status: 500 }
    );
}
