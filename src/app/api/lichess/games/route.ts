import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { consumeProviderProxyRateLimit } from '@/lib/api/providerProxyRateLimit';
import {
    clampInt,
    parseBooleanParam,
    parseIsoDateOrDateTime,
    parseNumberParam,
} from '@/lib/providers/filters';
import {
    fetchLichessGames,
    parseProviderError,
    parseProviderTimeClasses,
} from '@/lib/providers/lichess';

export const runtime = 'nodejs';

export async function GET(req: Request) {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId)
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = new URL(req.url);
    const username = url.searchParams.get('username')?.trim();
    if (!username) {
        return NextResponse.json(
            { error: 'Missing username' },
            { status: 400 }
        );
    }
    const rateLimit = await consumeProviderProxyRateLimit({
        request: req,
        userId,
        operation: 'games',
    });
    if (!rateLimit.allowed) {
        return NextResponse.json(
            { error: 'Too many provider requests. Try again shortly.' },
            {
                status: 429,
                headers: {
                    'Retry-After': String(rateLimit.retryAfterSeconds),
                },
            }
        );
    }

    try {
        const result = await fetchLichessGames({
            username,
            filters: {
                since: parseIsoDateOrDateTime(url.searchParams.get('since')),
                until: parseIsoDateOrDateTime(url.searchParams.get('until')),
                timeClasses: parseProviderTimeClasses(
                    url.searchParams.get('timeClass')
                ),
                rated: parseBooleanParam(url.searchParams.get('rated')),
                minElo: parseNumberParam(url.searchParams.get('minElo')),
                maxElo: parseNumberParam(url.searchParams.get('maxElo')),
                max: clampInt(
                    parseNumberParam(url.searchParams.get('max')) ?? 100,
                    1,
                    500
                ),
            },
        });
        return NextResponse.json({ games: result.games });
    } catch (e) {
        const error = parseProviderError(e, 'Lichess request failed');
        return NextResponse.json(error, { status: 502 });
    }
}
