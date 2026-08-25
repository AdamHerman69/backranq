import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { NormalizedGame } from '@/lib/types/game';
import { prisma } from '@/lib/prisma';
import { normalizedGameToDb } from '@/lib/api/games';
import { gameSourceToDb, parseExternalId } from '@/lib/games/dbMappings';

export type SaveNormalizedGamesResult = {
    saved: number;
    created: number;
    updated: number;
    ids: Record<string, string>;
    newGameDbIds: string[];
    errors: Array<{
        index: number;
        id?: string;
        code: GameImportErrorCode;
        error: string;
    }>;
};

export type GameImportErrorCode =
    | 'PROVENANCE_CONFLICT'
    | 'SOURCE_SNAPSHOT_CONFLICT'
    | 'CONCURRENT_MODIFICATION'
    | 'SAVE_FAILED';

export class GameProvenanceConflictError extends Error {
    readonly code = 'PROVENANCE_CONFLICT' as const;

    constructor() {
        super('Existing game has a different immutable player perspective');
        this.name = 'GameProvenanceConflictError';
    }
}

export class GameSourceSnapshotConflictError extends Error {
    readonly code = 'SOURCE_SNAPSHOT_CONFLICT' as const;

    constructor() {
        super('Existing game has a different immutable source snapshot');
        this.name = 'GameSourceSnapshotConflictError';
    }
}

function gameImportErrorCode(error: unknown): GameImportErrorCode {
    if (error instanceof GameProvenanceConflictError) return error.code;
    if (error instanceof GameSourceSnapshotConflictError) return error.code;
    if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2002' || error.code === 'P2034')
    ) {
        return 'CONCURRENT_MODIFICATION';
    }
    if (
        error instanceof Error &&
        error.message === 'Game changed concurrently during import'
    ) {
        return 'CONCURRENT_MODIFICATION';
    }
    return 'SAVE_FAILED';
}

type GameImportClient = Pick<
    Prisma.TransactionClient,
    'analyzedGame' | 'trainingMoment' | '$queryRaw'
>;

type GameData = ReturnType<typeof normalizedGameToDb>;

type PreparedEntry = {
    index: number;
    game: NormalizedGame;
    data: GameData;
};

type PreparedGroup = {
    key: string;
    provider: GameData['provider'];
    externalId: string;
    data: GameData;
    entries: PreparedEntry[];
};

type ExistingGame = {
    id: string;
    provider: GameData['provider'];
    externalId: string;
    url: string | null;
    pgn: string;
    sourcePgnHash: string;
    sourceUsername: string;
    sourceAccountId: string | null;
    userSide: GameData['userSide'];
};

type ExistingMutation = {
    group: PreparedGroup;
    existing: ExistingGame;
};

function emptyResult(): SaveNormalizedGamesResult {
    return {
        saved: 0,
        created: 0,
        updated: 0,
        ids: {},
        newGameDbIds: [],
        errors: [],
    };
}

function identityKey(provider: GameData['provider'], externalId: string) {
    return `${provider}\u0000${externalId}`;
}

function addError(
    result: SaveNormalizedGamesResult,
    entry: Pick<PreparedEntry, 'index' | 'game'>,
    error: unknown
) {
    result.errors.push({
        index: entry.index,
        id: entry.game.id,
        code: gameImportErrorCode(error),
        error: error instanceof Error ? error.message : 'Failed to save game',
    });
}

function addGroupError(
    result: SaveNormalizedGamesResult,
    group: PreparedGroup,
    error: unknown
) {
    for (const entry of group.entries) addError(result, entry, error);
}

function markSaved(
    result: SaveNormalizedGamesResult,
    group: PreparedGroup,
    id: string,
    mutation: 'created' | 'updated' | 'unchanged'
) {
    for (const entry of group.entries) {
        result.ids[entry.game.id] = id;
        result.saved += 1;
    }
    if (mutation === 'created') {
        result.created += 1;
        result.newGameDbIds.push(id);
    } else if (mutation === 'updated') {
        result.updated += 1;
    }
}

