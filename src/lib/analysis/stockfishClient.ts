export type Score =
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };

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

type StockfishWasmInstance = {
    postMessage: (cmd: string) => void;
    addMessageListener: (cb: (line: string) => void) => void;
    // optional
    removeMessageListener?: (cb: (line: string) => void) => void;
    terminate?: () => void;
};

function loadScriptOnce(src: string, id: string): Promise<void> {
    if (typeof window === 'undefined')
        return Promise.reject(
            new Error('Stockfish can only run in the browser.')
        );
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing?.dataset.loaded === 'true') return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
        const script = existing ?? document.createElement('script');
        script.id = id;
        script.src = src;
        script.async = true;
        script.onload = () => {
            script.dataset.loaded = 'true';
            resolve();
        };
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        if (!existing) document.head.appendChild(script);
    });
}

async function createStockfishWasm(): Promise<StockfishWasmInstance> {
    await loadScriptOnce(
        '/vendor/stockfish/stockfish.js',
        'backrank-stockfish-wasm'
    );
    const sfFactory = (
        window as unknown as {
            Stockfish?: () => Promise<StockfishWasmInstance>;
        }
    ).Stockfish;
    if (!sfFactory)
        throw new Error(
            'Stockfish() not found on window (script load failed).'
        );
    return await sfFactory();
}

export class StockfishClient {
    private enginePromise: Promise<StockfishWasmInstance>;
    private engine: StockfishWasmInstance | null = null;
    private pending = new Map<
        string,
        | {
              kind: 'single';
              cacheKey?: string;
              resolve: (v: EvalResult) => void;
              reject: (e: Error) => void;
          }
        | {
              kind: 'multipv';
              cacheKey?: string;
              resolve: (v: MultiPvResult) => void;
              reject: (e: Error) => void;
          }
    >();
    private cacheEval = new Map<string, EvalResult>();
    private cacheMulti = new Map<string, MultiPvResult>();
    private queue: (
        | {
              id: string;
              kind: 'single';
              fen: string;
              movetimeMs: number;
              cacheKey?: string;
          }
        | {
              id: string;
              kind: 'multipv';
              fen: string;
              movetimeMs: number;
              multiPv: number;
              cacheKey?: string;
          }
    )[] = [];
    private current: {
        id: string;
        kind: 'single' | 'multipv';
        fen: string;
        movetimeMs: number;
        multiPv: number;
        lastScore: Score | null;
        lastDepth?: number;
        lastTimeMs?: number;
        lastPvUci: string[];
        lastMultiPv: Map<number, MultiPvLine>;
    } | null = null;
    private onLineBound = (line: string) => this.onLine(line);

    constructor() {
        this.enginePromise = createStockfishWasm().then((e) => {
            this.engine = e;
            e.addMessageListener(this.onLineBound);
            // bootstrap UCI
            e.postMessage('uci');
            e.postMessage('isready');
            return e;
        });
    }

