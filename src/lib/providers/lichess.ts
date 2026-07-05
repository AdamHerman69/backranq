import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import type { GameFetchFilters } from '@/lib/providers/filters';
import {
    normalizeTimeClass,
    passesFilters,
    parsePgnSummary,
    player,
} from '@/lib/providers/normalize';

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

export type ProviderFetchResult = {
    games: NormalizedGame[];
    etag?: string | null;
    lastModified?: string | null;
    notModified?: boolean;
};

function toMs(iso: string | undefined): number | undefined {
    if (!iso) return undefined;
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return undefined;
    return ms;
}

export function parseProviderTimeClasses(v: string | null): TimeClass[] | undefined {
    if (!v) return undefined;
    const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const classes: TimeClass[] = [];
    for (const p of parts) {
        const tc = normalizeTimeClass(p);
        if (tc !== 'unknown') classes.push(tc);
    }
    return classes.length > 0 ? classes : undefined;
}

export async function fetchLichessGames(args: {
    username: string;
    filters: GameFetchFilters;
    accessToken?: string | null;
}): Promise<ProviderFetchResult> {
    const max = Math.max(1, Math.min(Math.trunc(args.filters.max ?? 100), 500));

    const lichessUrl = new URL(
        `https://lichess.org/api/games/user/${encodeURIComponent(args.username)}`
    );
    lichessUrl.searchParams.set('max', String(max));
    lichessUrl.searchParams.set('pgnInJson', 'true');
    lichessUrl.searchParams.set('clocks', 'true');
    lichessUrl.searchParams.set('opening', 'true');
    lichessUrl.searchParams.set('tags', 'true');
    lichessUrl.searchParams.set('moves', 'true');
    if (args.filters.timeClasses && args.filters.timeClasses.length === 1) {
        lichessUrl.searchParams.set('perfType', args.filters.timeClasses[0]);
    }
    const sinceMs = toMs(args.filters.since);
    const untilMs = toMs(args.filters.until);
    if (sinceMs != null) lichessUrl.searchParams.set('since', String(sinceMs));
    if (untilMs != null) lichessUrl.searchParams.set('until', String(untilMs));

    const headers: Record<string, string> = {
        Accept: 'application/x-ndjson',
    };
    if (args.accessToken) {
        headers.Authorization = `Bearer ${args.accessToken}`;
    }

    const res = await fetch(lichessUrl.toString(), {
        headers,
        cache: 'no-store',
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(
            JSON.stringify({
                error: `Lichess request failed (${res.status})`,
                detail: text.slice(0, 300),
            })
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

        if (!passesFilters(g, { ...args.filters, max })) continue;
        games.push(g);
    }

    games.sort(
        (a, b) =>
            new Date(b.playedAt).getTime() - new Date(a.playedAt).getTime()
    );
    return {
        games,
        etag: res.headers.get('etag'),
        lastModified: res.headers.get('last-modified'),
    };
}

export function parseProviderError(
    error: unknown,
    fallback: string
): { error: string; detail?: string } {
    const message = error instanceof Error ? error.message : String(error);
    try {
        const parsed = JSON.parse(message) as { error?: unknown; detail?: unknown };
        if (typeof parsed.error === 'string') {
            return {
                error: parsed.error,
                detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
            };
        }
    } catch {
        // plain error
    }
    return { error: fallback, detail: message.slice(0, 300) };
}
