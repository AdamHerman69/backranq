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
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

function errorMessageFromJson(json: unknown, fallback: string) {
    return isRecord(json) && typeof json.error === 'string'
        ? json.error
        : fallback;
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
    const res = await fetch('/api/games/existing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
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
    return new Set<string>(list);
}

export async function saveGamesToLibrary(args: { games: NormalizedGame[] }) {
    const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ games: args.games }),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok)
        throw new Error(errorMessageFromJson(json, 'Failed to save games'));
    return json as SaveGamesResult;
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
