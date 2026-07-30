import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
    EXPECTED_OWNER_HEADER,
    expectedOwnerId,
} from '@/lib/auth/ownerContract';
import { prisma } from '@/lib/prisma';
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
    if (lookup.state === 'found') return null;
    if (lookup.state === 'not-found') {
        return NextResponse.json(
            { error: `${providerProfileLabel(provider)} username not found` },
            { status: 400 }
        );
    }
    return NextResponse.json(
        {
            error: lookup.error,
            retryable: true,
            sourceStatus: lookup.sourceStatus,
        },
        { status: lookup.httpStatus }
    );
}

export async function GET() {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            email: true,
            name: true,
            image: true,
            lichessUsername: true,
            chesscomUsername: true,
        },
    });

    if (!user) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ user });
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

    const next: {
        lichessUsername?: string | null;
        chesscomUsername?: string | null;
    } = {};

    if (lichessUsernameRaw !== undefined) {
        const v = (lichessUsernameRaw ?? '').trim();
        const errorResponse = await validateProviderUsername('lichess', v);
        if (errorResponse) return errorResponse;
        next.lichessUsername = v ? v : null;
    }

    if (chesscomUsernameRaw !== undefined) {
        const v = (chesscomUsernameRaw ?? '').trim().toLowerCase();
        const errorResponse = await validateProviderUsername('chesscom', v);
        if (errorResponse) return errorResponse;
        next.chesscomUsername = v ? v : null;
    }

    const user = await prisma.$transaction(async (tx) => {
        const current = await tx.user.findUnique({
            where: { id: userId },
            select: {
                lichessUsername: true,
                chesscomUsername: true,
            },
        });
        const updated = await tx.user.update({
            where: { id: userId },
            data: next,
            select: {
                id: true,
                email: true,
                name: true,
                image: true,
                lichessUsername: true,
                chesscomUsername: true,
            },
        });

        const changedProviders = [
            ...(lichessUsernameRaw !== undefined &&
            normalizedIdentity(current?.lichessUsername) !==
                normalizedIdentity(updated.lichessUsername)
                ? [
                      {
                          provider: 'LICHESS' as const,
                          username: normalizedIdentity(
                              updated.lichessUsername
                          ),
                      },
                  ]
                : []),
            ...(chesscomUsernameRaw !== undefined &&
            normalizedIdentity(current?.chesscomUsername) !==
                normalizedIdentity(updated.chesscomUsername)
                ? [
                      {
                          provider: 'CHESSCOM' as const,
                          username: normalizedIdentity(
                              updated.chesscomUsername
                          ),
                      },
                  ]
                : []),
        ];
        for (const identity of changedProviders) {
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
                    providerUsernameNormalized: identity.username,
                },
                update: {
                    providerUsernameNormalized: identity.username,
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
        return updated;
    });

    return NextResponse.json({ user });
}
