import type { NormalizedGame } from '@/lib/types/game';
import type { GameFetchFilters } from '@/lib/providers/filters';
import {
    normalizeTimeClass,
    passesFilters,
    parsePgnSummary,
    player,
} from '@/lib/providers/normalize';

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

export type ChessComFetchResult = {
    games: NormalizedGame[];
    etag?: string | null;
    lastModified?: string | null;
    notModified?: boolean;
};

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

function userAgent() {
    return (
        process.env.CHESSCOM_USER_AGENT ??
        'backranq/0.1 (+https://backranq.com; contact: support@backranq.com)'
    );
}

export async function fetchChessComGames(args: {
    username: string;
    filters: GameFetchFilters;
    etag?: string | null;
    lastModified?: string | null;
}): Promise<ChessComFetchResult> {
    const max = Math.max(1, Math.min(Math.trunc(args.filters.max ?? 100), 500));

    const months = betweenMonthsInclusive(args.filters.since, args.filters.until);
    const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(
        args.username.toLowerCase()
    )}/games/archives`;
    const headers: Record<string, string> = {
        'User-Agent': userAgent(),
    };
    if (args.etag) headers['If-None-Match'] = args.etag;
    if (args.lastModified) headers['If-Modified-Since'] = args.lastModified;

    const archivesRes = await fetch(archivesUrl, { cache: 'no-store', headers });
    if (archivesRes.status === 304) {
        return {
            games: [],
            notModified: true,
            etag: archivesRes.headers.get('etag') ?? args.etag,
            lastModified:
                archivesRes.headers.get('last-modified') ?? args.lastModified,
        };
    }
    if (!archivesRes.ok) {
        const text = await archivesRes.text().catch(() => '');
        throw new Error(
            JSON.stringify({
                error: `Chess.com archives request failed (${archivesRes.status})`,
                detail: text.slice(0, 300),
            })
        );
    }

    const archivesJson = (await archivesRes
        .json()
        .catch(() => ({}))) as unknown as ChessComArchivesResponse;
    const archives: string[] = Array.isArray(archivesJson?.archives)
        ? archivesJson.archives
        : [];
    if (archives.length === 0) {
        return {
            games: [],
            etag: archivesRes.headers.get('etag'),
            lastModified: archivesRes.headers.get('last-modified'),
        };
    }

    const selectedArchives = months
        ? archives.filter((a) => {
              const parts = a.split('/').filter(Boolean);
              const yy = parts[parts.length - 2];
              const mm = parts[parts.length - 1];
              if (!yy || !mm) return false;
              return months.has(`${yy}-${mm.padStart(2, '0')}`);
          })
        : archives;

    selectedArchives.sort().reverse();

    const games: NormalizedGame[] = [];
    for (const archive of selectedArchives) {
        if (games.length >= max) break;
        const res = await fetch(archive, {
            cache: 'no-store',
            headers: { 'User-Agent': userAgent() },
        });
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

            if (!passesFilters(ng, { ...args.filters, max })) continue;
            games.push(ng);
        }
    }

    games.sort(
        (a, b) =>
            new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime()
    );
    return {
        games,
        etag: archivesRes.headers.get('etag'),
        lastModified: archivesRes.headers.get('last-modified'),
    };
}
