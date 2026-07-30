import { Prisma, type Provider } from '@prisma/client';
import { fetchChessComGamesBatch } from '@/lib/providers/chesscom';
import { fetchLichessGamesBatch } from '@/lib/providers/lichess';
import type { ProviderBatchFetchResult } from '@/lib/providers/pagination';
import { saveNormalizedGamesForUser } from '@/lib/services/gameImport';
import { prisma } from '@/lib/prisma';
import { requestAutoAnalysisWakeup } from '@/lib/services/autoAnalysisBacklog';
import {
    defaultPreferences,
    mergePreferences,
    type PartialPreferences,
    type PreferencesSchema,
} from '@/lib/preferences';

const DEFAULT_LOOKBACK_DAYS = 90;
const FIRST_SYNC_MAX_GAMES = 100;
const LICHESS_CURSOR_OVERLAP_MS = 24 * 60 * 60 * 1_000;
const PROVIDER_SYNC_FETCH_TIMEOUT_MS = 5 * 60 * 1_000;

export type SyncProviderResult = {
    provider: Provider;
    username: string;
    fetched: number;
    saved: number;
    created: number;
    updated: number;
    importedGameIds: string[];
    queuedAnalysis: number;
    analysisErrors: number;
    complete: boolean;
    skipped: boolean;
    identityChanged?: boolean;
    error?: string;
};

export type SyncLinkedAccountsResult = {
    usersScanned: number;
    providers: SyncProviderResult[];
};

type SyncState = {
    id: string;
    enabled: boolean;
    providerUsernameNormalized: string | null;
    lastSyncedPlayedAt: Date | null;
    cursorSincePlayedAt: Date | null;
    cursorUntilPlayedAt: Date | null;
    cursorWindowEnd: Date | null;
    etag: string | null;
    lastModified: string | null;
};

type SyncWindow = {
    since: Date;
    until: Date;
    windowEnd: Date;
    firstSync: boolean;
};

class ProviderIdentityChangedError extends Error {
    constructor() {
        super('Provider identity changed while sync was running');
        this.name = 'ProviderIdentityChangedError';
    }
}

export class StaleSyncJobLeaseError extends Error {
    constructor() {
        super('Sync job lease is no longer owned by this worker');
        this.name = 'StaleSyncJobLeaseError';
    }
}

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

export function normalizeProviderUsername(username: string) {
    return username.trim().toLocaleLowerCase('en-US');
}

function firstSyncSince(now: Date) {
    return new Date(
        now.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1_000
    );
}

function startOfPreviousUtcMonth(now: Date) {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
    );
}

