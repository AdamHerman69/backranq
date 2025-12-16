export type Score =
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };

export type EvalResult = {
    fen: string;
    bestMoveUci: string;
    pvUci: string[];
    score: Score | null;
    depth?: number;
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
        { resolve: (v: EvalResult) => void; reject: (e: Error) => void }
    >();
    private cache = new Map<string, EvalResult>();
    private queue: { id: string; fen: string; movetimeMs: number }[] = [];
    private current: {
        id: string;
        fen: string;
        lastScore: Score | null;
        lastDepth?: number;
        lastPvUci: string[];
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
        this.cache.clear();
    }

    async evalPosition(opts: {
        fen: string;
        movetimeMs?: number;
        cacheKey?: string;
    }): Promise<EvalResult> {
        const movetimeMs = Math.max(1, Math.trunc(opts.movetimeMs ?? 200));
        const key = opts.cacheKey ?? `${opts.fen}::${movetimeMs}`;
        const cached = this.cache.get(key);
        if (cached) return cached;

        const id = uid();
        const p = new Promise<EvalResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.queue.push({ id, fen: opts.fen, movetimeMs });
        });
        await this.enginePromise;
        this.startNext();
        const res = await p;
        this.cache.set(key, res);
        return res;
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
            fen: job.fen,
            lastScore: null,
            lastPvUci: [],
        };
        this.engine.postMessage('ucinewgame');
        this.engine.postMessage('isready');
        this.engine.postMessage(`position fen ${job.fen}`);
        this.engine.postMessage(`go movetime ${job.movetimeMs}`);
    }

    private onLine(line: string) {
        if (!this.current) return;
        if (line === 'readyok') return;

        if (line.startsWith('info ')) {
            const scoreMate = line.match(/\bscore\s+mate\s+(-?\d+)\b/);
            const scoreCp = line.match(/\bscore\s+cp\s+(-?\d+)\b/);
            const depth = line.match(/\bdepth\s+(\d+)\b/);
            const pv = line.match(/\bpv\s+(.+)\s*$/);

            if (depth) this.current.lastDepth = Number(depth[1]);
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
            return;
        }

        if (line.startsWith('bestmove ')) {
            const bestMoveUci = line.split(/\s+/)[1] ?? '';
            const id = this.current.id;
            const fen = this.current.fen;
            const p = this.pending.get(id);
            this.pending.delete(id);
            const res: EvalResult = {
                fen,
                bestMoveUci,
                pvUci: this.current.lastPvUci,
                score: this.current.lastScore,
                depth: this.current.lastDepth,
            };
            this.current = null;
            if (p) p.resolve(res);
            this.startNext();
        }
    }
}
