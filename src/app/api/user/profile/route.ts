import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import { prisma } from '@/lib/prisma';
import { linkedUsernameSnapshot } from '@/lib/accounts/chessAccountConnections';
import { boundedJsonBody, isRecord } from '@/lib/api/validation';
import { consumeProviderProxyRateLimit } from '@/lib/api/providerProxyRateLimit';
import {
    lookupProviderProfile,
    providerProfileLabel,
    type ProfileProvider,
} from '@/lib/providers/profileLookup';

export const runtime = 'nodejs';
const MAX_PROFILE_PATCH_BYTES = 4_096;
const PROFILE_PATCH_KEYS = new Set([
    'lichessUsername',
    'chesscomUsername',
]);
const MAX_PROFILE_WRITE_ATTEMPTS = 3;

function normalizedIdentity(value: string | null | undefined) {
    const trimmed = value?.trim();
    return trimmed ? trimmed.toLocaleLowerCase('en-US') : null;
}

function prismaErrorCode(error: unknown): string | null {
    if (!error || typeof error !== 'object' || !('code' in error)) return null;
    return typeof error.code === 'string' ? error.code : null;
}

function ownerConflict() {
    return NextResponse.json(
        {
            code: 'OWNER_MISMATCH',
            error: `The signed-in account no longer matches ${EXPECTED_OWNER_HEADER}. Reload Settings before saving.`,
        },
        { status: 409 }
    );
}

async function validateProviderUsername(
    request: Request,
    userId: string,
    provider: ProfileProvider,
    username: string
) {
    const rateLimit = await consumeProviderProxyRateLimit({
        request,
        userId,
        operation: 'profile',
    });
    if (!rateLimit.allowed) {
        return {
            ok: false as const,
            response: NextResponse.json(
                {
                    error: 'Too many provider lookups. Try again shortly.',
                    retryable: true,
                },
                {
                    status: 429,
                    headers: {
                        'Retry-After': String(rateLimit.retryAfterSeconds),
                    },
                }
            ),
        };
    }
    const lookup = await lookupProviderProfile({ provider, username });
    if (lookup.state === 'found') return { ok: true as const, lookup };
    if (lookup.state === 'not-found') {
        return {
            ok: false as const,
            response: NextResponse.json(
                { error: `${providerProfileLabel(provider)} username not found` },
                { status: 400 }
            ),
        };
    }
    return {
        ok: false as const,
        response: NextResponse.json(
            {
                error: lookup.error,
                retryable: true,
                sourceStatus: lookup.sourceStatus,
            },
            { status: lookup.httpStatus }
        ),
    };
}

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const row = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            image: true,
            chessAccountConnections: {
                select: {
                    provider: true,
                    username: true,
                    usernameNormalized: true,
                },
            },
        },
    });

    if (!row) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { chessAccountConnections, ...user } = row;
    return NextResponse.json({
        user: { ...user, ...linkedUsernameSnapshot(chessAccountConnections) },
    });
}

