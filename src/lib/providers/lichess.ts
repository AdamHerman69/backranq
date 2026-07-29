import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import type { GameFetchFilters } from '@/lib/providers/filters';
import {
    dedupeGames,
    takeRecentWithTimestampBoundary,
    type ProviderBatchFetchResult,
} from '@/lib/providers/pagination';
import {
    normalizeTimeClass,
    passesFilters,
    parsePgnSummary,
    player,
} from '@/lib/providers/normalize';
import {
    readBoundedErrorDetail,
    readBoundedResponseText,
} from '@/lib/providers/boundedResponse';

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
    clock?: {
        initial?: number;
        increment?: number;
    };
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

type LichessPageResult = ProviderFetchResult & {
    rawCount: number;
    sourceIds: string[];
    oldestSeenAt: string | null;
    oldestBoundaryIds: string[];
};

const LICHESS_PAGE_SIZE = 200;
const LICHESS_MAX_GAMES_PER_REQUEST = 500;
const DEFAULT_MAX_PAGES = 12;
const LICHESS_PAGE_MAX_BYTES = 16_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedPlayerIdentity(player: LichessPlayer | undefined) {
    const identity = player?.user?.name ?? player?.userId;
    return typeof identity === 'string'
        ? identity.trim().toLocaleLowerCase('en-US')
        : '';
}

function lichessProvenance(
    game: LichessGameJson,
    requestedUsername: string
): NonNullable<NormalizedGame['provenance']> {
    const expected = requestedUsername
        .trim()
        .toLocaleLowerCase('en-US');
    const whiteMatches =
        normalizedPlayerIdentity(game.players?.white) === expected;
    const blackMatches =
        normalizedPlayerIdentity(game.players?.black) === expected;
    const matchedPlayer =
        whiteMatches && !blackMatches
            ? game.players?.white
            : blackMatches && !whiteMatches
              ? game.players?.black
              : undefined;
    const initial =
        typeof game.clock?.initial === 'number' &&
        Number.isSafeInteger(game.clock.initial) &&
        game.clock.initial >= 0
            ? game.clock.initial
            : undefined;
    const increment =
        typeof game.clock?.increment === 'number' &&
        Number.isSafeInteger(game.clock.increment) &&
        game.clock.increment >= 0
            ? game.clock.increment
            : undefined;

    return {
        username: requestedUsername.trim(),
        accountId: matchedPlayer?.userId,
        userSide:
            whiteMatches && !blackMatches
                ? 'white'
                : blackMatches && !whiteMatches
                  ? 'black'
                  : 'unknown',
        timeControl:
            initial != null || increment != null
                ? {
                      raw:
                          initial != null && increment != null
                              ? `${initial}+${increment}`
                              : undefined,
                      initialSeconds: initial,
                      incrementSeconds: increment,
                  }
                : undefined,
    };
}

function requireLichessGame(
    value: unknown,
    lineNumber: number,
    requestedUsername: string
): LichessGameJson {
    if (!isRecord(value)) {
        throw new Error(
            `Lichess returned an invalid game at NDJSON line ${lineNumber}`
        );
    }
    if (typeof value.id !== 'string' || !value.id.trim()) {
        throw new Error(
            `Lichess game at NDJSON line ${lineNumber} is missing an ID`
        );
    }
    if (typeof value.pgn !== 'string' || !value.pgn.trim()) {
        throw new Error(
            `Lichess game at NDJSON line ${lineNumber} is missing PGN`
        );
    }
    const playedAt =
        typeof value.createdAt === 'number'
            ? value.createdAt
            : value.lastMoveAt;
    if (
        typeof playedAt !== 'number' ||
        !Number.isFinite(playedAt) ||
        playedAt <= 0 ||
        Number.isNaN(new Date(playedAt).getTime())
    ) {
        throw new Error(
            `Lichess game at NDJSON line ${lineNumber} is missing a valid timestamp`
        );
    }
    if (
        !isRecord(value.players) ||
        !isRecord(value.players.white) ||
        !isRecord(value.players.black)
    ) {
        throw new Error(
            `Lichess game at NDJSON line ${lineNumber} is missing player data`
        );
    }
    const game = value as LichessGameJson;
    const expectedIdentity = requestedUsername
        .trim()
        .toLocaleLowerCase('en-US');
    if (
        normalizedPlayerIdentity(game.players?.white) !== expectedIdentity &&
        normalizedPlayerIdentity(game.players?.black) !== expectedIdentity
    ) {
        throw new Error(
            `Lichess game at NDJSON line ${lineNumber} does not contain the requested player identity`
        );
    }
    return game;
}

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

