import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET(req: Request) {
    const session = await auth();
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(req.url);
    const provider = url.searchParams.get('provider');
    const username = (url.searchParams.get('username') ?? '').trim();

    if (provider !== 'lichess' && provider !== 'chesscom') {
        return NextResponse.json(
            { error: 'Invalid provider' },
            { status: 400 }
        );
    }
    if (!username) {
        return NextResponse.json({ ok: true, exists: true });
    }

    try {
        const endpoint =
            provider === 'lichess'
                ? `https://lichess.org/api/user/${encodeURIComponent(username)}`
                : `https://api.chess.com/pub/player/${encodeURIComponent(
                      username.toLowerCase()
                  )}`;

        const res = await fetch(endpoint, { cache: 'no-store' });
        return NextResponse.json({ ok: true, exists: res.ok });
    } catch (e) {
        return NextResponse.json(
            {
                ok: false,
                error: e instanceof Error ? e.message : 'Unknown error',
            },
            { status: 502 }
        );
    }
}

