export type Score =
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };

export type EngineWdl = {
    win: number;
    draw: number;
    loss: number;
};

export type EngineIdentity = {
    name: string;
    author?: string;
    version?: string;
    flavor?: string;
    evalFile?: string;
    source: string;
    options: Record<string, string | number | boolean>;
};

export type AnalysisLimit = {
    /** Preferred deterministic work limit. */
    nodes?: number;
    /** Optional deterministic depth limit. Used when nodes is not supplied. */
    depth?: number;
    /** Wall-time work limit when no deterministic node/depth budget is supplied. */
    movetimeMs?: number;
    /** Wall-clock safety watchdog; it is not an analysis-quality target. */
    timeoutMs?: number;
    signal?: AbortSignal;
};

export type MultiPvStreamingUpdate = {
    fen: string;
    depth?: number;
    selDepth?: number;
    nodes?: number;
    nps?: number;
    timeMs?: number;
    lines: Array<{
        multipv: number;
        score: Score | null;
        wdl?: EngineWdl;
        pvUci: string[];
        depth?: number;
        selDepth?: number;
        nodes?: number;
        nps?: number;
        timeMs?: number;
    }>;
};

export interface StreamingAnalysisHandle {
    stop(): void;
}

export type EvalResult = {
    fen: string;
    bestMoveUci: string;
    pvUci: string[];
    score: Score | null;
    wdl?: EngineWdl;
    depth?: number;
    selDepth?: number;
    nodes?: number;
    nps?: number;
    timeMs?: number;
};

export type MultiPvLine = {
    multipv: number;
    pvUci: string[];
    score: Score | null;
    wdl?: EngineWdl;
    depth?: number;
    selDepth?: number;
    nodes?: number;
    nps?: number;
    timeMs?: number;
};

export type MultiPvResult = {
    fen: string;
    bestMoveUci: string;
    lines: MultiPvLine[];
    /**
     * True only when the adapter can prove the bundle is structurally complete
     * for the request: every requested slot is present, or fewer slots exhaust
     * the legal root moves. False means partial/malformed; undefined is unknown
     * and must never prove that a short frontier is exhausted.
     */
    alternativesComplete?: boolean;
    identity?: EngineIdentity;
};

const ROOT_UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

/**
 * Structural adapter-level proof only. The continuation verifier separately
 * replays every root move against the FEN and decides whether the evaluation
 * frontier is outside the grading tolerance.
 */
export function isStructurallyCompleteMultiPvBundle(
    lines: readonly MultiPvLine[],
    requestedMultiPv: number
): boolean {
    const requested = Math.max(
        1,
        Math.min(8, Math.trunc(requestedMultiPv))
    );
    if (lines.length !== requested) return false;

    const ordered = lines
        .slice()
        .sort((left, right) => left.multipv - right.multipv);
    const rootMoves = new Set<string>();
    for (let index = 0; index < ordered.length; index += 1) {
        const line = ordered[index]!;
        const rootMove = line.pvUci[0]?.trim().toLowerCase() ?? '';
        if (
            line.multipv !== index + 1 ||
            line.score == null ||
            !ROOT_UCI_RE.test(rootMove) ||
            rootMoves.has(rootMove)
        ) {
            return false;
        }
        rootMoves.add(rootMove);
    }
    return true;
}

