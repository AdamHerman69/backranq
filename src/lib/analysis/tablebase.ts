import { Chess } from 'chess.js';

export const TABLEBASE_MAX_PIECES = 7;

export const TABLEBASE_CATEGORIES = [
    'win',
    'unknown',
    'syzygy-win',
    'maybe-win',
    'cursed-win',
    'draw',
    'blessed-loss',
    'maybe-loss',
    'syzygy-loss',
    'loss',
] as const;

export type TablebaseCategory = (typeof TABLEBASE_CATEGORIES)[number];
export type TablebaseWdl = 'WIN' | 'DRAW' | 'LOSS' | 'UNKNOWN';

export type TablebaseMoveEvidence = {
    uci: string;
    san?: string;
    /**
     * Exact/conservative result for the player choosing this move. The
     * upstream move category describes the resulting opponent-to-move
     * position, so it is deliberately inverted here.
     */
    wdl: TablebaseWdl;
    categoryAfterMove: TablebaseCategory;
    dtz?: number;
    preciseDtz?: number;
};

export type TablebaseEvidence = {
    source: 'LICHESS_SYZYGY';
    fen: string;
    pieceCount: number;
    wdl: TablebaseWdl;
    category: TablebaseCategory;
    dtz?: number;
    preciseDtz?: number;
    terminal: {
        checkmate: boolean;
        stalemate: boolean;
        insufficientMaterial: boolean;
    };
    moves: TablebaseMoveEvidence[];
    fetchedAt: string;
};

export interface TablebaseProvider {
    probe(
        fen: string,
        options?: { signal?: AbortSignal }
    ): Promise<TablebaseEvidence | null>;
}

type FetchLike = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

type RawTablebaseMove = {
    uci?: unknown;
    san?: unknown;
    category?: unknown;
    dtz?: unknown;
    precise_dtz?: unknown;
};

type RawTablebaseResponse = {
    category?: unknown;
    dtz?: unknown;
    precise_dtz?: unknown;
    checkmate?: unknown;
    stalemate?: unknown;
    insufficient_material?: unknown;
    moves?: unknown;
};

export type LichessTablebaseClientOptions = {
    endpoint?: string;
    timeoutMs?: number;
    minRequestIntervalMs?: number;
    cacheTtlMs?: number;
    negativeCacheTtlMs?: number;
    maxCacheEntries?: number;
    fetchImpl?: FetchLike;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
};

type CacheEntry = {
    expiresAt: number;
    value: TablebaseEvidence | null;
};

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function category(value: unknown): TablebaseCategory | null {
    return typeof value === 'string' &&
        (TABLEBASE_CATEGORIES as readonly string[]).includes(value)
        ? (value as TablebaseCategory)
        : null;
}

/**
 * The ambiguous Syzygy categories are intentionally not promoted to wins or
 * losses. Cursed wins and blessed losses are draws under the fifty-move rule.
 */
export function conservativeTablebaseWdl(
    value: TablebaseCategory
): TablebaseWdl {
    if (value === 'win' || value === 'syzygy-win') return 'WIN';
    if (value === 'loss' || value === 'syzygy-loss') return 'LOSS';
    if (
        value === 'draw' ||
        value === 'cursed-win' ||
        value === 'blessed-loss'
    ) {
        return 'DRAW';
    }
    return 'UNKNOWN';
}

export function invertTablebaseWdl(value: TablebaseWdl): TablebaseWdl {
    if (value === 'WIN') return 'LOSS';
    if (value === 'LOSS') return 'WIN';
    return value;
}

export function pieceCountFromFen(fen: string): number | null {
    try {
        const chess = new Chess(fen);
        return chess
            .board()
            .flat()
            .filter(Boolean).length;
    } catch {
        return null;
    }
}

function normalizeRawResponse(
    fen: string,
    pieceCount: number,
    raw: RawTablebaseResponse,
    fetchedAt: string
): TablebaseEvidence | null {
    const rootCategory = category(raw.category);
    if (!rootCategory) return null;

    const rawMoves = Array.isArray(raw.moves)
        ? (raw.moves as RawTablebaseMove[])
        : [];
    const moves: TablebaseMoveEvidence[] = [];
    for (const rawMove of rawMoves.slice(0, 256)) {
        const afterCategory = category(rawMove?.category);
        const uci =
            typeof rawMove?.uci === 'string'
                ? rawMove.uci.trim().toLowerCase()
                : '';
        if (!afterCategory || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
            continue;
        }
        const move: TablebaseMoveEvidence = {
            uci,
            wdl: invertTablebaseWdl(
                conservativeTablebaseWdl(afterCategory)
            ),
            categoryAfterMove: afterCategory,
        };
        if (typeof rawMove.san === 'string' && rawMove.san.trim()) {
            move.san = rawMove.san.trim();
        }
        const dtz = finiteNumber(rawMove.dtz);
        const preciseDtz = finiteNumber(rawMove.precise_dtz);
        if (dtz != null) move.dtz = dtz;
        if (preciseDtz != null) move.preciseDtz = preciseDtz;
        moves.push(move);
    }

    const evidence: TablebaseEvidence = {
        source: 'LICHESS_SYZYGY',
        fen,
        pieceCount,
        wdl: conservativeTablebaseWdl(rootCategory),
        category: rootCategory,
        terminal: {
            checkmate: raw.checkmate === true,
            stalemate: raw.stalemate === true,
            insufficientMaterial: raw.insufficient_material === true,
        },
        moves,
        fetchedAt,
    };
    const dtz = finiteNumber(raw.dtz);
    const preciseDtz = finiteNumber(raw.precise_dtz);
    if (dtz != null) evidence.dtz = dtz;
    if (preciseDtz != null) evidence.preciseDtz = preciseDtz;
    return evidence;
}

