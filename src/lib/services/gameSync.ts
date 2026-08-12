import type { NormalizedGame, TimeClass } from '@/lib/types/game';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import type { GameAutomationRules } from '@/lib/preferences';

export type SyncProvider = 'lichess' | 'chesscom';

export type HistoricalGameFilters = {
    timeClasses: TimeClass[]; // empty array = any
    rated: 'any' | 'rated' | 'casual';
    since?: string; // ISO
    until?: string; // ISO
};

export type SyncStatus = {
    ownerId: string;
    linked: {
        lichessUsername: string | null;
        chesscomUsername: string | null;
    };
    lastSync: {
        lichess: string | null; // ISO
        chesscom: string | null; // ISO
    };
    gameAutomation?: {
        paused: boolean;
        rules: GameAutomationRules;
        schedule: string;
        states: {
            lichess: SyncProviderState | null;
            chesscom: SyncProviderState | null;
        };
    };
    analysisJobs?: {
        queued: number;
        running: number;
        failed: number;
    };
    billing?: {
        currentBalance: number;
        stopThreshold: number;
        spendableBalance: number;
        monthlyLimit: number;
        monthlyUsed: number;
        outstandingReservations: number;
        monthlyRemaining: number;
        reservableCredits: number;
        analysisQuality: 'STANDARD' | 'THOROUGH';
        creditsPerGame: number;
        reservableGames: number;
        limitingFactor: string | null;
        limitingReason: string | null;
    };
};

export type SyncProviderState = {
    lastSyncedPlayedAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
};

export type SyncJobActivity = {
    id: string;
    status: string;
    scheduledFor: string;
    startedAt: string | null;
    completedAt: string | null;
    fetchedCount: number;
    savedCount: number;
    createdCount: number;
    updatedCount: number;
    queuedAnalysisCount: number;
    lastError: string | null;
};

export type SyncProviderActivity = {
    provider: 'LICHESS' | 'CHESSCOM';
    linked: boolean;
    username: string | null;
    state: {
        providerUsernameNormalized: string | null;
        lastSyncedPlayedAt: string | null;
        lastAttemptAt: string | null;
        lastSuccessAt: string | null;
        lastError: string | null;
        hasPendingCursor: boolean;
    } | null;
    activeJob: SyncJobActivity | null;
    latestJob: SyncJobActivity | null;
};

export type UserSyncActivity = {
    providers: SyncProviderActivity[];
    requestedJobs?: SyncJobActivity[];
};

export type RequestGameSyncResult = {
    requested: SyncProvider[];
    providers: Array<{
        provider: SyncProvider;
        queued: boolean;
        jobId: string | null;
        skippedReason: string | null;
        queuePublished: boolean | null;
        jobStatus: string | null;
    }>;
    active: UserSyncActivity;
};

export type HistoryImportAllowance = {
    limit: number;
    used: number;
    remaining: number;
};

export type HistoryImportTruncatedReason =
    | 'allowance'
    | 'response-size'
    | 'provider-page'
    | null;

export type HistoryImportSnapshot = {
    ownerId: string;
    provider: SyncProvider;
    username: string;
    rows: Array<{ game: NormalizedGame; ticket: string }>;
    allowance: HistoryImportAllowance;
    fetched: number;
    existingCount: number;
    truncatedReason: HistoryImportTruncatedReason;
    providerComplete: boolean;
    nextCursor: string | null;
    page: number;
};

export type HistoricalGameImportItem = {
    game: NormalizedGame;
    ticket: string;
};

export type SaveHistoricalGamesResult = {
    imported: number;
    duplicates: number;
    failed: number;
    capRejected: number;
    ids: Record<string, string>;
    errors: Array<{
        index: number;
        id?: string;
        kind: 'validation' | 'save';
        error: string;
    }>;
    allowances: Partial<Record<SyncProvider, HistoryImportAllowance>>;
};

export function unresolvedHistoryPageGameCount(args: {
    newCount: number;
    selectedCount: number;
    failed: number;
}) {
    return Math.max(
        0,
        Math.trunc(args.newCount) -
            Math.trunc(args.selectedCount) +
            Math.trunc(args.failed)
    );
}

type HistoricalGamesChunkResult = Omit<
    SaveHistoricalGamesResult,
    'allowances'
> & {
    ownerId: string;
    allowance: HistoryImportAllowance;
};

