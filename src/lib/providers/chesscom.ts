import type { NormalizedGame } from '@/lib/types/game';
import type { GameFetchFilters } from '@/lib/providers/filters';
import {
    dedupeGames,
    previousMillisecond,
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
    time_control?: string;
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

type ChessComArchiveIndex = {
    archives: string[];
    etag: string | null;
    lastModified: string | null;
};

const DEFAULT_MAX_ARCHIVES = 6;
const CHESSCOM_ARCHIVE_INDEX_MAX_BYTES = 1_000_000;
const CHESSCOM_ARCHIVE_MAX_BYTES = 16_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonResponse(
    response: Response,
    label: string,
    maxBytes: number
): Promise<Record<string, unknown>> {
    let value: unknown;
    try {
        const text = await readBoundedResponseText({
            response,
            label: `Chess.com ${label}`,
            maxBytes,
        });
        value = JSON.parse(text) as unknown;
    } catch {
        throw new Error(`Chess.com returned malformed JSON for ${label}`);
    }
    if (!isRecord(value)) {
        throw new Error(`Chess.com returned an invalid ${label} response`);
    }
    return value;
}

function requireArchiveUrls(value: unknown, requestedUsername: string): string[] {
    if (!Array.isArray(value)) {
        throw new Error(
            'Chess.com returned an invalid archives response: archives must be an array'
        );
    }
    const expectedUsername = requestedUsername.trim().toLocaleLowerCase('en-US');
    const archives: string[] = [];
    for (const archive of value) {
        if (typeof archive !== 'string' || !archive.trim()) {
            throw new Error(
                'Chess.com returned an invalid archives response: malformed archive URL'
            );
        }
        let parsed: URL;
        try {
            parsed = new URL(archive);
        } catch {
            throw new Error(
                'Chess.com returned an invalid archives response: malformed archive URL'
            );
        }
        const segments = parsed.pathname.split('/');
        const month = archiveMonth(archive);
        let archiveUsername = '';
        try {
            archiveUsername = decodeURIComponent(segments[3] ?? '')
                .trim()
                .toLocaleLowerCase('en-US');
        } catch {
            throw new Error(
                'Chess.com returned an invalid archives response: malformed archive URL'
            );
        }
        if (
            parsed.protocol !== 'https:' ||
            parsed.hostname !== 'api.chess.com' ||
            parsed.port !== '' ||
            parsed.username !== '' ||
            parsed.password !== '' ||
            parsed.search !== '' ||
            parsed.hash !== '' ||
            segments.length !== 7 ||
            segments[0] !== '' ||
            segments[1] !== 'pub' ||
            segments[2] !== 'player' ||
            segments[4] !== 'games' ||
            archiveUsername !== expectedUsername ||
            !month
        ) {
            throw new Error(
                'Chess.com returned an invalid archives response: unsafe archive URL'
            );
        }
        archives.push(
            `https://api.chess.com/pub/player/${encodeURIComponent(
                expectedUsername
            )}/games/${month.year}/${String(month.month).padStart(2, '0')}`
        );
    }
    return archives;
}

function requireArchiveGame(value: unknown, index: number): ChessComGame {
    if (!isRecord(value)) {
        throw new Error(
            `Chess.com returned an invalid game at archive row ${index + 1}`
        );
    }
    if (typeof value.pgn !== 'string' || !value.pgn.trim()) {
        throw new Error(
            `Chess.com game at archive row ${index + 1} is missing PGN`
        );
    }
    if (
        typeof value.end_time !== 'number' ||
        !Number.isFinite(value.end_time) ||
        value.end_time <= 0 ||
        Number.isNaN(new Date(value.end_time * 1_000).getTime())
    ) {
        throw new Error(
            `Chess.com game at archive row ${index + 1} is missing a valid end time`
        );
    }
    if (
        (typeof value.uuid !== 'string' || !value.uuid.trim()) &&
        (typeof value.url !== 'string' || !value.url.trim())
    ) {
        throw new Error(
            `Chess.com game at archive row ${index + 1} is missing a stable ID`
        );
    }
    if (
        !isRecord(value.white) ||
        typeof value.white.username !== 'string' ||
        !value.white.username.trim() ||
        !isRecord(value.black) ||
        typeof value.black.username !== 'string' ||
        !value.black.username.trim()
    ) {
        throw new Error(
            `Chess.com game at archive row ${index + 1} is missing player data`
        );
    }
    return value as ChessComGame;
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

function userAgent() {
    return (
        process.env.CHESSCOM_USER_AGENT ??
        'backranq/0.1 (+https://backranq.com; contact: support@backranq.com)'
    );
}

function archiveMonth(archive: string) {
    const parts = archive.split('/').filter(Boolean);
    const yy = parts[parts.length - 2];
    const mm = parts[parts.length - 1];
    if (!yy || !mm) return null;
    const year = Number(yy);
    const month = Number(mm);
    if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12
    ) {
        return null;
    }
    return { year, month, key: `${yy}-${mm.padStart(2, '0')}` };
}

async function fetchArchiveIndex(
    username: string,
    signal?: AbortSignal
): Promise<ChessComArchiveIndex> {
    const archivesUrl = `https://api.chess.com/pub/player/${encodeURIComponent(
        username.toLowerCase()
    )}/games/archives`;
    // Do not condition this request on the archive-list ETag. Chess.com can add
    // games to an already-listed current-month archive without changing that
    // list, so a 304 here is not proof that there are no new games.
    const archivesRes = await fetch(archivesUrl, {
        cache: 'no-store',
        headers: { 'User-Agent': userAgent() },
        redirect: 'error',
        signal,
    });
    if (!archivesRes.ok) {
        const text = await readBoundedErrorDetail(
            archivesRes,
            'Chess.com archives error'
        );
        throw new Error(
            JSON.stringify({
                error: `Chess.com archives request failed (${archivesRes.status})`,
                detail: text.slice(0, 300),
            })
        );
    }

    const archivesJson = (await readJsonResponse(
        archivesRes,
        'archives',
        CHESSCOM_ARCHIVE_INDEX_MAX_BYTES
    )) as ChessComArchivesResponse;
    return {
        archives: requireArchiveUrls(archivesJson.archives, username),
        etag: archivesRes.headers.get('etag'),
        lastModified: archivesRes.headers.get('last-modified'),
    };
}

function selectArchives(args: {
    archives: string[];
    since?: string;
    until?: string;
}) {
    const months = betweenMonthsInclusive(args.since, args.until);
    return args.archives
        .filter((archive) => {
            const month = archiveMonth(archive);
            return !!month && (!months || months.has(month.key));
        })
        .sort()
        .reverse();
}

function normalizeChessComGame(
    game: ChessComGame,
    filters: GameFetchFilters,
    requestedUsername: string
): NormalizedGame | null {
    const pgn = game?.pgn;
    if (!pgn) return null;

    const playedAtSeconds =
        typeof game?.end_time === 'number' ? game.end_time : undefined;
    const playedAt = new Date(
        (playedAtSeconds ?? 0) * 1000 || Date.now()
    ).toISOString();
    const stableUuid = game.uuid?.trim();
    const stableUrl = game.url?.trim();
    const summary = parsePgnSummary(pgn);
    const expected = requestedUsername
        .trim()
        .toLocaleLowerCase('en-US');
    const whiteMatches =
        game.white?.username?.trim().toLocaleLowerCase('en-US') ===
        expected;
    const blackMatches =
        game.black?.username?.trim().toLocaleLowerCase('en-US') ===
        expected;
    const rawTimeControl = game.time_control?.trim();
    const parsedTimeControl = rawTimeControl?.match(
        /^(\d+)(?:\+(\d+))?$/
    );
    const initialSeconds = parsedTimeControl?.[1]
        ? Number(parsedTimeControl[1])
        : undefined;
    const incrementSeconds = parsedTimeControl?.[2]
        ? Number(parsedTimeControl[2])
        : parsedTimeControl
          ? 0
          : undefined;
    const normalized: NormalizedGame = {
        id: `chesscom:${
            stableUuid || `${stableUrl ?? ''}:${playedAtSeconds ?? ''}`
        }`,
        provider: 'chesscom',
        url: stableUrl,
        playedAt,
        timeClass: normalizeTimeClass(game?.time_class),
        rated: typeof game?.rated === 'boolean' ? game.rated : undefined,
        white: player(game?.white?.username ?? 'White', game?.white?.rating),
        black: player(game?.black?.username ?? 'Black', game?.black?.rating),
        result: summary.result,
        termination: summary.termination,
        pgn,
        provenance: {
            username: requestedUsername.trim(),
            userSide:
                whiteMatches && !blackMatches
                    ? 'white'
                    : blackMatches && !whiteMatches
                      ? 'black'
                      : 'unknown',
            timeControl: rawTimeControl
                ? {
                      raw: rawTimeControl,
                      initialSeconds:
                          initialSeconds != null &&
                          Number.isSafeInteger(initialSeconds)
                              ? initialSeconds
                              : undefined,
                      incrementSeconds:
                          incrementSeconds != null &&
                          Number.isSafeInteger(incrementSeconds)
                              ? incrementSeconds
                              : undefined,
                  }
                : undefined,
        },
    };
    return passesFilters(normalized, filters) ? normalized : null;
}

async function fetchArchiveGames(args: {
    archive: string;
    username: string;
    filters: GameFetchFilters;
    signal?: AbortSignal;
}) {
    const res = await fetch(args.archive, {
        cache: 'no-store',
        headers: { 'User-Agent': userAgent() },
        redirect: 'error',
        signal: args.signal,
    });
    if (!res.ok) {
        const text = await readBoundedErrorDetail(
            res,
            'Chess.com archive error'
        );
        throw new Error(
            JSON.stringify({
                error: `Chess.com archive request failed (${res.status})`,
                detail: text.slice(0, 300),
            })
        );
    }
    const json = (await readJsonResponse(
        res,
        'archive games',
        CHESSCOM_ARCHIVE_MAX_BYTES
    )) as ChessComArchiveGamesResponse;
    if (!Array.isArray(json.games)) {
        throw new Error(
            'Chess.com returned an invalid archive games response: games must be an array'
        );
    }
    const list = json.games.map((game, index) =>
        requireArchiveGame(game, index)
    );
    return list
        .map((game) =>
            normalizeChessComGame(game, args.filters, args.username)
        )
        .filter((game): game is NormalizedGame => !!game);
}

export async function fetchChessComGames(args: {
    username: string;
    filters: GameFetchFilters;
    etag?: string | null;
    lastModified?: string | null;
    signal?: AbortSignal;
}): Promise<ChessComFetchResult> {
    const max = Math.max(1, Math.min(Math.trunc(args.filters.max ?? 100), 500));
    const index = await fetchArchiveIndex(args.username, args.signal);
    const archives = selectArchives({
        archives: index.archives,
        since: args.filters.since,
        until: args.filters.until,
    });
    if (archives.length === 0) {
        return {
            games: [],
            etag: index.etag,
            lastModified: index.lastModified,
        };
    }

    const games: NormalizedGame[] = [];
    for (const archive of archives) {
        if (games.length >= max) break;
        games.push(
            ...(await fetchArchiveGames({
                archive,
                username: args.username,
                filters: { ...args.filters, max: undefined },
                signal: args.signal,
            }))
        );
    }

    return {
        games: dedupeGames(games).slice(0, max),
        etag: index.etag,
        lastModified: index.lastModified,
    };
}

/**
 * Chess.com archives are monthly snapshots rather than cursor pages. Process
 * complete archives, newest first, and resume strictly before the oldest
 * processed month. The archive-list ETag is retained only for diagnostics.
 */
export async function fetchChessComGamesBatch(args: {
    username: string;
    since?: string;
    until: string;
    timeClasses?: NormalizedGame['timeClass'][];
    rated?: boolean;
    maxArchives?: number;
    firstSyncMaxGames?: number;
    signal?: AbortSignal;
}): Promise<ProviderBatchFetchResult> {
    const index = await fetchArchiveIndex(args.username, args.signal);
    const archives = selectArchives({
        archives: index.archives,
        since: args.since,
        until: args.until,
    });
    const maxArchives = Math.max(
        1,
        Math.min(Math.trunc(args.maxArchives ?? DEFAULT_MAX_ARCHIVES), 24)
    );
    const selected = archives.slice(0, maxArchives);
    const games: NormalizedGame[] = [];
    for (const archive of selected) {
        games.push(
            ...(await fetchArchiveGames({
                archive,
                username: args.username,
                filters: {
                    since: args.since,
                    until: args.until,
                    timeClasses: args.timeClasses,
                    rated: args.rated,
                },
                signal: args.signal,
            }))
        );
        if (
            args.firstSyncMaxGames &&
            dedupeGames(games).length >= args.firstSyncMaxGames
        ) {
            break;
        }
    }

    if (args.firstSyncMaxGames) {
        return {
            games: takeRecentWithTimestampBoundary(
                games,
                args.firstSyncMaxGames
            ),
            complete: true,
            nextUntil: null,
            etag: index.etag,
            lastModified: index.lastModified,
        };
    }

    const complete = selected.length >= archives.length;
    const oldestMonth = selected.at(-1)
        ? archiveMonth(selected.at(-1) as string)
        : null;
    const nextUntil =
        !complete && oldestMonth
            ? previousMillisecond(
                  new Date(
                      Date.UTC(oldestMonth.year, oldestMonth.month - 1, 1)
                  ).toISOString()
              )
            : null;

    return {
        games: dedupeGames(games),
        complete,
        nextUntil,
        etag: index.etag,
        lastModified: index.lastModified,
    };
}