function abortError(): Error {
    const error = new Error('Tablebase request aborted');
    error.name = 'AbortError';
    return error;
}

/**
 * Conservative read-only client for the public Lichess Syzygy endpoint.
 *
 * - probes only standard positions with <= 7 pieces
 * - serializes/cache-deduplicates requests
 * - treats timeouts, rate limits and uncertain categories as absent/unknown
 * - never manufactures centipawn values from WDL/DTZ
 */
export class LichessTablebaseClient implements TablebaseProvider {
    private readonly endpoint: string;
    private readonly timeoutMs: number;
    private readonly minRequestIntervalMs: number;
    private readonly cacheTtlMs: number;
    private readonly negativeCacheTtlMs: number;
    private readonly maxCacheEntries: number;
    private readonly fetchImpl: FetchLike;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inFlight = new Map<
        string,
        Promise<TablebaseEvidence | null>
    >();
    private requestQueue: Promise<void> = Promise.resolve();
    private lastRequestStartedAt = Number.NEGATIVE_INFINITY;

    constructor(options: LichessTablebaseClientOptions = {}) {
        this.endpoint =
            options.endpoint ?? 'https://tablebase.lichess.ovh/standard';
        this.timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
        this.minRequestIntervalMs = Math.max(
            0,
            options.minRequestIntervalMs ?? 600
        );
        this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 30 * 60_000);
        this.negativeCacheTtlMs = Math.max(
            0,
            options.negativeCacheTtlMs ?? 15_000
        );
        this.maxCacheEntries = Math.max(1, options.maxCacheEntries ?? 2_000);
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.now = options.now ?? Date.now;
        this.sleep =
            options.sleep ??
            ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    async probe(
        fen: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<TablebaseEvidence | null> {
        const normalizedFen = fen.trim();
        const count = pieceCountFromFen(normalizedFen);
        if (count == null || count > TABLEBASE_MAX_PIECES) return null;
        if (options.signal?.aborted) throw abortError();

        const cached = this.cache.get(normalizedFen);
        if (cached && cached.expiresAt > this.now()) {
            // Refresh insertion order for bounded LRU behavior.
            this.cache.delete(normalizedFen);
            this.cache.set(normalizedFen, cached);
            return cached.value;
        }
        if (cached) this.cache.delete(normalizedFen);

        const existing = this.inFlight.get(normalizedFen);
        if (existing) return existing;

        const request = this.enqueue(async () => {
            if (options.signal?.aborted) throw abortError();
            const value = await this.fetchEvidence(
                normalizedFen,
                count,
                options.signal
            );
            this.putCache(normalizedFen, value);
            return value;
        });
        this.inFlight.set(normalizedFen, request);
        try {
            return await request;
        } finally {
            this.inFlight.delete(normalizedFen);
        }
    }

    private enqueue<T>(work: () => Promise<T>): Promise<T> {
        const run = async () => {
            const waitMs = Math.max(
                0,
                this.lastRequestStartedAt +
                    this.minRequestIntervalMs -
                    this.now()
            );
            if (waitMs > 0) await this.sleep(waitMs);
            this.lastRequestStartedAt = this.now();
            return work();
        };
        const result = this.requestQueue.then(run, run);
        this.requestQueue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    private async fetchEvidence(
        fen: string,
        pieceCount: number,
        externalSignal?: AbortSignal
    ): Promise<TablebaseEvidence | null> {
        const controller = new AbortController();
        const onExternalAbort = () => controller.abort();
        externalSignal?.addEventListener('abort', onExternalAbort, {
            once: true,
        });
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetchImpl(
                `${this.endpoint}?fen=${encodeURIComponent(fen)}`,
                {
                    method: 'GET',
                    headers: { accept: 'application/json' },
                    signal: controller.signal,
                }
            );
            if (!response.ok) return null;
            const raw = (await response.json()) as RawTablebaseResponse;
            return normalizeRawResponse(
                fen,
                pieceCount,
                raw,
                new Date(this.now()).toISOString()
            );
        } catch {
            if (externalSignal?.aborted) throw abortError();
            // Network failure and watchdog timeout make this evidence absent,
            // never a guessed engine result.
            return null;
        } finally {
            clearTimeout(timeout);
            externalSignal?.removeEventListener(
                'abort',
                onExternalAbort
            );
        }
    }

    private putCache(fen: string, value: TablebaseEvidence | null) {
        this.cache.delete(fen);
        this.cache.set(fen, {
            value,
            expiresAt:
                this.now() +
                (value ? this.cacheTtlMs : this.negativeCacheTtlMs),
        });
        while (this.cache.size > this.maxCacheEntries) {
            const oldest = this.cache.keys().next().value as
                | string
                | undefined;
            if (!oldest) break;
            this.cache.delete(oldest);
        }
    }
}
