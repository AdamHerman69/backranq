import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';

import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { auth } from '@/lib/auth';
import { expectedOwnerId } from '@/lib/auth/ownerContract';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    MAX_PGN_IMPORT_BYTES,
    parseImportedPgnCollection,
    PgnImportError,
    resolveImportedGameSide,
} from '@/lib/games/importedPgn';
import { prisma } from '@/lib/prisma';
import { saveNormalizedGamesForUser } from '@/lib/services/gameImport';
import type { NormalizedGame, TimeClass } from '@/lib/types/game';

export const runtime = 'nodejs';

const MAX_REQUEST_BYTES = MAX_PGN_IMPORT_BYTES + 64 * 1024;
const MAX_SERIALIZABLE_ATTEMPTS = 3;

class ManualPgnImportConflictError extends Error {
    readonly code = 'PERSPECTIVE_CONFLICT';

    constructor() {
        super(
            'This game already exists with a different player side. Delete it before importing a different perspective.'
        );
        this.name = 'ManualPgnImportConflictError';
    }
}

class RetryableManualPgnImportError extends Error {
    constructor() {
        super('The game library changed concurrently');
        this.name = 'RetryableManualPgnImportError';
    }
}

function timeClassFor(control: {
    initialSeconds?: number;
    incrementSeconds?: number;
}): TimeClass {
    if (control.initialSeconds == null) return 'unknown';
    const estimatedSeconds =
        control.initialSeconds + (control.incrementSeconds ?? 0) * 40;
    if (estimatedSeconds < 180) return 'bullet';
    if (estimatedSeconds < 600) return 'blitz';
    if (estimatedSeconds < 1_800) return 'rapid';
    return 'classical';
}

function isRetryableTransactionError(error: unknown) {
    return (
        error instanceof RetryableManualPgnImportError ||
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
    if (expectedOwnerId(req) !== userId) {
        return NextResponse.json(
            {
                error: 'The signed-in account changed. Reload before importing games.',
                code: 'OWNER_MISMATCH',
            },
            { status: 409 }
        );
    }

    const parsedBody = await boundedJsonBody(req, MAX_REQUEST_BYTES);
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error },
            { status: parsedBody.status ?? 400 }
        );
    }
    if (!isRecord(parsedBody.value)) {
        return NextResponse.json(
            { error: 'Invalid request body' },
            { status: 400 }
        );
    }
    const pgn = parsedBody.value.pgn;
    const playerName = parsedBody.value.playerName;
    if (typeof pgn !== 'string' || typeof playerName !== 'string') {
        return NextResponse.json(
            { error: 'PGN and player name are required' },
            { status: 400 }
        );
    }
    if (!playerName.trim() || playerName.trim().length > 200) {
        return NextResponse.json(
            { error: 'Invalid player name' },
            { status: 400 }
        );
    }

    const importedAt = new Date();
    let games: NormalizedGame[];
    try {
        games = parseImportedPgnCollection(pgn, { importedAt }).map((game) => {
            const side = resolveImportedGameSide({ game, playerName });
            const sourceUsername =
                side === 'white' ? game.whiteName : game.blackName;
            const sourceHash = hashSourcePgn(game.identityPgn);
            return {
                id: `manual_pgn:${sourceHash}`,
                provider: 'manual_pgn',
                playedAt: game.playedAt,
                timeClass: timeClassFor(game.timeControl),
                rated: game.rated,
                white: { name: game.whiteName, rating: game.whiteRating },
                black: { name: game.blackName, rating: game.blackRating },
                result: game.result,
                termination: game.termination,
                pgn: game.identityPgn,
                provenance: {
                    username: sourceUsername,
                    userSide: side,
                    timeControl: game.timeControl,
                },
            } satisfies NormalizedGame;
        });
    } catch (error) {
        const message =
            error instanceof PgnImportError
                ? error.message
                : 'The PGN could not be parsed.';
        return NextResponse.json(
            {
                error: message,
                code:
                    error instanceof PgnImportError
                        ? error.code
                        : 'INVALID_PGN',
            },
            { status: 400 }
        );
    }

    const distinct = new Map<string, NormalizedGame>();
    const duplicateInputIds = new Set<string>();
    for (const game of games) {
        if (distinct.has(game.id)) duplicateInputIds.add(game.id);
        else distinct.set(game.id, game);
    }

    try {
        let saved: Awaited<ReturnType<typeof saveNormalizedGamesForUser>> | null =
            null;
        for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
            try {
                saved = await prisma.$transaction(
                    async (tx) => {
                        const result = await saveNormalizedGamesForUser({
                            userId,
                            games: [...distinct.values()],
                            client: tx,
                        });
                        const failure = result.errors[0];
                        if (failure?.code === 'PROVENANCE_CONFLICT') {
                            throw new ManualPgnImportConflictError();
                        }
                        if (failure?.code === 'CONCURRENT_MODIFICATION') {
                            throw new RetryableManualPgnImportError();
                        }
                        if (failure) throw new Error(failure.error);
                        return result;
                    },
                    {
                        isolationLevel:
                            Prisma.TransactionIsolationLevel.Serializable,
                    }
                );
                break;
            } catch (error) {
                if (
                    attempt < MAX_SERIALIZABLE_ATTEMPTS &&
                    isRetryableTransactionError(error)
                ) {
                    continue;
                }
                throw error;
            }
        }
        if (!saved) throw new RetryableManualPgnImportError();

        const createdSet = new Set(saved.newGameDbIds);
        const duplicateGameIds = new Set<string>();
        for (const [normalizedId, gameId] of Object.entries(saved.ids)) {
            if (!createdSet.has(gameId) || duplicateInputIds.has(normalizedId)) {
                duplicateGameIds.add(gameId);
            }
        }
        return NextResponse.json({
            created: saved.created,
            duplicates: saved.updated + (games.length - distinct.size),
            createdGameIds: [...createdSet],
            duplicateGameIds: [...duplicateGameIds],
            needsAnalysisGameIds: [...createdSet],
        });
    } catch (error) {
        if (error instanceof ManualPgnImportConflictError) {
            return NextResponse.json(
                { error: error.message, code: error.code },
                { status: 409 }
            );
        }
        if (isRetryableTransactionError(error)) {
            return NextResponse.json(
                {
                    error: 'The game library changed while importing. Try again.',
                    code: 'CONCURRENT_MODIFICATION',
                },
                { status: 409 }
            );
        }
        return NextResponse.json(
            { error: 'The PGN could not be imported.', code: 'IMPORT_FAILED' },
            { status: 500 }
        );
    }
}