function sameProvenance(
    left: Pick<GameData, 'sourceUsername' | 'sourceAccountId' | 'userSide'>,
    right: Pick<GameData, 'sourceUsername' | 'sourceAccountId' | 'userSide'>
) {
    return (
        left.sourceUsername === right.sourceUsername &&
        left.sourceAccountId === right.sourceAccountId &&
        left.userSide === right.userSide
    );
}

function prepareGames(
    userId: string,
    games: NormalizedGame[],
    result: SaveNormalizedGamesResult
) {
    const groups = new Map<string, PreparedGroup>();
    for (let index = 0; index < games.length; index += 1) {
        const game = games[index];
        if (!game) continue;
        let data: GameData;
        try {
            data = normalizedGameToDb(game, userId);
        } catch (error) {
            addError(result, { index, game }, error);
            continue;
        }
        const externalId = parseExternalId(game);
        const provider = gameSourceToDb(game.provider);
        const key = identityKey(provider, externalId);
        const entry = { index, game, data };
        const existing = groups.get(key);
        if (!existing) {
            groups.set(key, {
                key,
                provider,
                externalId,
                data,
                entries: [entry],
            });
            continue;
        }
        if (!sameProvenance(existing.data, data)) {
            addError(result, entry, new GameProvenanceConflictError());
            continue;
        }
        if (provider === 'BACKRANQ_COACH' && existing.data.pgn !== data.pgn) {
            addError(result, entry, new GameSourceSnapshotConflictError());
            continue;
        }
        // Provider payloads are normally deduplicated before persistence. If a
        // caller repeats an identity, write only the final snapshot once and
        // resolve every equivalent input to that same row.
        existing.data = data;
        existing.entries.push(entry);
    }
    return Array.from(groups.values());
}

function validateExisting(group: PreparedGroup, existing: ExistingGame) {
    if (!sameProvenance(group.data, existing)) {
        throw new GameProvenanceConflictError();
    }
    if (
        group.provider === 'BACKRANQ_COACH' &&
        existing.pgn !== group.data.pgn
    ) {
        throw new GameSourceSnapshotConflictError();
    }
}