async function fetchLichessGamesPage(args: {
    username: string;
    filters: GameFetchFilters;
    accessToken?: string | null;
    signal?: AbortSignal;
}): Promise<LichessPageResult> {
    const max = Math.max(
        1,
        Math.min(
            Math.trunc(args.filters.max ?? 100),
            LICHESS_MAX_GAMES_PER_REQUEST
        )
    );

    const lichessUrl = new URL(
        `https://lichess.org/api/games/user/${encodeURIComponent(args.username)}`
    );
    lichessUrl.searchParams.set('max', String(max));
    lichessUrl.searchParams.set('pgnInJson', 'true');
    lichessUrl.searchParams.set('clocks', 'true');
    lichessUrl.searchParams.set('opening', 'true');
    lichessUrl.searchParams.set('tags', 'true');
    lichessUrl.searchParams.set('moves', 'true');
    const providerTimeClasses = args.filters.timeClasses?.filter(
        (timeClass) => timeClass !== 'unknown'
    );
    if (providerTimeClasses && providerTimeClasses.length > 0) {
        lichessUrl.searchParams.set(
            'perfType',
            providerTimeClasses.join(',')
        );
    }
    if (args.filters.rated !== undefined) {
        lichessUrl.searchParams.set('rated', String(args.filters.rated));
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

    let res = await fetch(lichessUrl.toString(), {
        headers,
        cache: 'no-store',
        signal: args.signal,
    });
    if (
        args.accessToken &&
        (res.status === 401 || res.status === 403)
    ) {
        await res.body?.cancel().catch(() => undefined);
        res = await fetch(lichessUrl.toString(), {
            headers: { Accept: 'application/x-ndjson' },
            cache: 'no-store',
            signal: args.signal,
        });
    }

    if (!res.ok) {
        const text = await readBoundedErrorDetail(res, 'Lichess error');
        throw new Error(
            JSON.stringify({
                error: `Lichess request failed (${res.status})`,
                detail: text.slice(0, 300),
            })
        );
    }

    const body = await readBoundedResponseText({
        response: res,
        label: 'Lichess games',
        maxBytes: LICHESS_PAGE_MAX_BYTES,
    });
    const lines = body
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const games: NormalizedGame[] = [];
    const sourceIds: string[] = [];
    const sourceRows: Array<{ id: string; playedAt: string }> = [];
    let oldestSeenAt: string | null = null;
    for (const [index, line] of lines.entries()) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(line) as unknown;
        } catch {
            throw new Error(
                `Lichess returned malformed NDJSON at line ${index + 1}`
            );
        }
        const obj = requireLichessGame(parsed, index + 1, args.username);

        const playedAtMs: number | undefined =
            typeof obj?.createdAt === 'number'
                ? obj.createdAt
                : typeof obj?.lastMoveAt === 'number'
                  ? obj.lastMoveAt
                  : undefined;
        if (playedAtMs != null && Number.isFinite(playedAtMs)) {
            const playedAt = new Date(playedAtMs).toISOString();
            if (
                !oldestSeenAt ||
                new Date(playedAt).getTime() <
                    new Date(oldestSeenAt).getTime()
            ) {
                oldestSeenAt = playedAt;
            }
        }

        const id = obj.id as string;
        const pgn = obj.pgn as string;
        sourceIds.push(id);
        sourceRows.push({
            id,
            playedAt: new Date(playedAtMs as number).toISOString(),
        });

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
            provenance: lichessProvenance(obj, args.username),
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
        rawCount: lines.length,
        sourceIds,
        oldestSeenAt,
        oldestBoundaryIds: oldestSeenAt
            ? sourceRows
                  .filter((row) => row.playedAt === oldestSeenAt)
                  .map((row) => row.id)
            : [],
    };
}