export interface StockfishEngine {
    evalPosition(opts: AnalysisLimit & {
        fen: string;
        cacheKey?: string;
    }): Promise<EvalResult>;
    analyzeMultiPv(opts: AnalysisLimit & {
        fen: string;
        multiPv?: number;
        cacheKey?: string;
    }): Promise<MultiPvResult>;
    getIdentity?(): Promise<EngineIdentity>;
    cancelAll?(): void;
    terminate?(): void;
}

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class StockfishClient implements StockfishEngine {
    private worker: Worker | null = null;

    private cacheEval = new Map<string, EvalResult>();
    private cacheMulti = new Map<string, MultiPvResult>();

    private debugLabel = `sf:${Math.random().toString(16).slice(2, 8)}`;

    private pending = new Map<
        string,
        | {
              kind: 'single';
              cacheKey?: string;
              resolve: (v: EvalResult) => void;
              reject: (e: Error) => void;
              latest?: MultiPvStreamingUpdate;
              timeoutId?: number;
              abortCleanup?: () => void;
          }
          | {
              kind: 'multipv';
              requestedMultiPv: number;
              cacheKey?: string;
              resolve: (v: MultiPvResult) => void;
              reject: (e: Error) => void;
              latest?: MultiPvStreamingUpdate;
              timeoutId?: number;
              abortCleanup?: () => void;
          }
    >();

    private streaming = new Map<
        string,
        {
            stopped: boolean;
            onUpdate: (u: MultiPvStreamingUpdate) => void;
            onError?: (e: Error) => void;
            onDone?: () => void;
        }
    >();

    private activeJobId: string | null = null;
    private terminated = false;
    private identityWaiters = new Set<{
        resolve: (identity: EngineIdentity) => void;
        reject: (error: Error) => void;
        timeoutId: number;
    }>();
    private identity: EngineIdentity = {
        name: 'Stockfish 18',
        version: '18.0.8',
        flavor: 'lite-single-nnue-wasm',
        source: 'stockfish@18.0.8/browser/stockfish-18-lite-single',
        options: {
            Threads: 1,
            Hash: 64,
            UCI_ShowWDL: true,
        },
    };

    constructor() {
        if (typeof window === 'undefined') {
            throw new Error('Stockfish can only run in the browser.');
        }
        this.worker = new Worker('/vendor/stockfish/backranq-engine.worker.js');
        this.debugLog('worker created');
        this.worker.onmessage = (ev: MessageEvent) => {
            this.onWorkerMessage(ev.data);
        };
        this.worker.onerror = (ev: ErrorEvent) => {
            const msg = ev?.message || 'Stockfish worker crashed unexpectedly';
            this.debugLog('worker error', msg);
            this.failAll(new Error(msg));
        };
    }

    private debugEnabled(): boolean {
        // Enable by running in DevTools:
        // localStorage.setItem('debugStockfish', '1')
        try {
            return window.localStorage?.getItem('debugStockfish') === '1';
        } catch {
            return false;
        }
    }

    private debugLog(...args: unknown[]) {
        if (!this.debugEnabled()) return;
        console.log(`[StockfishClient ${this.debugLabel}]`, ...args);
    }

    private installTimeout(id: string, ms: number) {
        const p = this.pending.get(id);
        if (!p) return;
        if (p.timeoutId) window.clearTimeout(p.timeoutId);
        const timeoutMs = Math.max(50, Math.trunc(ms));
        p.timeoutId = window.setTimeout(() => {
            const still = this.pending.get(id);
            if (!still) return;
            this.pending.delete(id);
            if (this.activeJobId === id) this.activeJobId = null;
            try {
                this.worker?.postMessage({ type: 'stop', id });
            } catch {
                // ignore
            }
            still.abortCleanup?.();
            const err = new Error(`Engine timeout after ${timeoutMs}ms`);
            this.debugLog('timeout', { id, timeoutMs });
            still.reject(err);
        }, timeoutMs);
    }

    private clearTimeoutFor(id: string) {
        const p = this.pending.get(id);
        if (!p) return;
        if (p.timeoutId) window.clearTimeout(p.timeoutId);
        p.timeoutId = undefined;
        p.abortCleanup?.();
        p.abortCleanup = undefined;
    }

    private installAbort(id: string, signal?: AbortSignal) {
        if (!signal) return;
        const onAbort = () => {
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            if (pending.timeoutId) window.clearTimeout(pending.timeoutId);
            pending.abortCleanup?.();
            if (this.activeJobId === id) this.activeJobId = null;
            this.worker?.postMessage({ type: 'stop', id });
            pending.reject(new Error('Analysis aborted'));
        };
        const pending = this.pending.get(id);
        if (!pending) return;
        pending.abortCleanup = () =>
            signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
    }

    terminate() {
        if (this.terminated) return;
        this.terminated = true;
        this.cancelAll();
        for (const waiter of this.identityWaiters) {
            window.clearTimeout(waiter.timeoutId);
            waiter.reject(new Error('Engine terminated'));
        }
        this.identityWaiters.clear();
        this.worker?.terminate();
        this.worker = null;
        this.cacheEval.clear();
        this.cacheMulti.clear();
    }

    async getIdentity(): Promise<EngineIdentity> {
        if (this.terminated || !this.worker) {
            throw new Error('Engine terminated');
        }
        return new Promise<EngineIdentity>((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                timeoutId: window.setTimeout(() => {
                    this.identityWaiters.delete(waiter);
                    reject(new Error('Engine identity timeout'));
                }, 20_000),
            };
            this.identityWaiters.add(waiter);
            this.worker?.postMessage({ type: 'identity' });
        });
    }

    async evalPosition(opts: AnalysisLimit & {
        fen: string;
        cacheKey?: string;
    }): Promise<EvalResult> {
        if (opts.signal?.aborted) throw new Error('Analysis aborted');
        const nodes =
            opts.nodes == null ? undefined : Math.max(1, Math.trunc(opts.nodes));
        const depth =
            opts.depth == null ? undefined : Math.max(1, Math.trunc(opts.depth));
        const movetimeMs =
            nodes == null && depth == null
                ? Math.max(1, Math.trunc(opts.movetimeMs ?? 200))
                : undefined;
        const key =
            opts.cacheKey ??
            `${opts.fen}::nodes=${nodes ?? ''}::depth=${depth ?? ''}::time=${movetimeMs}`;
        const cached = this.cacheEval.get(key);
        if (cached) return cached;

        const id = uid();
        const p = new Promise<EvalResult>((resolve, reject) => {
            this.pending.set(id, {
                kind: 'single',
                cacheKey: key,
                resolve,
                reject,
            });
            this.activeJobId = id;
            // movetime is best-effort; add buffer for startup/GC/etc.
            this.installTimeout(
                id,
                opts.timeoutMs ??
                    Math.max((movetimeMs ?? 0) + 2000, 10_000)
            );
            this.installAbort(id, opts.signal);
            if (!this.pending.has(id)) return;
            this.debugLog('start eval', { id, nodes, depth, movetimeMs });
            this.worker?.postMessage({
                type: 'start',
                id,
                fen: opts.fen,
                multiPv: 1,
                maxNodes: nodes,
                maxDepth: depth,
                maxTimeMs: movetimeMs,
                emitIntervalMs: 120,
            });
        });
        const res = await p;
        this.cacheEval.set(key, res);
        return res;
    }

    async analyzeMultiPv(opts: AnalysisLimit & {
        fen: string;
        multiPv?: number;
        cacheKey?: string;
    }): Promise<MultiPvResult> {
        if (opts.signal?.aborted) throw new Error('Analysis aborted');
        const nodes =
            opts.nodes == null ? undefined : Math.max(1, Math.trunc(opts.nodes));
        const depth =
            opts.depth == null ? undefined : Math.max(1, Math.trunc(opts.depth));
        const movetimeMs =
            nodes == null && depth == null
                ? Math.max(1, Math.trunc(opts.movetimeMs ?? 400))
                : undefined;
        const multiPv = Math.max(1, Math.min(8, Math.trunc(opts.multiPv ?? 3)));

        const key =
            opts.cacheKey ??
            `${opts.fen}::nodes=${nodes ?? ''}::depth=${depth ?? ''}::time=${movetimeMs}::multipv=${multiPv}`;
        const cached = this.cacheMulti.get(key);
        if (cached) {
            return cached;
        }

        const id = uid();
        const p = new Promise<MultiPvResult>((resolve, reject) => {
            this.pending.set(id, {
                kind: 'multipv',
                requestedMultiPv: multiPv,
                cacheKey: key,
                resolve,
                reject,
            });
            this.activeJobId = id;
            this.installTimeout(
                id,
                opts.timeoutMs ??
                    Math.max((movetimeMs ?? 0) + 2500, 10_000)
            );
            this.installAbort(id, opts.signal);
            if (!this.pending.has(id)) return;
            this.debugLog('start multipv', {
                id,
                nodes,
                depth,
                movetimeMs,
                multiPv,
            });
            this.worker?.postMessage({
                type: 'start',
                id,
                fen: opts.fen,
                multiPv,
                maxNodes: nodes,
                maxDepth: depth,
                maxTimeMs: movetimeMs,
                emitIntervalMs: 120,
            });
        });

        const res = await p;
        this.cacheMulti.set(key, res);
        return res;
    }

    startAnalyzeMultiPvStreaming(opts: {
        fen: string;
        multiPv: number; // 1..8
        minDepth?: number;
        maxDepth?: number;
        maxTimeMs?: number;
        emitIntervalMs?: number;
        onUpdate(u: MultiPvStreamingUpdate): void;
        onError?(e: Error): void;
        onDone?(): void;
    }): StreamingAnalysisHandle {
        const id = uid();
        const multiPv = Math.max(1, Math.min(8, Math.trunc(opts.multiPv)));
        const emitIntervalMs = Math.max(
            50,
            Math.trunc(opts.emitIntervalMs ?? 150)
        );

        // Streaming takes over the worker: kill any queued/pending one-shot jobs to
        // avoid stale updates and confusing cross-calls.
        this.cancelAll();

        this.activeJobId = id;
        this.debugLog('start streaming', {
            id,
            multiPv,
            minDepth: opts.minDepth,
            maxDepth: opts.maxDepth,
            maxTimeMs: opts.maxTimeMs,
            emitIntervalMs,
        });
        this.streaming.set(id, {
            stopped: false,
            onUpdate: opts.onUpdate,
            onError: opts.onError,
            onDone: opts.onDone,
        });

        this.worker?.postMessage({
            type: 'start',
            id,
            fen: opts.fen,
            multiPv,
            minDepth: opts.minDepth,
            maxDepth: opts.maxDepth,
            maxTimeMs: opts.maxTimeMs,
            emitIntervalMs,
        });

        return {
            stop: () => {
                const s = this.streaming.get(id);
                if (s) s.stopped = true;
                this.streaming.delete(id);
                if (this.activeJobId === id) this.activeJobId = null;
                this.debugLog('stop streaming', { id });
                this.worker?.postMessage({ type: 'stop', id });
            },
        };
    }

    cancelAll() {
        if (this.activeJobId) {
            this.debugLog('cancelAll stop active', { id: this.activeJobId });
            this.worker?.postMessage({ type: 'stop', id: this.activeJobId });
        }

        for (const [id, s] of this.streaming.entries()) {
            s.stopped = true;
            this.worker?.postMessage({ type: 'stop', id });
        }
        this.streaming.clear();

        // reject any pending futures
        for (const [id, p] of this.pending.entries()) {
            if (p.timeoutId) window.clearTimeout(p.timeoutId);
            p.abortCleanup?.();
            this.pending.delete(id);
            p.reject(new Error('Cancelled'));
        }
        this.activeJobId = null;
    }

    private failAll(e: Error) {
        for (const [, p] of this.pending) {
            if (p.timeoutId) window.clearTimeout(p.timeoutId);
            p.abortCleanup?.();
            p.reject(e);
        }
        this.pending.clear();
        for (const [, s] of this.streaming) {
            if (!s.stopped) s.onError?.(e);
        }
        this.streaming.clear();
        for (const waiter of this.identityWaiters) {
            window.clearTimeout(waiter.timeoutId);
            waiter.reject(e);
        }
        this.identityWaiters.clear();
        this.activeJobId = null;
    }

    private onWorkerMessage(data: unknown) {
        if (this.terminated) return;
        if (!data || typeof data !== 'object') return;
        const msg = data as Record<string, unknown>;

        if (msg.type === 'update') {
            const id = String(msg.id ?? '');
            const update = msg.update as MultiPvStreamingUpdate | undefined;
            if (!update || typeof update?.fen !== 'string') return;

            const p = this.pending.get(id);
            if (p) p.latest = update;

            const s = this.streaming.get(id);
            if (s && !s.stopped) s.onUpdate(update);
            return;
        }

        if (msg.type === 'done') {
            const id = String(msg.id ?? '');
            const bestMoveUci = String(msg.bestMoveUci ?? '');
            const final = msg.final as MultiPvStreamingUpdate | undefined;

            this.debugLog('done', { id, bestMoveUci });
            this.clearTimeoutFor(id);

            if (final && typeof final.fen === 'string') {
                const s = this.streaming.get(id);
                if (s && !s.stopped) s.onUpdate(final);
                const p = this.pending.get(id);
                if (p) p.latest = final;
            }

            const s = this.streaming.get(id);
            if (s && !s.stopped) s.onDone?.();
            this.streaming.delete(id);

            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                const latest = p.latest ?? final;
                if (!latest) {
                    p.reject(new Error('Engine returned no analysis.'));
                } else if (p.kind === 'single') {
                    const line0 = latest.lines?.[0] ?? null;
                    p.resolve({
                        fen: latest.fen,
                        bestMoveUci,
                        pvUci: line0?.pvUci ?? [],
                        score: line0?.score ?? null,
                        wdl: line0?.wdl,
                        depth: line0?.depth ?? latest.depth,
                        selDepth: line0?.selDepth ?? latest.selDepth,
                        nodes: line0?.nodes ?? latest.nodes,
                        nps: line0?.nps ?? latest.nps,
                        timeMs: line0?.timeMs ?? latest.timeMs,
                    });
                } else {
                    const lines: MultiPvLine[] = (latest.lines ?? []).map(
                        (l) => ({
                            multipv: l.multipv,
                            pvUci: l.pvUci ?? [],
                            score: l.score ?? null,
                            wdl: l.wdl,
                            depth: l.depth ?? latest.depth,
                            selDepth: l.selDepth ?? latest.selDepth,
                            nodes: l.nodes ?? latest.nodes,
                            nps: l.nps ?? latest.nps,
                            timeMs: l.timeMs ?? latest.timeMs,
                        })
                    );
                    p.resolve({
                        fen: latest.fen,
                        bestMoveUci,
                        lines,
                        alternativesComplete:
                            isStructurallyCompleteMultiPvBundle(
                                lines,
                                p.requestedMultiPv
                            ),
                        identity: this.identity,
                    });
                }
            }

            if (this.activeJobId === id) this.activeJobId = null;
            return;
        }

        if (msg.type === 'error') {
            const id = String(msg.id ?? '');
            const message = String(msg.message ?? 'Engine error');
            const err = new Error(message);
            this.debugLog('error', { id, message });
            this.clearTimeoutFor(id);
            const s = this.streaming.get(id);
            if (s && !s.stopped) s.onError?.(err);
            this.streaming.delete(id);
            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                p.reject(err);
            }
            if (this.activeJobId === id) this.activeJobId = null;
            if (!id) {
                for (const waiter of this.identityWaiters) {
                    window.clearTimeout(waiter.timeoutId);
                    waiter.reject(err);
                }
                this.identityWaiters.clear();
            }
            return;
        }

        if (msg.type === 'cancelled') {
            const id = String(msg.id ?? '');
            const message = String(msg.message ?? 'Analysis cancelled');
            const error = new Error(message);
            this.debugLog('cancelled', { id, message });
            this.clearTimeoutFor(id);
            const stream = this.streaming.get(id);
            if (stream && !stream.stopped) stream.onError?.(error);
            this.streaming.delete(id);
            const pending = this.pending.get(id);
            if (pending) {
                this.pending.delete(id);
                pending.reject(error);
            }
            if (this.activeJobId === id) this.activeJobId = null;
            return;
        }

        if (msg.type === 'identity') {
            const candidate = msg.identity;
            if (
                candidate &&
                typeof candidate === 'object' &&
                typeof (candidate as EngineIdentity).name === 'string' &&
                typeof (candidate as EngineIdentity).source === 'string'
            ) {
                this.identity = {
                    ...(candidate as EngineIdentity),
                    options: {
                        ...((candidate as EngineIdentity).options ?? {}),
                    },
                };
                const identity = {
                    ...this.identity,
                    options: { ...this.identity.options },
                };
                for (const waiter of this.identityWaiters) {
                    window.clearTimeout(waiter.timeoutId);
                    waiter.resolve(identity);
                }
                this.identityWaiters.clear();
            }
        }
    }
}