function incrementalSyncSince(
    provider: Provider,
    lastSyncedPlayedAt: Date,
    now: Date
) {
    const overlapSince = new Date(
        lastSyncedPlayedAt.getTime() - LICHESS_CURSOR_OVERLAP_MS
    );
    if (provider === 'LICHESS') return overlapSince;

    // Chess.com archives are mutable monthly snapshots. Re-read both the
    // current and previous UTC month so a late-visible game cannot fall behind
    // a request-time watermark merely because it appeared after the sync.
    const archiveReplaySince = startOfPreviousUtcMonth(now);
    return overlapSince.getTime() < archiveReplaySince.getTime()
        ? overlapSince
        : archiveReplaySince;
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

function syncWindow(
    state: SyncState,
    provider: Provider,
    now: Date
): SyncWindow {
    if (
        state.cursorSincePlayedAt &&
        state.cursorUntilPlayedAt &&
        state.cursorWindowEnd
    ) {
        return {
            since: state.cursorSincePlayedAt,
            until: state.cursorUntilPlayedAt,
            windowEnd: state.cursorWindowEnd,
            firstSync: false,
        };
    }
    if (state.lastSyncedPlayedAt) {
        return {
            since: incrementalSyncSince(
                provider,
                state.lastSyncedPlayedAt,
                now
            ),
            until: now,
            windowEnd: now,
            firstSync: false,
        };
    }
    return {
        since: firstSyncSince(now),
        until: now,
        windowEnd: now,
        firstSync: true,
    };
}

async function prepareSyncState(args: {
    userId: string;
    provider: Provider;
    username: string;
    usernameNormalized: string;
    now: Date;
}): Promise<SyncState> {
    let state = (await prisma.providerSyncState.upsert({
        where: {
            userId_provider: {
                userId: args.userId,
                provider: args.provider,
            },
        },
        create: {
            userId: args.userId,
            provider: args.provider,
            providerUsernameNormalized: args.usernameNormalized,
            lastAttemptAt: args.now,
        },
        update: { lastAttemptAt: args.now },
    })) as SyncState;

    // A null identity is an unlinked/new provider state. Linking it, or
    // replacing a known identity, starts a fresh provider history window.
    if (state.providerUsernameNormalized == null) {
        await assertProviderIdentityCurrent({
            userId: args.userId,
            provider: args.provider,
            usernameNormalized: args.usernameNormalized,
        });
        const established = await prisma.providerSyncState.updateMany({
            where: {
                id: state.id,
                providerUsernameNormalized: null,
            },
            data: {
                providerUsernameNormalized: args.usernameNormalized,
                lastSyncedPlayedAt: null,
                cursorSincePlayedAt: null,
                cursorUntilPlayedAt: null,
                cursorWindowEnd: null,
                etag: null,
                lastModified: null,
                lastSuccessAt: null,
                lastError: null,
            },
        });
        if (established.count !== 1) throw new ProviderIdentityChangedError();
        state = {
            ...state,
            providerUsernameNormalized: args.usernameNormalized,
            lastSyncedPlayedAt: null,
            cursorSincePlayedAt: null,
            cursorUntilPlayedAt: null,
            cursorWindowEnd: null,
            etag: null,
            lastModified: null,
        };
    } else if (
        state.providerUsernameNormalized !== args.usernameNormalized
    ) {
        await assertProviderIdentityCurrent({
            userId: args.userId,
            provider: args.provider,
            usernameNormalized: args.usernameNormalized,
        });
        const reset = await prisma.providerSyncState.updateMany({
            where: {
                id: state.id,
                providerUsernameNormalized: state.providerUsernameNormalized,
            },
            data: {
                providerUsernameNormalized: args.usernameNormalized,
                lastSyncedPlayedAt: null,
                cursorSincePlayedAt: null,
                cursorUntilPlayedAt: null,
                cursorWindowEnd: null,
                etag: null,
                lastModified: null,
                lastSuccessAt: null,
                lastError: null,
            },
        });
        if (reset.count !== 1) throw new ProviderIdentityChangedError();
        state = {
            ...state,
            providerUsernameNormalized: args.usernameNormalized,
            lastSyncedPlayedAt: null,
            cursorSincePlayedAt: null,
            cursorUntilPlayedAt: null,
            cursorWindowEnd: null,
            etag: null,
            lastModified: null,
        };
    }
    return state;
}

async function assertProviderIdentityCurrent(args: {
    userId: string;
    provider: Provider;
    usernameNormalized: string;
}) {
    const user = await prisma.user.findUnique({
        where: { id: args.userId },
        select: {
            lichessUsername: true,
            chesscomUsername: true,
        },
    });
    const current = user ? providerUsername(args.provider, user)?.trim() : null;
    if (
        !current ||
        normalizeProviderUsername(current) !== args.usernameNormalized
    ) {
        throw new ProviderIdentityChangedError();
    }
}

function stateIdentityWhere(args: {
    stateId: string;
    provider: Provider;
    username: string;
    usernameNormalized: string;
}) {
    return {
        id: args.stateId,
        providerUsernameNormalized: args.usernameNormalized,
        user: {
            is:
                args.provider === 'LICHESS'
                    ? { lichessUsername: args.username }
                    : { chesscomUsername: args.username },
        },
    };
}

type LockedProviderIdentity = {
    lichessUsername: string | null;
    chesscomUsername: string | null;
};

type LockedSyncJobLease = {
    status: string;
    leaseToken: string | null;
};

async function lockAndAssertProviderIdentity(args: {
    tx: Prisma.TransactionClient;
    userId: string;
    provider: Provider;
    usernameNormalized: string;
}) {
    const rows = await args.tx.$queryRaw<LockedProviderIdentity[]>(
        Prisma.sql`
            SELECT "lichessUsername", "chesscomUsername"
            FROM "User"
            WHERE "id" = CAST(${args.userId} AS uuid)
            FOR UPDATE
        `
    );
    const current = rows[0];
    const username = current ? providerUsername(args.provider, current) : null;
    if (
        !username ||
        normalizeProviderUsername(username) !== args.usernameNormalized
    ) {
        throw new ProviderIdentityChangedError();
    }
}

async function lockAndAssertSyncJobLease(args: {
    tx: Prisma.TransactionClient;
    jobId: string;
    leaseToken: string;
}) {
    const rows = await args.tx.$queryRaw<LockedSyncJobLease[]>(
        Prisma.sql`
            SELECT "status", "leaseToken"
            FROM "SyncJob"
            WHERE "id" = CAST(${args.jobId} AS uuid)
            FOR UPDATE
        `
    );
    const lease = rows[0];
    if (
        lease?.status !== 'RUNNING' ||
        lease.leaseToken !== args.leaseToken
    ) {
        throw new StaleSyncJobLeaseError();
    }
}

async function fetchProviderBatch(args: {
    provider: Provider;
    username: string;
    window: SyncWindow;
    lichessAccessToken?: string | null;
    timeoutMs?: number;
}): Promise<ProviderBatchFetchResult> {
    const common = {
        username: args.username,
        since: args.window.since.toISOString(),
        until: args.window.until.toISOString(),
        firstSyncMaxGames: args.window.firstSync
            ? FIRST_SYNC_MAX_GAMES
            : undefined,
    };
    const controller = new AbortController();
    const timeout = setTimeout(
        () => controller.abort(),
        Math.max(1, args.timeoutMs ?? PROVIDER_SYNC_FETCH_TIMEOUT_MS)
    );
    try {
        return await (args.provider === 'LICHESS'
            ? fetchLichessGamesBatch({
                  ...common,
                  accessToken: args.lichessAccessToken,
                  signal: controller.signal,
              })
            : fetchChessComGamesBatch({
                  ...common,
                  signal: controller.signal,
              }));
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error('Provider sync fetch timed out');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
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
            // Each provider is isolated: one provider's failure is a result,
            // never a reason to stop attempting the other linked provider.
            providers.push(
                await syncUserProvider({
                    user,
                    provider,
                    prefs,
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
    lichessAccessToken?: string | null;
    force?: boolean;
    now?: Date;
    fetchTimeoutMs?: number;
    jobLease?: {
        jobId: string;
        leaseToken: string;
    };
}): Promise<SyncProviderResult> {
    const username = providerUsername(args.provider, args.user)?.trim();
    if (!username) return skippedResult(args.provider, '');

    const now = args.now ?? new Date();
    const usernameNormalized = normalizeProviderUsername(username);
    let state: SyncState | null = null;
    let fetchedCount = 0;
    let savedCount = 0;
    let createdCount = 0;
    let updatedCount = 0;
    let importedGameIds: string[] = [];
    const queuedAnalysis = 0;
    let analysisErrors = 0;
    try {
        state = await prepareSyncState({
            userId: args.user.id,
            provider: args.provider,
            username,
            usernameNormalized,
            now,
        });
        if (
            !args.force &&
            !autoEnabledForProvider(args.prefs, args.provider, state.enabled)
        ) {
            return skippedResult(args.provider, username);
        }

        const preparedState = state;
        const window = syncWindow(preparedState, args.provider, now);
        const fetched = await fetchProviderBatch({
            provider: args.provider,
            username,
            window,
            lichessAccessToken: args.lichessAccessToken,
            timeoutMs: args.fetchTimeoutMs,
        });
        fetchedCount = fetched.games.length;
        if (!fetched.complete && !fetched.nextUntil) {
            throw new Error(
                'Provider returned an incomplete sync batch without a resume cursor'
            );
        }
        const persisted = await prisma.$transaction(
            async (tx) => {
                // Lock the owning profile row for the entire import-and-cursor
                // commit. A concurrent relink either commits first (and this
                // identity check fails) or waits, then resets this provider's
                // cursor after the old account batch has committed.
                await lockAndAssertProviderIdentity({
                    tx,
                    userId: args.user.id,
                    provider: args.provider,
                    usernameNormalized,
                });
                if (args.jobLease) {
                    await lockAndAssertSyncJobLease({
                        tx,
                        jobId: args.jobLease.jobId,
                        leaseToken: args.jobLease.leaseToken,
                    });
                }
                const saved = await saveNormalizedGamesForUser({
                    userId: args.user.id,
                    games: fetched.games,
                    client: tx,
                });

                const saveIncomplete = saved.errors.length > 0;
                const complete = fetched.complete && !saveIncomplete;
                const nextCursor =
                    !saveIncomplete && !fetched.complete && fetched.nextUntil
                        ? new Date(fetched.nextUntil)
                        : window.until;
                const saveError = saveIncomplete
                    ? `Saved ${saved.saved}/${fetched.games.length} games; ${saved.errors.length} failed`
                    : null;

                const advanced = await tx.providerSyncState.updateMany({
                    where: {
                        id: preparedState.id,
                        providerUsernameNormalized: usernameNormalized,
                    },
                    data: {
                        ...(!saveIncomplete ? { lastSuccessAt: now } : {}),
                        lastError: saveError,
                        etag: fetched.etag ?? preparedState.etag,
                        lastModified:
                            fetched.lastModified ??
                            preparedState.lastModified,
                        ...(complete
                            ? {
                                  lastSyncedPlayedAt: window.windowEnd,
                                  cursorSincePlayedAt: null,
                                  cursorUntilPlayedAt: null,
                                  cursorWindowEnd: null,
                              }
                            : {
                                  cursorSincePlayedAt: window.since,
                                  cursorUntilPlayedAt: nextCursor,
                                  cursorWindowEnd: window.windowEnd,
                              }),
                    },
                });
                if (advanced.count !== 1) {
                    throw new ProviderIdentityChangedError();
                }
                return { saved, complete, saveError };
            },
            { maxWait: 10_000, timeout: 60_000 }
        );
        const { saved, complete, saveError } = persisted;
        savedCount = saved.saved;
        createdCount = saved.created;
        updatedCount = saved.updated;
        importedGameIds = saved.newGameDbIds;

        // Analysis is deliberately downstream from the committed import. The
        // durable wakeup never reserves inline, and the periodic sweep can
        // recover an unavailable queue without re-importing games.
        if (saved.errors.length === 0) {
            try {
                await requestAutoAnalysisWakeup(args.user.id, 'import');
            } catch {
                analysisErrors += 1;
            }
        }

        return {
            provider: args.provider,
            username,
            fetched: fetchedCount,
            saved: savedCount,
            created: createdCount,
            updated: updatedCount,
            importedGameIds,
            queuedAnalysis,
            analysisErrors,
            complete,
            skipped: false,
            ...(saveError ? { error: saveError } : {}),
        };
    } catch (error) {
        if (error instanceof StaleSyncJobLeaseError) throw error;
        const message =
            error instanceof Error ? error.message : 'Provider sync failed';
        if (state) {
            try {
                await prisma.providerSyncState.updateMany({
                    where: stateIdentityWhere({
                        stateId: state.id,
                        provider: args.provider,
                        username,
                        usernameNormalized,
                    }),
                    data: { lastError: message.slice(0, 2_000) },
                });
            } catch {
                // The original sync error is more useful than a secondary
                // observability write failure.
            }
        }
        return {
            provider: args.provider,
            username,
            fetched: fetchedCount,
            saved: savedCount,
            created: createdCount,
            updated: updatedCount,
            importedGameIds,
            queuedAnalysis,
            analysisErrors,
            complete: false,
            skipped: false,
            ...(error instanceof ProviderIdentityChangedError
                ? { identityChanged: true }
                : {}),
            error: message,
        };
    }
}

function skippedResult(provider: Provider, username: string): SyncProviderResult {
    return {
        provider,
        username,
        fetched: 0,
        saved: 0,
        created: 0,
        updated: 0,
        importedGameIds: [],
        queuedAnalysis: 0,
        analysisErrors: 0,
        complete: true,
        skipped: true,
    };
}
