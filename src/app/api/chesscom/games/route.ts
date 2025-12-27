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

type ChessComArchivesResponse = {
    archives?: string[];
};

type ChessComSide = {
    username?: string;
    rating?: number;
};

type ChessComGame = {
    pgn?: string;
    end_time?: number;
    url?: string;
    uuid?: string;
    time_class?: string;
    rated?: boolean;
    white?: ChessComSide;
    black?: ChessComSide;
};

type ChessComArchiveGamesResponse = {
    games?: ChessComGame[];
};

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

function monthKey(d: Date) {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + 1;
    return `${y}-${String(m).padStart(2, '0')}`;
}

function betweenMonthsInclusive(
    sinceIso?: string,
    untilIso?: string
): Set<string> | undefined {
    if (!sinceIso && !untilIso) return undefined;
    const since = new Date(sinceIso ?? '1970-01-01T00:00:00.000Z');
    const until = new Date(untilIso ?? new Date().toISOString());
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()))
        return undefined;

    const keys = new Set<string>();
    const cur = new Date(
        Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)
    );
    const end = new Date(
        Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1)
    );
    while (cur.getTime() <= end.getTime()) {
        keys.add(monthKey(cur));
        cur.setUTCMonth(cur.getUTCMonth() + 1);
    }
    return keys;
}

export async function GET(req: Request) {
    const url = new URL(req.url);
    const username = url.searchParams.get('username')?.trim().toLowerCase();
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

    const months = betweenMonthsInclusive(since, until);

    const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(
        username
    )}/games/archives`;
    const archivesRes = await fetch(archivesUrl, { cache: 'no-store' });
    if (!archivesRes.ok) {
        const text = await archivesRes.text().catch(() => '');
        return NextResponse.json(
            {
                error: `Chess.com archives request failed (${archivesRes.status})`,
                detail: text.slice(0, 300),
            },
            { status: 502 }
        );
    }

    const archivesJson = (await archivesRes
        .json()
        .catch(() => ({}))) as unknown as ChessComArchivesResponse;
    const archives: string[] = Array.isArray(archivesJson?.archives)
        ? archivesJson.archives
        : [];
    if (archives.length === 0) return NextResponse.json({ games: [] });

    const selectedArchives = months
        ? archives.filter((a) => {
              // archive URLs end with /YYYY/MM
              const parts = a.split('/').filter(Boolean);
              const yy = parts[parts.length - 2];
              const mm = parts[parts.length - 1];
              if (!yy || !mm) return false;
              return months.has(`${yy}-${mm.padStart(2, '0')}`);
          })
        : archives;

    // Fetch newest months first
    selectedArchives.sort().reverse();

    const games: NormalizedGame[] = [];
    for (const archive of selectedArchives) {
        if (games.length >= max) break;
        const res = await fetch(archive, { cache: 'no-store' });
        if (!res.ok) continue;
        const json = (await res
            .json()
            .catch(() => ({}))) as unknown as ChessComArchiveGamesResponse;
        const list: ChessComGame[] = Array.isArray(json?.games)
            ? json.games
            : [];

        for (const g of list) {
            if (games.length >= max) break;
            const pgn: string | undefined = g?.pgn;
            if (!pgn) continue;

            const playedAtSeconds: number | undefined =
                typeof g?.end_time === 'number' ? g.end_time : undefined;
            const playedAt = new Date(
                (playedAtSeconds ?? 0) * 1000 || Date.now()
            ).toISOString();

            const summary = parsePgnSummary(pgn);
            const ng: NormalizedGame = {
                id: `chesscom:${
                    g?.uuid ?? `${g?.url ?? ''}:${playedAtSeconds ?? ''}`
                }`,
                provider: 'chesscom',
                url: g?.url,
                playedAt,
                timeClass: normalizeTimeClass(g?.time_class),
                rated: typeof g?.rated === 'boolean' ? g.rated : undefined,
                white: player(g?.white?.username ?? 'White', g?.white?.rating),
                black: player(g?.black?.username ?? 'Black', g?.black?.rating),
                result: summary.result,
                termination: summary.termination,
                pgn,
            };

            if (
                !passesFilters(ng, {
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
            games.push(ng);
        }
    }

    games.sort(
        (a, b) =>
            new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime()
    );
    return NextResponse.json({ games });
}