export async function PATCH(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (expectedOwnerId(req) !== userId) {
        return ownerConflict();
    }

    const parsedBody = await boundedJsonBody(req, MAX_PROFILE_PATCH_BYTES);
    if (!parsedBody.ok) {
        return NextResponse.json(
            { error: parsedBody.error, code: 'INVALID_PROFILE_PATCH' },
            { status: parsedBody.status ?? 400 }
        );
    }
    if (
        !isRecord(parsedBody.value) ||
        Object.keys(parsedBody.value).some(
            (key) => !PROFILE_PATCH_KEYS.has(key)
        )
    ) {
        return NextResponse.json(
            { error: 'Invalid profile patch', code: 'INVALID_PROFILE_PATCH' },
            { status: 400 }
        );
    }
    for (const [key, value] of Object.entries(parsedBody.value)) {
        if (
            value !== null &&
            (typeof value !== 'string' || value.length > 64)
        ) {
            return NextResponse.json(
                {
                    error: `Invalid ${key}`,
                    code: 'INVALID_PROFILE_PATCH',
                },
                { status: 400 }
            );
        }
    }
    const body = parsedBody.value as {
        lichessUsername?: string | null;
        chesscomUsername?: string | null;
    };

    const lichessUsernameRaw = body.lichessUsername;
    const chesscomUsernameRaw = body.chesscomUsername;

    const updates: Array<{
        provider: 'LICHESS' | 'CHESSCOM';
        username: string | null;
        usernameNormalized: string | null;
        providerAccountId: string | null;
    }> = [];

    if (lichessUsernameRaw !== undefined) {
        const v = (lichessUsernameRaw ?? '').trim();
        const validation = v
            ? await validateProviderUsername(req, userId, 'lichess', v)
            : null;
        if (validation && !validation.ok) return validation.response;
        const verified = validation?.lookup ?? null;
        updates.push({
            provider: 'LICHESS',
            username: verified?.username ?? null,
            usernameNormalized: verified
                ? normalizedIdentity(verified.username)
                : null,
            providerAccountId: verified?.accountId ?? null,
        });
    }

    if (chesscomUsernameRaw !== undefined) {
        const v = (chesscomUsernameRaw ?? '').trim().toLowerCase();
        const validation = v
            ? await validateProviderUsername(req, userId, 'chesscom', v)
            : null;
        if (validation && !validation.ok) return validation.response;
        const verified = validation?.lookup ?? null;
        updates.push({
            provider: 'CHESSCOM',
            username: verified?.username ?? null,
            usernameNormalized: verified
                ? normalizedIdentity(verified.username)
                : null,
            providerAccountId: verified?.accountId ?? null,
        });
    }

    try {
        let user: Awaited<ReturnType<typeof persistProfileUpdates>> | null =
            null;
        for (let attempt = 1; attempt <= MAX_PROFILE_WRITE_ATTEMPTS; attempt += 1) {
            try {
                user = await persistProfileUpdates({ userId, updates });
                break;
            } catch (error) {
                if (
                    attempt < MAX_PROFILE_WRITE_ATTEMPTS &&
                    prismaErrorCode(error) === 'P2034'
                ) {
                    continue;
                }
                throw error;
            }
        }
        if (!user) throw new Error('Profile update did not complete');
        return NextResponse.json({ user });
    } catch (error) {
        const errorCode = prismaErrorCode(error);
        if (errorCode === 'P2002' || errorCode === 'P2034') {
            return NextResponse.json(
                {
                    error: 'The linked account changed concurrently. Reload and try again.',
                    code: 'PROFILE_CONFLICT',
                },
                { status: 409 }
            );
        }
        console.error('[profile] durable account update failed');
        return NextResponse.json(
            {
                error: 'The linked account could not be updated.',
                code: 'PROFILE_UPDATE_FAILED',
            },
            { status: 500 }
        );
    }
}

async function persistProfileUpdates(args: {
    userId: string;
    updates: Array<{
        provider: 'LICHESS' | 'CHESSCOM';
        username: string | null;
        usernameNormalized: string | null;
        providerAccountId: string | null;
    }>;
}) {
    return prisma.$transaction(
        async (tx) => {
            for (const identity of args.updates) {
                const current = await tx.chessAccountConnection.findUnique({
                    where: {
                        userId_provider: {
                            userId: args.userId,
                            provider: identity.provider,
                        },
                    },
                    select: {
                        usernameNormalized: true,
                        providerAccountId: true,
                        origin: true,
                    },
                });
                if (
                    current?.usernameNormalized ===
                        identity.usernameNormalized &&
                    current.providerAccountId === identity.providerAccountId &&
                    current.origin === 'PUBLIC_PROFILE'
                ) {
                    continue;
                }
                if (!identity.username || !identity.usernameNormalized) {
                    await tx.chessAccountConnection.deleteMany({
                        where: {
                            userId: args.userId,
                            provider: identity.provider,
                        },
                    });
                } else {
                    await tx.chessAccountConnection.upsert({
                        where: {
                            userId_provider: {
                                userId: args.userId,
                                provider: identity.provider,
                            },
                        },
                        create: {
                            userId: args.userId,
                            provider: identity.provider,
                            providerAccountId: identity.providerAccountId,
                            username: identity.username,
                            usernameNormalized: identity.usernameNormalized,
                            origin: 'PUBLIC_PROFILE',
                        },
                        update: {
                            providerAccountId: identity.providerAccountId,
                            username: identity.username,
                            usernameNormalized: identity.usernameNormalized,
                            origin: 'PUBLIC_PROFILE',
                            verifiedAt: new Date(),
                        },
                    });
                }
                await tx.providerSyncState.upsert({
                    where: {
                        userId_provider: {
                            userId: args.userId,
                            provider: identity.provider,
                        },
                    },
                    create: {
                        userId: args.userId,
                        provider: identity.provider,
                        providerUsernameNormalized:
                            identity.usernameNormalized,
                    },
                    update: {
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
            }
            const row = await tx.user.findUniqueOrThrow({
                where: { id: args.userId },
                select: {
                    id: true,
                    email: true,
                    name: true,
                    image: true,
                    chessAccountConnections: {
                        select: {
                            provider: true,
                            username: true,
                            usernameNormalized: true,
                        },
                    },
                },
            });
            const { chessAccountConnections, ...profile } = row;
            return {
                ...profile,
                ...linkedUsernameSnapshot(chessAccountConnections),
            };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
}
