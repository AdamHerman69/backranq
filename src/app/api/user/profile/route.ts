import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';

type Provider = 'lichess' | 'chesscom';

async function usernameExists(provider: Provider, username: string) {
    const u = username.trim();
    if (!u) return true; // allow clearing

    if (provider === 'lichess') {
        const res = await fetch(
            `https://lichess.org/api/user/${encodeURIComponent(u)}`,
            { cache: 'no-store' }
        );
        return res.ok;
    }

    const res = await fetch(
        `https://api.chess.com/pub/player/${encodeURIComponent(u)}`,
        { cache: 'no-store' }
    );
    return res.ok;
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
        const ok = await usernameExists('lichess', v);
        if (!ok) {
            return NextResponse.json(
                { error: 'Lichess username not found' },
                { status: 400 }
            );
        }
        next.lichessUsername = v ? v : null;
    }

    if (chesscomUsernameRaw !== undefined) {
        const v = (chesscomUsernameRaw ?? '').trim().toLowerCase();
        const ok = await usernameExists('chesscom', v);
        if (!ok) {
            return NextResponse.json(
                { error: 'Chess.com username not found' },
                { status: 400 }
            );
        }
        next.chesscomUsername = v ? v : null;
    }

    const user = await prisma.user.update({
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

    return NextResponse.json({ user });
}