export async function fetchLichessGames(args: {
    username: string;
    filters: GameFetchFilters;
    accessToken?: string | null;
    signal?: AbortSignal;
}): Promise<ProviderFetchResult> {
    const page = await fetchLichessGamesPage(args);
    return {
        games: page.games,
        etag: page.etag,
        lastModified: page.lastModified,
    };
}

/**
 * Fetches a bounded, resumable descending interval. The next cursor is kept
 * inclusive so games sharing a boundary timestamp are seen again and deduped
 * instead of being skipped.
 */
export async function fetchLichessGamesBatch(args: {
    username: string;
    since?: string;
    until: string;
    timeClasses?: TimeClass[];
    rated?: boolean;
    accessToken?: string | null;
    maxPages?: number;
    pageSize?: number;
    firstSyncMaxGames?: number;
    resumeBoundaryIds?: string[];
    signal?: AbortSignal;
}): Promise<ProviderBatchFetchResult> {
    const maxPages = Math.max(
        1,
        Math.min(Math.trunc(args.maxPages ?? DEFAULT_MAX_PAGES), 50)
    );
    const pageSize = Math.max(
        1,
        Math.min(
            Math.trunc(args.pageSize ?? LICHESS_PAGE_SIZE),
            LICHESS_MAX_GAMES_PER_REQUEST
        )
    );
    const games: NormalizedGame[] = [];
    const seenSourceIds = new Set(args.resumeBoundaryIds ?? []);
    let currentUntil = args.until;
    let currentBoundaryIds = [...(args.resumeBoundaryIds ?? [])];
    let complete = false;
    let etag: string | null | undefined;
    let lastModified: string | null | undefined;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
        const page = await fetchLichessGamesPage({
            username: args.username,
            accessToken: args.accessToken,
            signal: args.signal,
            filters: {
                since: args.since,
                until: currentUntil,
                timeClasses: args.timeClasses,
                rated: args.rated,
                max: pageSize,
            },
        });
        etag = page.etag;
        lastModified = page.lastModified;

        for (const game of page.games) {
            const sourceId = game.id.startsWith('lichess:')
                ? game.id.slice('lichess:'.length)
                : game.id;
            if (!seenSourceIds.has(sourceId)) games.push(game);
        }

        let newSourceIds = 0;
        for (const id of page.sourceIds) {
            if (seenSourceIds.has(id)) continue;
            seenSourceIds.add(id);
            newSourceIds += 1;
        }
        if (
            args.firstSyncMaxGames &&
            dedupeGames(games).length >= args.firstSyncMaxGames
        ) {
            complete = true;
            break;
        }
        if (
            page.rawCount < pageSize ||
            !page.oldestSeenAt ||
            (args.since &&
                new Date(page.oldestSeenAt).getTime() <
                    new Date(args.since).getTime())
        ) {
            complete = true;
            break;
        }

        const oldestMs = new Date(page.oldestSeenAt).getTime();
        const currentUntilMs = new Date(currentUntil).getTime();
        if (!Number.isFinite(oldestMs) || !Number.isFinite(currentUntilMs)) {
            complete = true;
            break;
        }

        // Never step behind an exhausted timestamp tie: doing so could silently
        // skip IDs that the provider did not expose within the page. Fail the
        // bounded attempt and preserve the durable cursor instead.
        if (newSourceIds === 0) {
            throw new Error(
                'Lichess pagination stalled at an inclusive timestamp boundary'
            );
        }
        const nextUntil = page.oldestSeenAt;
        if (
            !nextUntil ||
            (args.since &&
                new Date(nextUntil).getTime() <
                    new Date(args.since).getTime())
        ) {
            complete = true;
            break;
        }
        currentBoundaryIds =
            nextUntil === currentUntil
                ? Array.from(
                      new Set([
                          ...currentBoundaryIds,
                          ...page.oldestBoundaryIds,
                      ])
                  )
                : page.oldestBoundaryIds;
        currentUntil = nextUntil;
    }

    return {
        games: takeRecentWithTimestampBoundary(
            games,
            args.firstSyncMaxGames
        ),
        complete,
        nextUntil: complete ? null : currentUntil,
        nextBoundaryIds: complete ? undefined : currentBoundaryIds,
        etag,
        lastModified,
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