async function updateUrls(
    client: GameImportClient,
    userId: string,
    mutations: ExistingMutation[]
) {
    if (mutations.length === 0) return [];
    return client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "AnalyzedGame" AS game
        SET "url" = input."url",
            "updatedAt" = NOW()
        FROM (VALUES ${Prisma.join(
            mutations.map(({ existing, group }) => Prisma.sql`
                (
                    CAST(${existing.id} AS uuid),
                    CAST(${userId} AS uuid),
                    CAST(${existing.pgn} AS text),
                    CAST(${existing.sourcePgnHash} AS text),
                    CAST(${group.data.url} AS text)
                )
            `)
        )}) AS input("id", "userId", "oldPgn", "oldSourcePgnHash", "url")
        WHERE game."id" = input."id"
          AND game."userId" = input."userId"
          AND game."pgn" = input."oldPgn"
          AND game."sourcePgnHash" = input."oldSourcePgnHash"
        RETURNING game."id"
    `);
}

async function updateChangedPgns(
    client: GameImportClient,
    userId: string,
    mutations: ExistingMutation[]
) {
    if (mutations.length === 0) return [];
    return client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "AnalyzedGame" AS game
        SET "url" = input."url",
            "pgn" = input."pgn",
            "plyCount" = input."plyCount",
            "sourcePgnHash" = input."sourcePgnHash",
            "playedAt" = input."playedAt",
            "timeClass" = input."timeClass",
            "timeControlRaw" = input."timeControlRaw",
            "timeControlInitialSeconds" = input."timeControlInitialSeconds",
            "timeControlIncrementSeconds" = input."timeControlIncrementSeconds",
            "rated" = input."rated",
            "result" = input."result",
            "termination" = input."termination",
            "whiteName" = input."whiteName",
            "whiteRating" = input."whiteRating",
            "blackName" = input."blackName",
            "blackRating" = input."blackRating",
            "openingEco" = input."openingEco",
            "openingName" = input."openingName",
            "openingVariation" = input."openingVariation",
            "analysis" = '{}'::jsonb,
            "analyzedAt" = NULL,
            "currentAnalysisRunId" = NULL,
            "currentAnalysisValid" = FALSE,
            "updatedAt" = NOW()
        FROM (VALUES ${Prisma.join(
            mutations.map(({ existing, group }) => Prisma.sql`
                (
                    CAST(${existing.id} AS uuid),
                    CAST(${userId} AS uuid),
                    CAST(${existing.pgn} AS text),
                    CAST(${existing.sourcePgnHash} AS text),
                    CAST(${group.data.url} AS text),
                    CAST(${group.data.pgn} AS text),
                    CAST(${group.data.plyCount} AS integer),
                    CAST(${group.data.sourcePgnHash} AS text),
                    CAST(${group.data.playedAt} AS timestamp(3)),
                    CAST(${group.data.timeClass} AS "TimeClass"),
                    CAST(${group.data.timeControlRaw} AS text),
                    CAST(${group.data.timeControlInitialSeconds} AS integer),
                    CAST(${group.data.timeControlIncrementSeconds} AS integer),
                    CAST(${group.data.rated} AS boolean),
                    CAST(${group.data.result} AS text),
                    CAST(${group.data.termination} AS text),
                    CAST(${group.data.whiteName} AS text),
                    CAST(${group.data.whiteRating} AS integer),
                    CAST(${group.data.blackName} AS text),
                    CAST(${group.data.blackRating} AS integer),
                    CAST(${group.data.openingEco} AS text),
                    CAST(${group.data.openingName} AS text),
                    CAST(${group.data.openingVariation} AS text)
                )
            `)
        )}) AS input(
            "id", "userId", "oldPgn", "oldSourcePgnHash", "url", "pgn",
            "plyCount", "sourcePgnHash", "playedAt", "timeClass", "timeControlRaw",
            "timeControlInitialSeconds", "timeControlIncrementSeconds", "rated",
            "result", "termination", "whiteName", "whiteRating", "blackName",
            "blackRating", "openingEco", "openingName", "openingVariation"
        )
        WHERE game."id" = input."id"
          AND game."userId" = input."userId"
          AND game."pgn" = input."oldPgn"
          AND game."sourcePgnHash" = input."oldSourcePgnHash"
        RETURNING game."id"
    `);
}