export type EnqueueServerAnalysisJobsResult = {
    executionAvailable?: boolean;
    requested?: number;
    accepted?: number;
    queued: number;
    skipped: number;
    errors?: Array<{ gameId?: string; error: string }>;
    jobs?: Array<{
        id: string;
        gameId: string;
        status: string;
        acceptedInBatch?: boolean;
        queuedReason: string | null;
        executionMode?: string;
        configHash?: string | null;
        durationMs?: number | null;
        credits?: {
            consumedCredits: number | null;
            creditCost: number;
            reservedCredits?: number;
            billable: boolean;
            policy: string;
        };
        run?: {
            id: string;
            status: string | null;
            executionMode: string | null;
            queuedReason: string | null;
            configHash: string | null;
            durationMs: number | null;
            consumedCredits: number | null;
            analysisQuality: 'STANDARD' | 'THOROUGH';
            creditCost: number;
        } | null;
    }>;
};

export type ServerAnalysisJob = {
    id: string;
    gameId: string;
    status: string;
    completedAt?: string | null;
    lastError?: string | null;
};

export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 10_000;

const GAME_BULK_CHUNK_SIZE = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessageFromJson(json: unknown, fallback: string) {
    return isRecord(json) && typeof json.error === 'string'
        ? json.error
        : fallback;
}

export class ClientRequestTimeoutError extends Error {
    constructor(message = 'The server did not respond in time') {
        super(message);
        this.name = 'ClientRequestTimeoutError';
    }
}

export async function fetchWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS
) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abortFromCaller();
    else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        return await fetch(input, { ...init, signal: controller.signal });
    } catch (error) {
        if (timedOut) throw new ClientRequestTimeoutError();
        throw error;
    } finally {
        clearTimeout(timeoutId);
        init.signal?.removeEventListener('abort', abortFromCaller);
    }
}

export async function fetchJsonWithTimeout(
    input: RequestInfo | URL,
    init: RequestInit = {},
    timeoutMs = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS
): Promise<{ response: Response; json: unknown }> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abortFromCaller();
    else init.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    try {
        const response = await fetch(input, {
            ...init,
            signal: controller.signal,
        });
        const text = await response.text();
        let json: unknown = {};
        try {
            json = text ? JSON.parse(text) : {};
        } catch {
            // Callers decide whether an empty/malformed body is acceptable.
        }
        return { response, json };
    } catch (error) {
        if (timedOut) throw new ClientRequestTimeoutError();
        throw error;
    } finally {
        clearTimeout(timeoutId);
        init.signal?.removeEventListener('abort', abortFromCaller);
    }
}

function chunkArray<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }
    return chunks;
}

export async function getSyncStatus(options: {
    signal?: AbortSignal;
    timeoutMs?: number;
} = {}): Promise<SyncStatus> {
    const { response, json } = await fetchJsonWithTimeout(
        '/api/sync/status',
        {
            cache: 'no-store',
            signal: options.signal,
        },
        options.timeoutMs
    );
    if (!response.ok)
        throw new Error(errorMessageFromJson(json, 'Failed to load sync status'));
    return json as SyncStatus;
}

export async function getGameSyncActivity(
    jobIds: string[] = []
): Promise<UserSyncActivity> {
    const uniqueJobIds = [...new Set(jobIds.filter(Boolean))];
    const query =
        uniqueJobIds.length > 0
            ? `?${new URLSearchParams({
                  jobIds: uniqueJobIds.join(','),
              }).toString()}`
            : '';
    const res = await fetch(`/api/sync${query}`, { cache: 'no-store' });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
        throw new Error(
            errorMessageFromJson(json, 'Failed to load sync activity')
        );
    }
    return json as UserSyncActivity;
}

export async function requestGameSync(args: {
    providers?: SyncProvider[];
    onlyIfStaleMinutes?: number;
} = {}): Promise<RequestGameSyncResult> {
    const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
        throw new Error(errorMessageFromJson(json, 'Failed to start sync'));
    }
    return json as RequestGameSyncResult;
}

