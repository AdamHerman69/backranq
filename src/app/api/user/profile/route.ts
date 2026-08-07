import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import { prisma } from '@/lib/prisma';
import { linkedUsernameSnapshot } from '@/lib/accounts/chessAccountConnections';
import {
    lookupProviderProfile,
    providerProfileLabel,
    type ProfileProvider,
} from '@/lib/providers/profileLookup';

export const runtime = 'nodejs';

function normalizedIdentity(value: string | null | undefined) {
    const trimmed = value?.trim();
    return trimmed ? trimmed.toLocaleLowerCase('en-US') : null;
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
    provider: ProfileProvider,
    username: string
) {
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

    const body = (await req.json().catch(() => ({}))) as {
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
            ? await validateProviderUsername('lichess', v)
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
            ? await validateProviderUsername('chesscom', v)
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

    const user = await prisma.$transaction(async (tx) => {
        for (const identity of updates) {
            const current = await tx.chessAccountConnection.findUnique({
                where: { userId_provider: { userId, provider: identity.provider } },
                select: { usernameNormalized: true },
            });
            if (current?.usernameNormalized === identity.usernameNormalized) {
                continue;
            }
            if (!identity.username || !identity.usernameNormalized) {
                await tx.chessAccountConnection.deleteMany({
                    where: { userId, provider: identity.provider },
                });
            } else {
                await tx.chessAccountConnection.upsert({
                    where: { userId_provider: { userId, provider: identity.provider } },
                    create: {
                        userId,
                        provider: identity.provider,
                        providerAccountId: identity.providerAccountId,
                        username: identity.username,
                        usernameNormalized: identity.usernameNormalized,
                        verification: 'PUBLIC_PROFILE',
                    },
                    update: {
                        providerAccountId: identity.providerAccountId,
                        username: identity.username,
                        usernameNormalized: identity.usernameNormalized,
                        verification: 'PUBLIC_PROFILE',
                        verifiedAt: new Date(),
                    },
                });
            }
            await tx.providerSyncState.upsert({
                where: {
                    userId_provider: {
                        userId,
                        provider: identity.provider,
                    },
                },
                create: {
                    userId,
                    provider: identity.provider,
                        providerUsernameNormalized: identity.usernameNormalized,
                },
                update: {
                    providerUsernameNormalized: identity.usernameNormalized,
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
        const { chessAccountConnections, ...profile } = row;
        return { ...profile, ...linkedUsernameSnapshot(chessAccountConnections) };
    });

    return NextResponse.json({ user });
}