async function persistPreparedGames(args: {
    client: GameImportClient;
    userId: string;
    games: NormalizedGame[];
    failOnError: boolean;
}) {
    const result = emptyResult();
    const groups = prepareGames(args.userId, args.games, result);
    if (groups.length === 0 || (args.failOnError && result.errors.length > 0)) {
        return result;
    }

    const existingRows = await args.client.analyzedGame.findMany({
        where: {
            userId: args.userId,
            OR: groups.map((group) => ({
                provider: group.provider,
                externalId: group.externalId,
            })),
        },
        select: {
            id: true,
            provider: true,
            externalId: true,
            url: true,
            pgn: true,
            sourcePgnHash: true,
            sourceUsername: true,
            sourceAccountId: true,
            userSide: true,
        },
    });
    const existingByKey = new Map(
        existingRows.map((row) => [
            identityKey(row.provider, row.externalId),
            row as ExistingGame,
        ])
    );
    const newGroups: PreparedGroup[] = [];
    const unchanged: ExistingMutation[] = [];
    const urlUpdates: ExistingMutation[] = [];
    const pgnUpdates: ExistingMutation[] = [];

    for (const group of groups) {
        const existing = existingByKey.get(group.key);
        if (!existing) {
            newGroups.push(group);
            continue;
        }
        try {
            validateExisting(group, existing);
        } catch (error) {
            addGroupError(result, group, error);
            continue;
        }
        if (existing.pgn !== group.data.pgn) {
            pgnUpdates.push({ group, existing });
        } else if (existing.url !== group.data.url) {
            urlUpdates.push({ group, existing });
        } else {
            unchanged.push({ group, existing });
        }
    }

    if (args.failOnError && result.errors.length > 0) return result;
    for (const { group, existing } of unchanged) {
        markSaved(result, group, existing.id, 'unchanged');
    }

    const pendingCreates = newGroups.map((group) => ({
        group,
        id: randomUUID(),
    }));
    if (pendingCreates.length > 0) {
        const inserted = await args.client.analyzedGame.createMany({
            data: pendingCreates.map(({ group, id }) => ({
                id,
                ...group.data,
            })),
            skipDuplicates: true,
        });
        if (inserted.count !== pendingCreates.length && args.failOnError) {
            throw new Error('Game changed concurrently during import');
        }
        let insertedIds: Set<string> = new Set(
            pendingCreates.map((item) => item.id)
        );
        if (inserted.count !== pendingCreates.length) {
            const rows = await args.client.analyzedGame.findMany({
                where: { id: { in: Array.from(insertedIds) } },
                select: { id: true },
            });
            insertedIds = new Set(rows.map((row) => row.id));
        }
        for (const pending of pendingCreates) {
            if (insertedIds.has(pending.id)) {
                markSaved(result, pending.group, pending.id, 'created');
            } else {
                addGroupError(
                    result,
                    pending.group,
                    new Error('Game changed concurrently during import')
                );
            }
        }
    }

    const urlRows = await updateUrls(args.client, args.userId, urlUpdates);
    const updatedUrlIds = new Set(urlRows.map((row) => row.id));
    const pgnRows = await updateChangedPgns(
        args.client,
        args.userId,
        pgnUpdates
    );
    const updatedPgnIds = new Set(pgnRows.map((row) => row.id));
    if (
        args.failOnError &&
        (updatedUrlIds.size !== urlUpdates.length ||
            updatedPgnIds.size !== pgnUpdates.length)
    ) {
        throw new Error('Game changed concurrently during import');
    }

    for (const mutation of urlUpdates) {
        if (updatedUrlIds.has(mutation.existing.id)) {
            markSaved(result, mutation.group, mutation.existing.id, 'updated');
        } else {
            addGroupError(
                result,
                mutation.group,
                new Error('Game changed concurrently during import')
            );
        }
    }
    for (const mutation of pgnUpdates) {
        if (updatedPgnIds.has(mutation.existing.id)) {
            markSaved(result, mutation.group, mutation.existing.id, 'updated');
        } else {
            addGroupError(
                result,
                mutation.group,
                new Error('Game changed concurrently during import')
            );
        }
    }
    if (updatedPgnIds.size > 0) {
        await args.client.trainingMoment.updateMany({
            where: {
                gameId: { in: Array.from(updatedPgnIds) },
                userId: args.userId,
                archivedAt: null,
            },
            data: {
                status: 'INVALIDATED',
                archivedAt: new Date(),
            },
        });
    }
    return result;
}

export async function saveNormalizedGamesForUser(args: {
    userId: string;
    games: NormalizedGame[];
    client?: GameImportClient;
    failOnError?: boolean;
}): Promise<SaveNormalizedGamesResult> {
    if (args.games.length === 0) return emptyResult();
    const persist = (client: GameImportClient) =>
        persistPreparedGames({
            client,
            userId: args.userId,
            games: args.games,
            failOnError: args.failOnError ?? false,
        });
    if (args.client) return persist(args.client);

    try {
        return await prisma.$transaction((tx) => persist(tx), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
    } catch (error) {
        const result = emptyResult();
        for (let index = 0; index < args.games.length; index += 1) {
            const game = args.games[index];
            if (game) addError(result, { index, game }, error);
        }
        return result;
    }
}