export async function fetchHistoricalGames(args: {
    ownerId: string;
    provider: SyncProvider;
    filters: HistoricalGameFilters;
    cursor?: string;
    signal?: AbortSignal;
}): Promise<HistoryImportSnapshot> {
    const params = new URLSearchParams({ provider: args.provider });
    if (args.filters.timeClasses.length > 0) {
        params.set('timeClass', args.filters.timeClasses.join(','));
    }
    if (args.filters.rated !== 'any') {
        params.set('rated', args.filters.rated);
    }
    if (args.filters.since) params.set('since', args.filters.since);
    if (args.filters.until) params.set('until', args.filters.until);
    if (args.cursor) params.set('cursor', args.cursor);
    const res = await fetch(`/api/sync/history?${params.toString()}`, {
        cache: 'no-store',
        headers: {
            [EXPECTED_OWNER_HEADER]: args.ownerId,
        },
        signal: args.signal,
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
        throw new Error(
            errorMessageFromJson(json, 'Failed to fetch older games')
        );
    }
    if (
        !isRecord(json) ||
        json.ownerId !== args.ownerId ||
        json.provider !== args.provider ||
        !Array.isArray(json.rows) ||
        !isRecord(json.allowance) ||
        typeof json.providerComplete !== 'boolean' ||
        (json.nextCursor !== null &&
            typeof json.nextCursor !== 'string') ||
        typeof json.page !== 'number' ||
        !Number.isSafeInteger(json.page) ||
        json.page < 1 ||
        (json.truncatedReason !== null &&
            json.truncatedReason !== 'allowance' &&
            json.truncatedReason !== 'response-size' &&
            json.truncatedReason !== 'provider-page')
    ) {
        throw new Error('Invalid older-games response');
    }
    return json as HistoryImportSnapshot;
}

async function saveHistoricalGamesChunk(args: {
    ownerId: string;
    provider: SyncProvider;
    items: HistoricalGameImportItem[];
}) {
    const res = await fetch('/api/sync/history', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            [EXPECTED_OWNER_HEADER]: args.ownerId,
        },
        body: JSON.stringify({
            provider: args.provider,
            items: args.items,
        }),
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok && !isHistoricalGamesResult(json)) {
        throw new Error(
            errorMessageFromJson(json, 'Failed to import older games')
        );
    }
    if (!isHistoricalGamesResult(json)) {
        throw new Error('Invalid older-games import response');
    }
    return json;
}

function isHistoricalGamesResult(
    value: unknown
): value is HistoricalGamesChunkResult {
    return (
        isRecord(value) &&
        typeof value.ownerId === 'string' &&
        typeof value.imported === 'number' &&
        typeof value.duplicates === 'number' &&
        typeof value.failed === 'number' &&
        typeof value.capRejected === 'number' &&
        isRecord(value.ids) &&
        Array.isArray(value.errors) &&
        isRecord(value.allowance)
    );
}

export async function saveHistoricalGamesToLibrary(args: {
    ownerId: string;
    items: HistoricalGameImportItem[];
}): Promise<SaveHistoricalGamesResult> {
    const aggregate: SaveHistoricalGamesResult = {
        imported: 0,
        duplicates: 0,
        failed: 0,
        capRejected: 0,
        ids: {},
        errors: [],
        allowances: {},
    };
    let offset = 0;
    for (const provider of ['lichess', 'chesscom'] as const) {
        const providerItems = args.items.filter(
            (item) => item.game.provider === provider
        );
        for (const items of chunkArray(providerItems, GAME_BULK_CHUNK_SIZE)) {
            const result = await saveHistoricalGamesChunk({
                ownerId: args.ownerId,
                provider,
                items,
            });
            if (result.ownerId !== args.ownerId) {
                throw new Error(
                    'The server returned an import for a different account'
                );
            }
            aggregate.imported += result.imported;
            aggregate.duplicates += result.duplicates;
            aggregate.failed += result.failed;
            aggregate.capRejected += result.capRejected;
            aggregate.allowances[provider] = result.allowance;
            Object.assign(aggregate.ids, result.ids);
            aggregate.errors.push(
                ...result.errors.map((error) => ({
                    ...error,
                    index: error.index + offset,
                }))
            );
            offset += items.length;
        }
    }
    return aggregate;
}

export async function fetchServerAnalysisJobs(
    jobIds?: string[]
): Promise<ServerAnalysisJob[]> {
    const params = new URLSearchParams();
    params.set('limit', '100');
    if (jobIds && jobIds.length > 0) {
        params.set('ids', Array.from(new Set(jobIds)).slice(0, 100).join(','));
    }
    const res = await fetch(`/api/analysis/jobs?${params.toString()}`, {
        cache: 'no-store',
    });
    const json = (await res.json().catch(() => ({}))) as unknown;
    if (!res.ok) {
        throw new Error(
            errorMessageFromJson(json, 'Failed to load analysis jobs')
        );
    }
    const jobs = isRecord(json) ? json.jobs : null;
    return Array.isArray(jobs)
        ? jobs.filter(
              (job): job is ServerAnalysisJob =>
                  isRecord(job) &&
                  typeof job.id === 'string' &&
                  typeof job.gameId === 'string' &&
                  typeof job.status === 'string'
          )
        : [];
}
