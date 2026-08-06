import type { MasterAccount, Prisma } from '@prisma/client';
import { fetchChessComGames } from '@/lib/providers/chesscom';
import { fetchLichessGames } from '@/lib/providers/lichess';
import { hashSourcePgn } from '@/lib/chess/pgn';
import {
    parseExternalId,
    providerToDb,
    timeClassToDb,
} from '@/lib/api/games';
import { prisma } from '@/lib/prisma';
import type { NormalizedGame } from '@/lib/types/game';
import { masterContentHash } from '@/lib/master/ranking';

export type ImportedMasterSnapshot = Awaited<
    ReturnType<typeof persistMasterSourceSnapshot>
>;

function featuredSide(game: NormalizedGame) {
    if (game.provenance?.userSide === 'white') return 'WHITE' as const;
    if (game.provenance?.userSide === 'black') return 'BLACK' as const;
    return 'UNKNOWN' as const;
}

function snapshotValue(game: NormalizedGame) {
    return {
        version: 1,
        provider: game.provider,
        externalId: parseExternalId(game),
        url: game.url ?? null,
        pgn: game.pgn,
        playedAt: game.playedAt,
        timeClass: game.timeClass,
        timeControl: game.provenance?.timeControl ?? null,
        rated: game.rated ?? null,
        result: game.result ?? null,
        termination: game.termination ?? null,
        white: game.white,
        black: game.black,
    };
}

export async function persistMasterSourceSnapshot(args: {
    account: MasterAccount;
    game: NormalizedGame;
    pipelineRunId: string;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    const provider = providerToDb(args.game.provider);
    const externalId = parseExternalId(args.game);
    const pgnHash = hashSourcePgn(args.game.pgn);
    const snapshotHash = masterContentHash(snapshotValue(args.game));
    const timeControl = args.game.provenance?.timeControl;

    return prisma.$transaction(async (tx) => {
        const sourceGame = await tx.masterSourceGame.upsert({
            where: { provider_externalId: { provider, externalId } },
            create: {
                provider,
                externalId,
                canonicalUrl: args.game.url ?? null,
                availability: 'AVAILABLE',
                firstSeenAt: now,
                lastSeenAt: now,
                lastCheckedAt: now,
            },
            update: {
                canonicalUrl: args.game.url ?? null,
                availability: 'AVAILABLE',
                lastSeenAt: now,
                lastCheckedAt: now,
                missingSince: null,
                lastError: null,
            },
        });
        await tx.masterSourceGameDiscovery.upsert({
            where: {
                sourceGameId_accountId: {
                    sourceGameId: sourceGame.id,
                    accountId: args.account.id,
                },
            },
            create: {
                sourceGameId: sourceGame.id,
                accountId: args.account.id,
                featuredSide: featuredSide(args.game),
                firstSeenAt: now,
                lastSeenAt: now,
            },
            update: {
                featuredSide: featuredSide(args.game),
                lastSeenAt: now,
            },
        });

        let snapshot = await tx.masterSourceGameSnapshot.findUnique({
            where: {
                sourceGameId_snapshotHash: {
                    sourceGameId: sourceGame.id,
                    snapshotHash,
                },
            },
        });
        let created = false;
        if (!snapshot) {
            snapshot = await tx.masterSourceGameSnapshot.create({
                data: {
                    sourceGameId: sourceGame.id,
                    pipelineRunId: args.pipelineRunId,
                    snapshotHash,
                    pgnHash,
                    pgn: args.game.pgn,
                    sourceUrl: args.game.url ?? null,
                    playedAt: new Date(args.game.playedAt),
                    timeClass: timeClassToDb(args.game.timeClass),
                    timeControlRaw: timeControl?.raw ?? null,
                    timeControlInitialSeconds:
                        timeControl?.initialSeconds ?? null,
                    timeControlIncrementSeconds:
                        timeControl?.incrementSeconds ?? null,
                    rated: args.game.rated ?? null,
                    result: args.game.result ?? null,
                    termination: args.game.termination ?? null,
                    whiteName: args.game.white.name,
                    whiteRating: args.game.white.rating ?? null,
                    blackName: args.game.black.name,
                    blackRating: args.game.black.rating ?? null,
                    providerMetadata: {
                        fetchedVia: args.game.provider,
                        normalizedContractVersion: 1,
                    } satisfies Prisma.InputJsonObject,
                    fetchedAt: now,
                },
            });
            created = true;
        }
        if (sourceGame.currentSnapshotId !== snapshot.id) {
            await tx.masterSourceGame.update({
                where: { id: sourceGame.id },
                data: { currentSnapshotId: snapshot.id },
            });
        }
        return { sourceGame, snapshot, created };
    });
}

export async function fetchAndPersistMasterAccount(args: {
    account: MasterAccount;
    pipelineRunId: string;
    since: Date;
    maxGames: number;
    now?: Date;
}) {
    const now = args.now ?? new Date();
    try {
        const fetchGames =
            args.account.provider === 'CHESSCOM'
                ? fetchChessComGames
                : fetchLichessGames;
        const result = await fetchGames({
            username: args.account.username,
            signal: AbortSignal.timeout(15_000),
            filters: {
                since: args.since.toISOString(),
                until: now.toISOString(),
                max: args.maxGames,
                timeClasses: ['blitz', 'rapid', 'classical'],
            },
        });
        const snapshots: ImportedMasterSnapshot[] = [];
        for (const game of result.games) {
            snapshots.push(
                await persistMasterSourceSnapshot({
                    account: args.account,
                    game,
                    pipelineRunId: args.pipelineRunId,
                    now,
                })
            );
        }
        await prisma.masterAccount.update({
            where: { id: args.account.id },
            data: {
                lastFetchAt: now,
                lastSuccessAt: now,
                nextFetchAt: new Date(now.getTime() + 12 * 60 * 60_000),
                etag: result.etag ?? null,
                lastModified: result.lastModified ?? null,
                consecutiveFailures: 0,
                lastError: null,
            },
        });
        return { fetched: result.games.length, snapshots };
    } catch (error) {
        await prisma.masterAccount.update({
            where: { id: args.account.id },
            data: {
                lastFetchAt: now,
                nextFetchAt: new Date(now.getTime() + 60 * 60_000),
                consecutiveFailures: { increment: 1 },
                lastError: errorMessage(error),
            },
        });
        throw error;
    }
}

function errorMessage(error: unknown) {
    return (error instanceof Error ? error.message : String(error)).slice(
        0,
        2_000
    );
}
