import Stockfish from 'stockfish.wasm';
import type {
    EvalResult,
    MultiPvLine,
    MultiPvResult,
    Score,
    StockfishEngine,
} from '@/lib/analysis/stockfishClient';

type StockfishInstance = Awaited<ReturnType<typeof Stockfish>>;

type ActiveJob = {
    id: string;
    fen: string;
    multiPv: number;
    resolve: (value: MultiPvResult) => void;
    reject: (error: Error) => void;
    linesByMultiPv: Map<number, MultiPvLine>;
    timeout: ReturnType<typeof setTimeout>;
    bestMoveUci: string;
    latestDepth?: number;
    latestTimeMs?: number;
};

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function parseInfoLine(line: string) {
    const depth = /\bdepth\s+(\d+)\b/.exec(line);
    const time = /\btime\s+(\d+)\b/.exec(line);
    const multipv = /\bmultipv\s+(\d+)\b/.exec(line);
    const scoreMate = /\bscore\s+mate\s+(-?\d+)\b/.exec(line);
    const scoreCp = /\bscore\s+cp\s+(-?\d+)\b/.exec(line);
    const pv = /\bpv\s+(.+)\s*$/.exec(line);

    const score: Score | null = scoreMate
        ? { type: 'mate', value: Number(scoreMate[1]) }
        : scoreCp
          ? { type: 'cp', value: Number(scoreCp[1]) }
          : null;

    return {
        depth: depth ? Number(depth[1]) : undefined,
        timeMs: time ? Number(time[1]) : undefined,
        multipv: multipv ? Number(multipv[1]) : 1,
        score,
        pvUci: pv ? pv[1].trim().split(/\s+/).filter(Boolean) : null,
    };
}

export class ServerStockfishClient implements StockfishEngine {
    private enginePromise: Promise<StockfishInstance> | null = null;
    private engine: StockfishInstance | null = null;
    private active: ActiveJob | null = null;
    private chain: Promise<unknown> = Promise.resolve();

    private async ensureEngine() {
        if (this.enginePromise) return this.enginePromise;
        this.enginePromise = Stockfish().then((engine) => {
            this.engine = engine;
            engine.addMessageListener((line) => this.onLine(line));
            engine.postMessage('uci');
            engine.postMessage('isready');
            return engine;
        });
        return this.enginePromise;
    }

    async evalPosition(opts: {
        fen: string;
        movetimeMs?: number;
    }): Promise<EvalResult> {
        const res = await this.analyzeMultiPv({
            fen: opts.fen,
            movetimeMs: opts.movetimeMs,
            multiPv: 1,
        });
        const first = res.lines[0];
        return {
            fen: res.fen,
            bestMoveUci:
                res.bestMoveUci || first?.pvUci?.[0] || '',
            pvUci: first?.pvUci ?? [],
            score: first?.score ?? null,
            depth: first?.depth,
            timeMs: first?.timeMs,
        };
    }

    async analyzeMultiPv(opts: {
        fen: string;
        movetimeMs?: number;
        multiPv?: number;
    }): Promise<MultiPvResult> {
        const run = () => this.runAnalysis(opts);
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }

    cancelAll() {
        this.engine?.postMessage('stop');
        if (this.active) {
            clearTimeout(this.active.timeout);
            this.active.reject(new Error('Analysis cancelled'));
            this.active = null;
        }
    }

    terminate() {
        this.cancelAll();
        this.engine?.terminate?.();
        this.engine = null;
        this.enginePromise = null;
    }

    private async runAnalysis(opts: {
        fen: string;
        movetimeMs?: number;
        multiPv?: number;
    }): Promise<MultiPvResult> {
        const engine = await this.ensureEngine();
        const id = uid();
        const movetimeMs = Math.max(1, Math.trunc(opts.movetimeMs ?? 200));
        const multiPv = Math.max(1, Math.min(5, Math.trunc(opts.multiPv ?? 1)));

        return new Promise<MultiPvResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.active?.id !== id) return;
                engine.postMessage('stop');
                this.active = null;
                reject(new Error(`Engine timeout after ${movetimeMs + 5000}ms`));
            }, movetimeMs + 5000);

            this.active = {
                id,
                fen: opts.fen,
                multiPv,
                resolve,
                reject,
                linesByMultiPv: new Map(),
                timeout,
                bestMoveUci: '',
            };

            engine.postMessage('stop');
            engine.postMessage('ucinewgame');
            engine.postMessage('isready');
            engine.postMessage(`setoption name MultiPV value ${multiPv}`);
            engine.postMessage(`position fen ${opts.fen}`);
            engine.postMessage(`go movetime ${movetimeMs}`);
        });
    }

    private onLine(line: string) {
        const job = this.active;
        if (!job || line === 'readyok') return;

        if (line.startsWith('info ')) {
            const parsed = parseInfoLine(line);
            if (parsed.depth != null) job.latestDepth = parsed.depth;
            if (parsed.timeMs != null) job.latestTimeMs = parsed.timeMs;
            if (parsed.pvUci?.length) {
                job.linesByMultiPv.set(parsed.multipv, {
                    multipv: parsed.multipv,
                    score: parsed.score,
                    pvUci: parsed.pvUci,
                    depth: parsed.depth ?? job.latestDepth,
                    timeMs: parsed.timeMs ?? job.latestTimeMs,
                });
            }
            return;
        }

        if (!line.startsWith('bestmove ')) return;
        const bestMoveUci = (line.split(/\s+/)[1] ?? '').trim();
        job.bestMoveUci = bestMoveUci;
        clearTimeout(job.timeout);
        this.active = null;
        const lines = Array.from(job.linesByMultiPv.values()).sort(
            (a, b) => a.multipv - b.multipv
        );
        job.resolve({
            fen: job.fen,
            bestMoveUci:
                bestMoveUci || lines.find((l) => l.multipv === 1)?.pvUci[0] || '',
            lines,
        });
    }
}
