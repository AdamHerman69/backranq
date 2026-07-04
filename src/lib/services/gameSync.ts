import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import { parseExternalId } from '@/lib/api/games';

export type SyncProvider = 'lichess' | 'chesscom';

export type SyncFilters = {
    timeClasses: TimeClass[]; // empty array = any
    rated: 'any' | 'rated' | 'casual';
    since?: string; // ISO
    until?: string; // ISO
    max: number;
};

export type SyncStatus = {
    linked: {
        lichessUsername: string | null;
        chesscomUsername: string | null;
    };
    lastSync: {
        lichess: string | null; // ISO
        chesscom: string | null; // ISO
    };
};

type SaveGamesResult = {
    saved: number;
    skipped: number;
    ids: Record<string, string>;
    errors?: Array<{ index: number; id?: string; kind?: string; error: string }>;
    error?: string;
};

const GAME_BULK_CHUNK_SIZE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessageFromJson(json: unknown, fallback: string) {
    return isRecord(json) && typeof json.error === 'string'
        ? json.error
        : fallback;
}

function chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

export async function getSyncStatus(): Promise<SyncStatus> {
    const res = await fetch('/api/sync/status', { cache: 'no-store' });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok)
        throw new Error(errorMessageFromJson(json, 'Failed to load sync status'));
    return json as SyncStatus;
}

function buildProviderQuery(filters: SyncFilters, username: string) {
    const p = new URLSearchParams();
    p.set('username', username);
    if (filters.timeClasses.length > 0) {
        p.set('timeClass', filters.timeClasses.join(','));
    }
    if (filters.rated === 'rated') p.set('rated', 'true');
    if (filters.rated === 'casual') p.set('rated', 'false');
    if (filters.since) p.set('since', filters.since);
    if (filters.until) p.set('until', filters.until);
    p.set('max', String(filters.max));
    return p.toString();
}

export async function fetchGamesFromProvider(args: {
    provider: SyncProvider;
    username: string;
    filters: SyncFilters;
}): Promise<NormalizedGame[]> {
    const qs = buildProviderQuery(args.filters, args.username);
    const res = await fetch(`/api/${args.provider}/games?${qs}`, {
        cache: 'no-store',
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok)
        throw new Error(
            errorMessageFromJson(
                json,
                `Failed to fetch ${args.provider} games`
            )
        );
    const games = isRecord(json) ? json.games : undefined;
    return Array.isArray(games) ? (games as NormalizedGame[]) : [];
}

export async function getExistingExternalIds(args: {
    provider: SyncProvider;
    externalIds: string[];
}) {
    const out = new Set<string>();
    for (const externalIds of chunkArray(args.externalIds, GAME_BULK_CHUNK_SIZE)) {
        const res = await fetch('/api/games/existing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider: args.provider, externalIds }),
        });
        const json = (await res.json().catch(() => ({}))) as unknown;
        if (!res.ok)
            throw new Error(
                errorMessageFromJson(json, 'Failed to check existing games')
            );
        const existingExternalIds = isRecord(json)
            ? json.existingExternalIds
            : undefined;
        const list = Array.isArray(existingExternalIds)
            ? existingExternalIds.filter((id): id is string => typeof id === 'string')
            : [];
        for (const id of list) out.add(id);
    }
    return out;
}

export async function saveGamesToLibrary(args: { games: NormalizedGame[] }) {
    const aggregate: SaveGamesResult = { saved: 0, skipped: 0, ids: {}, errors: [] };
    for (let start = 0; start < args.games.length; start += GAME_BULK_CHUNK_SIZE) {
        const games = args.games.slice(start, start + GAME_BULK_CHUNK_SIZE);
        const res = await saveGamesChunk(games);
        aggregate.saved += res.saved;
        aggregate.skipped += res.skipped;
        aggregate.error ??= res.error;
        Object.assign(aggregate.ids, res.ids);
        if (res.errors?.length) {
            aggregate.errors?.push(
                ...res.errors.map((error) => ({
                    ...error,
                    index: error.index + start,
                }))
            );
        }
    }

    if (aggregate.saved === 0 && aggregate.skipped > 0) {
        throw new Error(
            aggregate.error ??
                aggregate.errors?.[0]?.error ??
                'Failed to save games'
        );
    }

    return aggregate;
}

async function saveGamesChunk(games: NormalizedGame[]): Promise<SaveGamesResult> {
    const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ games }),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok && isSaveGamesResult(json)) {
        return json;
    }
    if (!res.ok) {
        throw new Error(errorMessageFromJson(json, 'Failed to save games'));
    }
    return json as SaveGamesResult;
}

function isSaveGamesResult(value: unknown): value is SaveGamesResult {
    return (
        isRecord(value) &&
        typeof value.saved === 'number' &&
        typeof value.skipped === 'number' &&
        isRecord(value.ids) &&
        (value.errors == null || Array.isArray(value.errors))
    );
}

export function splitNewVsExisting(
    provider: SyncProvider,
    games: NormalizedGame[],
    existingExternalIds: Set<string>
) {
    const newGames: NormalizedGame[] = [];
    const existingGames: NormalizedGame[] = [];
    for (const g of games) {
        if (g.provider !== provider) continue;
        const ext = parseExternalId(g);
        if (existingExternalIds.has(ext)) existingGames.push(g);
        else newGames.push(g);
    }
    return { newGames, existingGames };
}