    terminate() {
        this.queue = [];
        this.current = null;
        if (this.engine?.removeMessageListener)
            this.engine.removeMessageListener(this.onLineBound);
        if (this.engine?.terminate) this.engine.terminate();
        this.engine = null;
        this.pending.clear();
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
            this.queue.push({
                id,
                kind: 'single',
                fen: opts.fen,
                movetimeMs,
                cacheKey: key,
            });
        });
        await this.enginePromise;
        this.startNext();
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
            this.queue.push({
                id,
                kind: 'multipv',
                fen: opts.fen,
                movetimeMs,
                multiPv,
                cacheKey: key,
            });
        });

        await this.enginePromise;
        this.startNext();
        return await p;
    }

    cancelAll() {
        this.queue = [];
        if (this.engine) this.engine.postMessage('stop');
        // reject any pending futures (current + queued)
        for (const [id, p] of this.pending.entries()) {
            this.pending.delete(id);
            p.reject(new Error('Cancelled'));
        }
        this.current = null;
    }

    private startNext() {
        if (this.current || this.queue.length === 0 || !this.engine) return;
        const job = this.queue.shift()!;
        this.current = {
            id: job.id,
            kind: job.kind,
            fen: job.fen,
            movetimeMs: job.movetimeMs,
            multiPv: job.kind === 'multipv' ? job.multiPv : 1,
            lastScore: null,
            lastPvUci: [],
            lastMultiPv: new Map<number, MultiPvLine>(),
        };
        this.engine.postMessage('ucinewgame');
        this.engine.postMessage('isready');
        this.engine.postMessage(
            `setoption name MultiPV value ${this.current.multiPv}`
        );
        this.engine.postMessage(`position fen ${job.fen}`);
        this.engine.postMessage(`go movetime ${job.movetimeMs}`);
    }

    private onLine(line: string) {
        if (!this.current) return;
        if (line === 'readyok') return;

        if (line.startsWith('info ')) {
            const time = line.match(/\btime\s+(\d+)\b/);
            const scoreMate = line.match(/\bscore\s+mate\s+(-?\d+)\b/);
            const scoreCp = line.match(/\bscore\s+cp\s+(-?\d+)\b/);
            const depth = line.match(/\bdepth\s+(\d+)\b/);
            const multipv = line.match(/\bmultipv\s+(\d+)\b/);
            const pv = line.match(/\bpv\s+(.+)\s*$/);

            if (depth) this.current.lastDepth = Number(depth[1]);
            if (time) this.current.lastTimeMs = Number(time[1]);
            if (scoreMate)
                this.current.lastScore = {
                    type: 'mate',
                    value: Number(scoreMate[1]),
                };
            else if (scoreCp)
                this.current.lastScore = {
                    type: 'cp',
                    value: Number(scoreCp[1]),
                };

            if (pv)
                this.current.lastPvUci = pv[1]
                    .trim()
                    .split(/\s+/)
                    .filter(Boolean);

            // Track MultiPV lines (if present). Stockfish emits multipv 1..N.
            const mp = multipv ? Number(multipv[1]) : 1;
            if (pv) {
                this.current.lastMultiPv.set(mp, {
                    multipv: mp,
                    pvUci: this.current.lastPvUci,
                    score: this.current.lastScore,
                    depth: this.current.lastDepth,
                    timeMs: this.current.lastTimeMs,
                });
            }
            return;
        }

        if (line.startsWith('bestmove ')) {
            const bestMoveUci = line.split(/\s+/)[1] ?? '';
            const id = this.current.id;
            const fen = this.current.fen;
            const p = this.pending.get(id);
            this.pending.delete(id);
            const singleRes: EvalResult = {
                fen,
                bestMoveUci,
                pvUci: this.current.lastPvUci,
                score: this.current.lastScore,
                depth: this.current.lastDepth,
                timeMs: this.current.lastTimeMs,
            };

            const mpLines = Array.from(this.current.lastMultiPv.values())
                .sort((a, b) => a.multipv - b.multipv)
                .filter((l) => l.pvUci.length > 0);
            const mpRes: MultiPvResult = {
                fen,
                bestMoveUci,
                lines:
                    mpLines.length > 0
                        ? mpLines
                        : [
                              {
                                  multipv: 1,
                                  pvUci: this.current.lastPvUci,
                                  score: this.current.lastScore,
                                  depth: this.current.lastDepth,
                                  timeMs: this.current.lastTimeMs,
                              },
                          ],
            };
            this.current = null;
            if (p) {
                if (p.kind === 'multipv') {
                    if (p.cacheKey) this.cacheMulti.set(p.cacheKey, mpRes);
                    p.resolve(mpRes);
                } else {
                    if (p.cacheKey) this.cacheEval.set(p.cacheKey, singleRes);
                    p.resolve(singleRes);
                }
            }
            this.startNext();
        }
    }
}
