import type { NormalizedGame } from '@/lib/types/game';
import { prisma } from '@/lib/prisma';
import {
    normalizedGameToDb,
    parseExternalId,
    providerToDb,
} from '@/lib/api/games';

const IMPORT_CHUNK_SIZE = 200;

function chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

export type SaveNormalizedGamesResult = {
    saved: number;
    created: number;
    updated: number;
    ids: Record<string, string>;
    newGameDbIds: string[];
    errors: Array<{ index: number; id?: string; error: string }>;
};

export async function saveNormalizedGamesForUser(args: {
    userId: string;
    games: NormalizedGame[];
}): Promise<SaveNormalizedGamesResult> {
    const result: SaveNormalizedGamesResult = {
        saved: 0,
        created: 0,
        updated: 0,
        ids: {},
        newGameDbIds: [],
        errors: [],
    };
    if (args.games.length === 0) return result;

    const existingByKey = new Set<string>();
    for (const group of chunkArray(args.games, IMPORT_CHUNK_SIZE)) {
        const byProvider = new Map<string, string[]>();
        for (const game of group) {
            const provider = providerToDb(game.provider);
            const externalId = parseExternalId(game);
            const key = `${provider}:${externalId}`;
            byProvider.set(provider, [
                ...(byProvider.get(provider) ?? []),
                externalId,
            ]);
            // Seed the key so malformed duplicates within a chunk still map consistently.
            if (existingByKey.has(key)) continue;
        }

        for (const [provider, externalIds] of byProvider) {
            const rows = await prisma.analyzedGame.findMany({
                where: {
                    userId: args.userId,
                    provider: provider as 'LICHESS' | 'CHESSCOM',
                    externalId: { in: Array.from(new Set(externalIds)) },
                },
                select: { provider: true, externalId: true },
            });
            for (const row of rows) {
                existingByKey.add(`${row.provider}:${row.externalId}`);
            }
        }
    }

    for (let index = 0; index < args.games.length; index += 1) {
        const game = args.games[index];
        if (!game) continue;
        try {
            const provider = providerToDb(game.provider);
            const externalId = parseExternalId(game);
            const key = `${provider}:${externalId}`;
            const wasExisting = existingByKey.has(key);
            const data = normalizedGameToDb(game, args.userId);
            const row = await prisma.analyzedGame.upsert({
                where: {
                    userId_provider_externalId: {
                        userId: args.userId,
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
                    openingEco: data.openingEco,
                    openingName: data.openingName,
                    openingVariation: data.openingVariation,
                },
                select: { id: true },
            });
            result.ids[game.id] = row.id;
            result.saved += 1;
            if (wasExisting) {
                result.updated += 1;
            } else {
                result.created += 1;
                result.newGameDbIds.push(row.id);
                existingByKey.add(key);
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
