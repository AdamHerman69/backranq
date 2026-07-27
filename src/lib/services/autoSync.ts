import type { Provider } from '@prisma/client';
import type { NormalizedGame } from '@/lib/types/game';
import { fetchChessComGames } from '@/lib/providers/chesscom';
import { fetchLichessGames } from '@/lib/providers/lichess';
import { saveNormalizedGamesForUser } from '@/lib/services/gameImport';
import {
    enqueueAnalysisJob,
    serverAnalysisConfigFromPreferences,
} from '@/lib/services/analysisJobs';
import { prisma } from '@/lib/prisma';
import { eligibleAutoAnalysisGameIds } from '@/lib/services/analysisEligibility';
import {
    defaultPreferences,
    mergePreferences,
    type PartialPreferences,
    type PreferencesSchema,
} from '@/lib/preferences';

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_SYNC_MAX_GAMES = 25;

export type SyncProviderResult = {
    provider: Provider;
    username: string;
    fetched: number;
    saved: number;
    created: number;
    updated: number;
    queuedAnalysis: number;
    skipped: boolean;
    error?: string;
};

export type SyncLinkedAccountsResult = {
    usersScanned: number;
    providers: SyncProviderResult[];
};

function providerKey(provider: Provider): 'lichess' | 'chesscom' {
    return provider === 'LICHESS' ? 'lichess' : 'chesscom';
}

function providerUsername(
    provider: Provider,
    user: { lichessUsername: string | null; chesscomUsername: string | null }
) {
    return provider === 'LICHESS'
        ? user.lichessUsername
        : user.chesscomUsername;
}

function firstSyncSince() {
    return new Date(
        Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
}

function sinceFromLastPlayedAt(lastPlayedAt: Date | null | undefined) {
    if (!lastPlayedAt) return firstSyncSince();
    return new Date(lastPlayedAt.getTime() + 1).toISOString();
}

function maxPlayedAt(games: NormalizedGame[]) {
    let max: Date | null = null;
    for (const game of games) {
        const playedAt = new Date(game.playedAt);
        if (Number.isNaN(playedAt.getTime())) continue;
        if (!max || playedAt.getTime() > max.getTime()) max = playedAt;
    }
    return max;
}

function savedGames(games: NormalizedGame[], ids: Record<string, string>) {
    return games.filter((game) => ids[game.id]);
}

function autoEnabledForProvider(
    prefs: PreferencesSchema,
    provider: Provider,
    stateEnabled: boolean
) {
    if (!prefs.autoSyncEnabled) return false;
    if (!stateEnabled) return false;
    return !!prefs.autoSyncProviders[providerKey(provider)];
}

export async function syncLinkedAccounts(): Promise<SyncLinkedAccountsResult> {
    const users = await prisma.user.findMany({
        where: {
            OR: [
                { lichessUsername: { not: null } },
                { chesscomUsername: { not: null } },
            ],
        },
        select: {
            id: true,
            preferences: true,
            lichessUsername: true,
            chesscomUsername: true,
            accounts: {
                where: { provider: 'lichess' },
                select: { access_token: true },
                take: 1,
            },
        },
    });

    const providers: SyncProviderResult[] = [];
    for (const user of users) {
        const prefs = mergePreferences(
            defaultPreferences(),
            (user.preferences ?? {}) as PartialPreferences
        );
        for (const provider of ['LICHESS', 'CHESSCOM'] as const) {
            providers.push(
                await syncUserProvider({
                    user,
                    provider,
                    prefs,
                    rawPreferences: user.preferences,
                    lichessAccessToken: user.accounts[0]?.access_token ?? null,
                })
            );
        }
    }

    return { usersScanned: users.length, providers };
}

export async function syncUserProvider(args: {
    user: {
        id: string;
        lichessUsername: string | null;
        chesscomUsername: string | null;
    };
    provider: Provider;
    prefs: PreferencesSchema;
    rawPreferences?: unknown;
    lichessAccessToken?: string | null;
}): Promise<SyncProviderResult> {
    const username = providerUsername(args.provider, args.user);
    if (!username) {
        return {
            provider: args.provider,
            username: '',
            fetched: 0,
            saved: 0,
            created: 0,
            updated: 0,
            queuedAnalysis: 0,
            skipped: true,
        };
    }

    const state = await prisma.providerSyncState.upsert({
        where: {
            userId_provider: {
                userId: args.user.id,
                provider: args.provider,
            },
        },
        create: {
            userId: args.user.id,
            provider: args.provider,
            lastAttemptAt: new Date(),
        },
        update: { lastAttemptAt: new Date() },
    });

    if (!autoEnabledForProvider(args.prefs, args.provider, state.enabled)) {
        return {
            provider: args.provider,
            username,
            fetched: 0,
            saved: 0,
            created: 0,
            updated: 0,
            queuedAnalysis: 0,
            skipped: true,
        };
    }

    try {
        const filters = {
            since: sinceFromLastPlayedAt(state.lastSyncedPlayedAt),
            until: new Date().toISOString(),
            max: DEFAULT_SYNC_MAX_GAMES,
        };
        const fetched =
            args.provider === 'LICHESS'
                ? await fetchLichessGames({
                      username,
                      filters,
                      accessToken: args.lichessAccessToken,
                  })
                : await fetchChessComGames({
                      username,
                      filters,
                      etag: state.etag,
                      lastModified: state.lastModified,
                  });

        const saved = await saveNormalizedGamesForUser({
            userId: args.user.id,
            games: fetched.games,
        });

        const eligibleGames = eligibleAutoAnalysisGameIds({
            preferences: args.rawPreferences ?? {},
            games: fetched.games.filter((game) =>
                saved.newGameDbIds.includes(saved.ids[game.id])
            ),
            gameId: (game) => saved.ids[game.id],
            username,
        });
        const config = serverAnalysisConfigFromPreferences(args.prefs).config;
        const jobResults = [];
        for (const item of eligibleGames) {
            jobResults.push(
                await enqueueAnalysisJob({
                    userId: args.user.id,
                    gameId: item.gameId,
                    queuedReason: 'auto-sync',
                    priority: item.eligibility.priority,
                    config,
                })
            );
        }
        const latestPlayedAt = maxPlayedAt(savedGames(fetched.games, saved.ids));
        await prisma.providerSyncState.update({
            where: { id: state.id },
            data: {
                lastSuccessAt: new Date(),
                lastError:
                    saved.errors.length > 0
                        ? `Saved ${saved.saved}/${fetched.games.length} games; ${saved.errors.length} failed`
                        : null,
                etag: fetched.etag ?? state.etag,
                lastModified: fetched.lastModified ?? state.lastModified,
                ...(latestPlayedAt
                    ? { lastSyncedPlayedAt: latestPlayedAt }
                    : {}),
            },
        });

        return {
            provider: args.provider,
            username,
            fetched: fetched.games.length,
            saved: saved.saved,
            created: saved.created,
            updated: saved.updated,
            queuedAnalysis: jobResults.filter((r) => r.queued).length,
            skipped: false,
        };
    } catch (error) {
        const message =
            error instanceof Error ? error.message : 'Provider sync failed';
        await prisma.providerSyncState.update({
            where: { id: state.id },
            data: {
                lastError: message.slice(0, 2_000),
            },
        });
        return {
            provider: args.provider,
            username,
            fetched: 0,
            saved: 0,
            created: 0,
            updated: 0,
            queuedAnalysis: 0,
            skipped: false,
            error: message,
        };
    }
}
