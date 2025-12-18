export type Score =
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };

export type MultiPvStreamingUpdate = {
    fen: string;
    depth?: number;
    timeMs?: number;
    lines: Array<{
        multipv: number;
        score: Score | null;
        pvUci: string[];
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
    depth?: number;
    timeMs?: number;
};

export type MultiPvLine = {
    multipv: number;
    pvUci: string[];
    score: Score | null;
    depth?: number;
    timeMs?: number;
};

export type MultiPvResult = {
    fen: string;
    bestMoveUci: string;
    lines: MultiPvLine[];
};

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class StockfishClient {
    private worker: Worker | null = null;

    private cacheEval = new Map<string, EvalResult>();
    private cacheMulti = new Map<string, MultiPvResult>();

    private pending = new Map<
        string,
        | {
              kind: 'single';
              cacheKey?: string;
              resolve: (v: EvalResult) => void;
              reject: (e: Error) => void;
              latest?: MultiPvStreamingUpdate;
          }
        | {
              kind: 'multipv';
              cacheKey?: string;
              resolve: (v: MultiPvResult) => void;
              reject: (e: Error) => void;
              latest?: MultiPvStreamingUpdate;
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

    constructor() {
        if (typeof window === 'undefined') {
            throw new Error('Stockfish can only run in the browser.');
        }
        this.worker = new Worker('/vendor/stockfish/backranq-engine.worker.js');
        this.worker.onmessage = (ev: MessageEvent) => {
            this.onWorkerMessage(ev.data);
        };
        this.worker.onerror = (ev: ErrorEvent) => {
            const msg = ev?.message || 'Stockfish worker crashed unexpectedly';
            this.failAll(new Error(msg));
        };
    }

    terminate() {
        if (this.terminated) return;
        this.terminated = true;
        this.cancelAll();
        this.worker?.terminate();
        this.worker = null;
        this.cacheEval.clear();
        this.cacheMulti.clear();
    }

    async evalPosition(opts: {
        fen: string;
        movetimeMs?: number;
        cacheKey?: string;
    }): Promise<EvalResult> {
        const movetimeMs = Math.max(1, Math.trunc(opts.movetimeMs ?? 200));
        const key = opts.cacheKey ?? `${opts.fen}::${movetimeMs}`;
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
            this.worker?.postMessage({
                type: 'start',
                id,
                fen: opts.fen,
                multiPv: 1,
                maxTimeMs: movetimeMs,
                emitIntervalMs: 120,
            });
        });
        const res = await p;
        this.cacheEval.set(key, res);
        return res;
    }

    async analyzeMultiPv(opts: {
        fen: string;
        movetimeMs?: number;
        multiPv?: number;
        cacheKey?: string;
    }): Promise<MultiPvResult> {
        const movetimeMs = Math.max(1, Math.trunc(opts.movetimeMs ?? 400));
        const multiPv = Math.max(1, Math.min(5, Math.trunc(opts.multiPv ?? 3)));

        const key =
            opts.cacheKey ?? `${opts.fen}::${movetimeMs}::multipv=${multiPv}`;
        const cached = this.cacheMulti.get(key);
        if (cached) {
            return cached;
        }

        const id = uid();
        const p = new Promise<MultiPvResult>((resolve, reject) => {
            this.pending.set(id, {
                kind: 'multipv',
                cacheKey: key,
                resolve,
                reject,
            });
            this.activeJobId = id;
            this.worker?.postMessage({
                type: 'start',
                id,
                fen: opts.fen,
                multiPv,
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
        multiPv: number; // 1..5
        minDepth?: number;
        maxDepth?: number;
        maxTimeMs?: number;
        emitIntervalMs?: number;
        onUpdate(u: MultiPvStreamingUpdate): void;
        onError?(e: Error): void;
        onDone?(): void;
    }): StreamingAnalysisHandle {
        const id = uid();
        const multiPv = Math.max(1, Math.min(5, Math.trunc(opts.multiPv)));
        const emitIntervalMs = Math.max(
            50,
            Math.trunc(opts.emitIntervalMs ?? 150)
        );

        // Streaming takes over the worker: kill any queued/pending one-shot jobs to
        // avoid stale updates and confusing cross-calls.
        this.cancelAll();

        this.activeJobId = id;
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
                this.worker?.postMessage({ type: 'stop', id });
            },
        };
    }

    cancelAll() {
        if (this.activeJobId) {
            this.worker?.postMessage({ type: 'stop', id: this.activeJobId });
        }

        for (const [id, s] of this.streaming.entries()) {
            s.stopped = true;
            this.worker?.postMessage({ type: 'stop', id });
        }
        this.streaming.clear();

        // reject any pending futures
        for (const [id, p] of this.pending.entries()) {
            this.pending.delete(id);
            p.reject(new Error('Cancelled'));
        }
        this.activeJobId = null;
    }

    private failAll(e: Error) {
        for (const [, p] of this.pending) {
            p.reject(e);
        }
        this.pending.clear();
        for (const [, s] of this.streaming) {
            if (!s.stopped) s.onError?.(e);
        }
        this.streaming.clear();
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
                        depth: latest.depth,
                        timeMs: latest.timeMs,
                    });
                } else {
                    const lines: MultiPvLine[] = (latest.lines ?? []).map(
                        (l) => ({
                            multipv: l.multipv,
                            pvUci: l.pvUci ?? [],
                            score: l.score ?? null,
                            depth: latest.depth,
                            timeMs: latest.timeMs,
                        })
                    );
                    p.resolve({
                        fen: latest.fen,
                        bestMoveUci,
                        lines,
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
            const s = this.streaming.get(id);
            if (s && !s.stopped) s.onError?.(err);
            this.streaming.delete(id);
            const p = this.pending.get(id);
            if (p) {
                this.pending.delete(id);
                p.reject(err);
            }
            if (this.activeJobId === id) this.activeJobId = null;
        }
    }
}
