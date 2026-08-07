import type { Account, Profile, User } from 'next-auth';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { dispatchUserSyncJobs } from '@/lib/services/syncJobs';

type LichessSignInEvent = {
    user: User;
    account?: Account | null;
    profile?: Profile;
};

type VerifiedLichessIdentity = {
    userId: string;
    providerAccountId: string;
    username: string;
    usernameNormalized: string;
};

type LichessIdentityDependencies = {
    persistConnection: (identity: VerifiedLichessIdentity) => Promise<unknown>;
    startFirstSync: (userId: string) => Promise<unknown>;
};

const dependencies: LichessIdentityDependencies = {
    persistConnection: (identity) =>
        prisma.$transaction(
            async (tx) => {
                const current = await tx.chessAccountConnection.findUnique({
                    where: {
                        userId_provider: {
                            userId: identity.userId,
                            provider: 'LICHESS',
                        },
                    },
                    select: { usernameNormalized: true },
                });
                await tx.chessAccountConnection.upsert({
                    where: {
                        userId_provider: {
                            userId: identity.userId,
                            provider: 'LICHESS',
                        },
                    },
                    create: {
                        userId: identity.userId,
                        provider: 'LICHESS',
                        providerAccountId: identity.providerAccountId,
                        username: identity.username,
                        usernameNormalized: identity.usernameNormalized,
                        verification: 'OAUTH',
                    },
                    update: {
                        providerAccountId: identity.providerAccountId,
                        username: identity.username,
                        usernameNormalized: identity.usernameNormalized,
                        verification: 'OAUTH',
                        verifiedAt: new Date(),
                    },
                });
                await tx.providerSyncState.upsert({
                    where: {
                        userId_provider: {
                            userId: identity.userId,
                            provider: 'LICHESS',
                        },
                    },
                    create: {
                        userId: identity.userId,
                        provider: 'LICHESS',
                        providerUsernameNormalized: identity.usernameNormalized,
                    },
                    update:
                        current?.usernameNormalized ===
                        identity.usernameNormalized
                            ? {
                                  providerUsernameNormalized:
                                      identity.usernameNormalized,
                              }
                            : {
                                  providerUsernameNormalized:
                                      identity.usernameNormalized,
                                  lastSyncedPlayedAt: null,
                                  cursorSincePlayedAt: null,
                                  cursorUntilPlayedAt: null,
                                  cursorWindowEnd: null,
                                  lastAttemptAt: null,
                                  lastSuccessAt: null,
                                  lastError: null,
                                  etag: null,
                                  lastModified: null,
                              },
                });
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
        ),
    startFirstSync: (userId) =>
        dispatchUserSyncJobs({ userId, providers: ['LICHESS'] }),
};

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Persists a durable import connection only when the username came from the
 * same stable Lichess account id that Auth.js just authenticated.
 */
export async function syncVerifiedLichessIdentity(
    event: LichessSignInEvent,
    deps: LichessIdentityDependencies = dependencies
): Promise<boolean> {
    if (event.account?.provider !== 'lichess') return false;
    const userId = nonEmptyString(event.user.id);
    const providerAccountId = nonEmptyString(event.account.providerAccountId);
    const profileId = nonEmptyString(event.profile?.id);
    const username = nonEmptyString(event.profile?.username);
    if (
        !userId ||
        !providerAccountId ||
        !profileId ||
        providerAccountId !== profileId ||
        !username
    ) {
        throw new Error('Verified Lichess sign-in profile is incomplete');
    }

    await deps.persistConnection({
        userId,
        providerAccountId,
        username,
        usernameNormalized: username.toLocaleLowerCase('en-US'),
    });
    await deps.startFirstSync(userId).catch((error) => {
        console.error(
            '[auth] verified Lichess first-sync dispatch failed',
            error instanceof Error ? error.message : 'unknown error'
        );
    });
    return true;
}
