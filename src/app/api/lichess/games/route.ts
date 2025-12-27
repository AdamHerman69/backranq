import { NextResponse } from 'next/server';
import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import {
    clampInt,
    parseBooleanParam,
    parseIsoDateOrDateTime,
    parseNumberParam,
} from '@/lib/providers/filters';
import {
    normalizeTimeClass,
    passesFilters,
    parsePgnSummary,
    player,
} from '@/lib/providers/normalize';

export const runtime = 'nodejs';

type LichessUserRef = { name?: string };
type LichessPlayer = {
    user?: LichessUserRef;
    userId?: string;
    rating?: number;
};
type LichessGameJson = {
    id?: string;
    pgn?: string;
    createdAt?: number;
    lastMoveAt?: number;
    speed?: string;
    rated?: boolean;
    players?: {
        white?: LichessPlayer;
        black?: LichessPlayer;
    };
};

function toMs(iso: string | undefined): number | undefined {
    if (!iso) return undefined;
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return undefined;
    return ms;
}

function parseTimeClasses(v: string | null): TimeClass[] | undefined {
    if (!v) return undefined;
    const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
    const classes: TimeClass[] = [];
    for (const p of parts) {
        const tc = normalizeTimeClass(p);
        if (tc !== 'unknown') classes.push(tc);
    }
    return classes.length > 0 ? classes : undefined;
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const username = url.searchParams.get('username')?.trim();
    if (!username) {
        return NextResponse.json(
            { error: 'Missing username' },
            { status: 400 }
        );
    }

    const since = parseIsoDateOrDateTime(url.searchParams.get('since'));
    const until = parseIsoDateOrDateTime(url.searchParams.get('until'));
    const timeClasses = parseTimeClasses(url.searchParams.get('timeClass'));
    const rated = parseBooleanParam(url.searchParams.get('rated'));
    const minElo = parseNumberParam(url.searchParams.get('minElo'));
    const maxElo = parseNumberParam(url.searchParams.get('maxElo'));
    const max = clampInt(
        parseNumberParam(url.searchParams.get('max')) ?? 100,
        1,
        500
    );

    const lichessUrl = new URL(
        `https://lichess.org/api/games/user/${encodeURIComponent(username)}`
    );
    lichessUrl.searchParams.set('max', String(max));
    lichessUrl.searchParams.set('pgnInJson', 'true');
    lichessUrl.searchParams.set('clocks', 'true');
    lichessUrl.searchParams.set('opening', 'true');
    lichessUrl.searchParams.set('tags', 'true');
    lichessUrl.searchParams.set('moves', 'true');
    // perfType filters at source if provided (bullet/blitz/rapid/classical)
    // Lichess only supports single perfType, so if multiple, we fetch all and filter client-side
    if (timeClasses && timeClasses.length === 1) {
        lichessUrl.searchParams.set('perfType', timeClasses[0]);
    }
    const sinceMs = toMs(since);
    const untilMs = toMs(until);
    if (sinceMs != null) lichessUrl.searchParams.set('since', String(sinceMs));
    if (untilMs != null) lichessUrl.searchParams.set('until', String(untilMs));

    const res = await fetch(lichessUrl.toString(), {
        headers: {
            Accept: 'application/x-ndjson',
        },
        cache: 'no-store',
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        return NextResponse.json(
            {
                error: `Lichess request failed (${res.status})`,
                detail: text.slice(0, 300),
            },
            { status: 502 }
        );
    }

    const body = await res.text();
    const lines = body
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const games: NormalizedGame[] = [];
    for (const line of lines) {
        let obj: LichessGameJson | null = null;
        try {
            obj = JSON.parse(line) as unknown as LichessGameJson;
        } catch {
            continue;
        }

        const id = obj?.id;
        const pgn = obj?.pgn;
        if (!id || !pgn) continue;

        const playedAtMs: number | undefined =
            typeof obj?.createdAt === 'number'
                ? obj.createdAt
                : typeof obj?.lastMoveAt === 'number'
                ? obj.lastMoveAt
                : undefined;

        const whiteName =
            obj?.players?.white?.user?.name ??
            obj?.players?.white?.userId ??
            'White';
        const blackName =
            obj?.players?.black?.user?.name ??
            obj?.players?.black?.userId ??
            'Black';

        const summary = parsePgnSummary(pgn);
        const g: NormalizedGame = {
            id: `lichess:${id}`,
            provider: 'lichess',
            url: `https://lichess.org/${id}`,
            playedAt: new Date(playedAtMs ?? Date.now()).toISOString(),
            timeClass: normalizeTimeClass(obj?.speed),
            rated: typeof obj?.rated === 'boolean' ? obj.rated : undefined,
            white: player(whiteName, obj?.players?.white?.rating),
            black: player(blackName, obj?.players?.black?.rating),
            result: summary.result,
            termination: summary.termination,
            pgn,
        };

        if (
            !passesFilters(g, {
                since,
                until,
                timeClasses,
                rated,
                minElo,
                maxElo,
                max,
            })
        )
            continue;
        games.push(g);
    }

    // newest first
    games.sort(
        (a, b) =>
            new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime()
    );
    return NextResponse.json({ games });
}
