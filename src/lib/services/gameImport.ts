import { Prisma } from '@prisma/client';
import type { NormalizedGame } from '@/lib/types/game';
import { prisma } from '@/lib/prisma';
import {
    normalizedGameToDb,
    parseExternalId,
    gameSourceToDb,
} from '@/lib/api/games';

export type SaveNormalizedGamesResult = {
    saved: number;
    created: number;
    updated: number;
    ids: Record<string, string>;
    newGameDbIds: string[];
    errors: Array<{ index: number; id?: string; error: string }>;
};

export class GameProvenanceConflictError extends Error {
    constructor() {
        super('Existing game has a different immutable player perspective');
        this.name = 'GameProvenanceConflictError';
    }
}

type GameImportClient = Pick<
    Prisma.TransactionClient,
    'analyzedGame' | 'trainingMoment'
>;

async function saveNormalizedGame(args: {
    client: GameImportClient;
    userId: string;
    game: NormalizedGame;
}) {
    const provider = gameSourceToDb(args.game.provider);
    const externalId = parseExternalId(args.game);
    const data = normalizedGameToDb(args.game, args.userId);
    const existing = await args.client.analyzedGame.findUnique({
        where: {
            userId_provider_externalId: {
                userId: args.userId,
                provider,
                externalId,
            },
        },
        select: {
            id: true,
            pgn: true,
            sourcePgnHash: true,
            sourceUsername: true,
            sourceAccountId: true,
            userSide: true,
        },
    });

    if (!existing) {
        const created = await args.client.analyzedGame.create({
            data,
            select: { id: true },
        });
        return { id: created.id, created: true };
    }

    // Compare the stored bytes, not only the normalized hash. Even a provider
    // correction that only changes PGN formatting must not retain analysis
    // evidence that was produced from a different stored source snapshot.
    const pgnChanged = existing.pgn !== data.pgn;
    if (
        existing.sourceUsername !== data.sourceUsername ||
        existing.sourceAccountId !== data.sourceAccountId ||
        existing.userSide !== data.userSide
    ) {
        throw new GameProvenanceConflictError();
    }
    const updated = await args.client.analyzedGame.updateMany({
        where: {
            id: existing.id,
            userId: args.userId,
            pgn: existing.pgn,
            sourcePgnHash: existing.sourcePgnHash,
        },
        data: {
            url: data.url,
            ...(pgnChanged
                ? {
                      pgn: data.pgn,
                      sourcePgnHash: data.sourcePgnHash,
                      playedAt: data.playedAt,
                      timeClass: data.timeClass,
                      timeControlRaw: data.timeControlRaw,
                      timeControlInitialSeconds:
                          data.timeControlInitialSeconds,
                      timeControlIncrementSeconds:
                          data.timeControlIncrementSeconds,
                      rated: data.rated,
                      result: data.result,
                      termination: data.termination,
                      whiteName: data.whiteName,
                      whiteRating: data.whiteRating,
                      blackName: data.blackName,
                      blackRating: data.blackRating,
                      openingEco: data.openingEco,
                      openingName: data.openingName,
                      openingVariation: data.openingVariation,
                  }
                : {}),
            ...(pgnChanged
                ? {
                      analysis: {} as Prisma.InputJsonValue,
                      analyzedAt: null,
                      currentAnalysisRunId: null,
                      currentAnalysisValid: false,
                  }
                : {}),
        },
    });
    if (updated.count !== 1) {
        throw new Error('Game changed concurrently during import');
    }

    if (pgnChanged) {
        await args.client.trainingMoment.updateMany({
            where: {
                gameId: existing.id,
                userId: args.userId,
                archivedAt: null,
            },
            data: {
                status: 'INVALIDATED',
                archivedAt: new Date(),
            },
        });
    }

    return { id: existing.id, created: false };
}

export async function saveNormalizedGamesForUser(args: {
    userId: string;
    games: NormalizedGame[];
    client?: GameImportClient;
}): Promise<SaveNormalizedGamesResult> {
    const client = args.client ?? prisma;
    const result: SaveNormalizedGamesResult = {
        saved: 0,
        created: 0,
        updated: 0,
        ids: {},
        newGameDbIds: [],
        errors: [],
    };
    if (args.games.length === 0) return result;

    for (let index = 0; index < args.games.length; index += 1) {
        const game = args.games[index];
        if (!game) continue;
        try {
            const saved = args.client
                ? await saveNormalizedGame({
                      client,
                      userId: args.userId,
                      game,
                  })
                : await prisma.$transaction(
                      (tx) =>
                          saveNormalizedGame({
                              client: tx,
                              userId: args.userId,
                              game,
                          }),
                      {
                          isolationLevel:
                              Prisma.TransactionIsolationLevel
                                  .Serializable,
                      }
                  );
            result.ids[game.id] = saved.id;
            result.saved += 1;
            if (saved.created) {
                result.created += 1;
                result.newGameDbIds.push(saved.id);
            } else {
                result.updated += 1;
            }
        } catch (e) {
            result.errors.push({
                index,
                id: game.id,
                error: e instanceof Error ? e.message : 'Failed to save game',
            });
        }
    }

    return result;
}
