import { Chess } from 'chess.js';
import {
    isStructurallyCompleteMultiPvBundle,
    type AnalysisLimit,
    type EngineIdentity,
    type EngineWdl,
    type EvalResult,
    type MultiPvLine,
    type MultiPvResult,
    type Score,
    type StockfishEngine,
} from '@/lib/analysis/stockfishClient';
import {
    createStockfish18LiteEngine,
    type ServerStockfishRuntime,
} from '@/lib/analysis/serverStockfishRuntime';

type StockfishInstance = ServerStockfishRuntime;

type ProtocolWaiter = {
    predicate: (line: string) => boolean;
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
};

type ActiveJob = {
    id: string;
    fen: string;
    multiPv: number;
    resolve: (value: MultiPvResult) => void;
    reject: (error: Error) => void;
    linesByDepth: Map<number, Map<number, MultiPvLine>>;
    timeout: ReturnType<typeof setTimeout>;
    forceResetTimeout?: ReturnType<typeof setTimeout>;
    bestMoveUci: string;
    latestDepth?: number;
    latestSelDepth?: number;
    latestNodes?: number;
    latestNps?: number;
    latestTimeMs?: number;
    settled: boolean;
    abortCleanup?: () => void;
};

function exactMateInOneFallback(job: ActiveJob): MultiPvLine | null {
    const moveUci = job.bestMoveUci.trim().toLowerCase();
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(moveUci)) return null;

    try {
        const chess = new Chess(job.fen);
        const move = chess.move({
            from: moveUci.slice(0, 2),
            to: moveUci.slice(2, 4),
            promotion: moveUci.slice(4, 5) || undefined,
        });
        if (!move || !chess.isCheckmate()) return null;
    } catch {
        return null;
    }

    // This is a rule-exact outcome derived from the legal UCI bestmove. It is
    // intentionally limited to mate in one: other missing-PV searches remain
    // unresolved and retry instead of receiving a guessed evaluation.
    return {
        multipv: 1,
        pvUci: [moveUci],
        score: { type: 'mate', value: 1 },
        wdl: { win: 1_000, draw: 0, loss: 0 },
        ...(job.latestDepth != null ? { depth: job.latestDepth } : {}),
        ...(job.latestSelDepth != null
            ? { selDepth: job.latestSelDepth }
            : {}),
        ...(job.latestNodes != null ? { nodes: job.latestNodes } : {}),
        ...(job.latestNps != null ? { nps: job.latestNps } : {}),
        ...(job.latestTimeMs != null ? { timeMs: job.latestTimeMs } : {}),
    };
}

export type ServerStockfishClientOptions = {
    hashMb?: number;
    flavor?: 'lite-single';
    defaultNodes?: number;
    defaultTimeoutMs?: number;
    /** Test seam for deterministic UCI protocol verification. */
    runtimeFactory?: () => Promise<ServerStockfishRuntime>;
};

export type ParsedInfoLine = {
    depth?: number;
    selDepth?: number;
    nodes?: number;
    nps?: number;
    timeMs?: number;
    multipv: number;
    score: Score | null;
    wdl?: EngineWdl;
    pvUci: string[] | null;
    isBound: boolean;
};

function uid() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function parseUciInfoLine(line: string): ParsedInfoLine {
    const depth = /\bdepth\s+(\d+)\b/.exec(line);
    const selDepth = /\bseldepth\s+(\d+)\b/.exec(line);
    const nodes = /\bnodes\s+(\d+)\b/.exec(line);
    const nps = /\bnps\s+(\d+)\b/.exec(line);
    const time = /\btime\s+(\d+)\b/.exec(line);
    const multipv = /\bmultipv\s+(\d+)\b/.exec(line);
    const scoreMate = /\bscore\s+mate\s+(-?\d+)\b/.exec(line);
    const scoreCp = /\bscore\s+cp\s+(-?\d+)\b/.exec(line);
    const wdl = /\bwdl\s+(\d+)\s+(\d+)\s+(\d+)\b/.exec(line);
    const pv = /\bpv\s+(.+)\s*$/.exec(line);
    const isBound = /\b(?:lowerbound|upperbound)\b/.test(line);

    const score: Score | null = isBound
        ? null
        : scoreMate
          ? { type: 'mate', value: Number(scoreMate[1]) }
          : scoreCp
            ? { type: 'cp', value: Number(scoreCp[1]) }
            : null;

    return {
        depth: depth ? Number(depth[1]) : undefined,
        selDepth: selDepth ? Number(selDepth[1]) : undefined,
        nodes: nodes ? Number(nodes[1]) : undefined,
        nps: nps ? Number(nps[1]) : undefined,
        timeMs: time ? Number(time[1]) : undefined,
        multipv: multipv ? Number(multipv[1]) : 1,
        score,
        wdl: wdl
            ? {
                  win: Number(wdl[1]),
                  draw: Number(wdl[2]),
                  loss: Number(wdl[3]),
              }
            : undefined,
        pvUci: pv ? pv[1].trim().split(/\s+/).filter(Boolean) : null,
        isBound,
    };
}

/**
 * Node-compatible Stockfish 18 adapter.
 *
 * The npm package is GPL-3.0. We use its maintained single-threaded lite build:
 * it works on supported Node versions without mutating global fetch and keeps
 * the server bundle materially smaller than the 100+ MB full network build.
 */
export class ServerStockfishClient implements StockfishEngine {
    private enginePromise: Promise<StockfishInstance> | null = null;
    private engine: StockfishInstance | null = null;
    private active: ActiveJob | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private cancellationGeneration = 0;
    private needsNewGameBoundary = false;
    private protocolWaiters = new Set<ProtocolWaiter>();
    private idleWaiters = new Set<() => void>();
    private readonly hashMb: number;
    private readonly flavor: 'lite-single';
    private readonly defaultNodes: number;
    private readonly defaultTimeoutMs: number;
    private readonly runtimeFactory: () => Promise<StockfishInstance>;
    private identity: EngineIdentity = {
        name: 'Stockfish 18',
        version: '18.0.8',
        source: 'stockfish@18.0.8/server/stockfish-18-lite-single',
        flavor: 'lite-single-nnue-wasm',
        options: {
            Threads: 1,
            UCI_ShowWDL: true,
        },
    };

    constructor(options: ServerStockfishClientOptions = {}) {
        this.hashMb = Math.max(1, Math.min(1024, Math.trunc(options.hashMb ?? 64)));
        this.flavor = options.flavor ?? 'lite-single';
        this.defaultNodes = Math.max(
            1,
            Math.trunc(options.defaultNodes ?? 100_000)
        );
        this.defaultTimeoutMs = Math.max(
            1_000,
            Math.trunc(options.defaultTimeoutMs ?? 30_000)
        );
        this.runtimeFactory =
            options.runtimeFactory ?? createStockfish18LiteEngine;
        this.identity.flavor = `${this.flavor}-nnue-wasm`;
        this.identity.options = {
            Threads: 1,
            Hash: this.hashMb,
            UCI_ShowWDL: true,
        };
    }

    async getIdentity(): Promise<EngineIdentity> {
        await this.ensureEngine();
        return {
            ...this.identity,
            options: { ...this.identity.options },
        };
    }

    async evalPosition(
        opts: AnalysisLimit & { fen: string }
    ): Promise<EvalResult> {
        const res = await this.analyzeMultiPv({
            ...opts,
            multiPv: 1,
        });
        const first = res.lines[0];
        return {
            fen: res.fen,
            bestMoveUci: res.bestMoveUci || first?.pvUci?.[0] || '',
            pvUci: first?.pvUci ?? [],
            score: first?.score ?? null,
            wdl: first?.wdl,
            depth: first?.depth,
            selDepth: first?.selDepth,
            nodes: first?.nodes,
            nps: first?.nps,
            timeMs: first?.timeMs,
        };
    }

    async analyzeMultiPv(
        opts: AnalysisLimit & { fen: string; multiPv?: number }
    ): Promise<MultiPvResult> {
        const generation = this.cancellationGeneration;
        const run = () => {
            if (generation !== this.cancellationGeneration) {
                throw new Error('Analysis cancelled');
            }
            return this.runAnalysis(opts);
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }

    cancelAll() {
        this.cancellationGeneration++;
        const job = this.active;
        if (!job) return;
        this.stopAndReject(job, new Error('Analysis cancelled'));
    }

    terminate() {
        this.cancelAll();
        for (const waiter of this.protocolWaiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(new Error('Engine terminated'));
        }
        this.protocolWaiters.clear();
        this.engine?.terminate?.();
        this.engine = null;
        this.enginePromise = null;
        this.clearActive();
    }

    private async ensureEngine() {
        if (this.enginePromise) return this.enginePromise;

        this.enginePromise = this.runtimeFactory()
            .then(async (engine) => {
                this.engine = engine;
                engine.listener = (line) => this.onLine(String(line));

                const uciOk = this.waitForProtocolLine(
                    (line) => line === 'uciok',
                    10_000,
                    'uciok'
                );
                engine.sendCommand('uci');
                await uciOk;

                engine.sendCommand(
                    `setoption name Hash value ${this.hashMb}`
                );
                engine.sendCommand('setoption name Threads value 1');
                engine.sendCommand('setoption name UCI_ShowWDL value true');
                // This is the explicit engine-session boundary. Successful
                // searches that follow deliberately retain the transposition
                // table; a watchdog reset creates a new runtime and repeats
                // this startup boundary.
                engine.sendCommand('ucinewgame');
                await this.waitUntilReady(engine);
                this.needsNewGameBoundary = false;
                return engine;
            })
            .catch((error) => {
                this.engine = null;
                this.enginePromise = null;
                throw error;
            });

        return this.enginePromise;
    }

    private async waitUntilReady(engine: StockfishInstance) {
        const ready = this.waitForProtocolLine(
            (line) => line === 'readyok',
            10_000,
            'readyok'
        );
        engine.sendCommand('isready');
        await ready;
    }

    private waitForProtocolLine(
        predicate: (line: string) => boolean,
        timeoutMs: number,
        label: string
    ) {
        return new Promise<string>((resolve, reject) => {
            const waiter: ProtocolWaiter = {
                predicate,
                resolve,
                reject,
                timeout: setTimeout(() => {
                    this.protocolWaiters.delete(waiter);
                    reject(new Error(`Engine did not return ${label}`));
                }, timeoutMs),
            };
            this.protocolWaiters.add(waiter);
        });
    }

    private async waitForIdle() {
        if (!this.active) return;
        await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
    }

    private async runAnalysis(
        opts: AnalysisLimit & { fen: string; multiPv?: number }
    ): Promise<MultiPvResult> {
        let engine = await this.ensureEngine();
        await this.waitForIdle();
        // A timeout watchdog may terminate and replace the runtime while this
        // request is waiting behind the active job. Never continue with that
        // stale local engine reference.
        engine = await this.ensureEngine();

        if (opts.signal?.aborted) {
            throw new Error('Analysis aborted');
        }

        const id = uid();
        const nodes =
            opts.nodes == null
                ? this.defaultNodes
                : Math.max(1, Math.trunc(opts.nodes));
        const depth =
            opts.depth == null ? undefined : Math.max(1, Math.trunc(opts.depth));
        const movetimeMs =
            opts.movetimeMs == null
                ? undefined
                : Math.max(1, Math.trunc(opts.movetimeMs));
        const multiPv = Math.max(1, Math.min(8, Math.trunc(opts.multiPv ?? 1)));
        const timeoutMs = Math.max(
            1_000,
            Math.trunc(
                opts.timeoutMs ??
                    (movetimeMs != null && opts.nodes == null && depth == null
                        ? movetimeMs + 5_000
                        : this.defaultTimeoutMs)
                )
        );

        // MultiPV is a per-search option. The readiness barrier guarantees the
        // option is committed before position/go while intentionally retaining
        // the engine session's transposition table across related positions.
        if (this.needsNewGameBoundary) {
            engine.sendCommand('ucinewgame');
            this.needsNewGameBoundary = false;
        }
        engine.sendCommand(`setoption name MultiPV value ${multiPv}`);
        await this.waitUntilReady(engine);
        if (opts.signal?.aborted) {
            throw new Error('Analysis aborted');
        }

        return new Promise<MultiPvResult>((resolve, reject) => {
            const timeout = setTimeout(() => {
                const current = this.active;
                if (current?.id !== id) return;
                this.stopAndReject(
                    current,
                    new Error(`Engine timeout after ${timeoutMs}ms`)
                );
            }, timeoutMs);

            const job: ActiveJob = {
                id,
                fen: opts.fen,
                multiPv,
                resolve,
                reject,
                linesByDepth: new Map(),
                timeout,
                bestMoveUci: '',
                settled: false,
            };
            this.active = job;

            if (opts.signal) {
                const onAbort = () => {
                    if (this.active?.id !== id) return;
                    this.stopAndReject(job, new Error('Analysis aborted'));
                };
                opts.signal.addEventListener('abort', onAbort, { once: true });
                job.abortCleanup = () =>
                    opts.signal?.removeEventListener('abort', onAbort);
            }

            engine.sendCommand(`position fen ${opts.fen}`);

            // Deterministic work limits win over wall time. Movetime remains a
            // compatibility fallback and the watchdog above is always present.
            if (opts.nodes != null || (depth == null && movetimeMs == null)) {
                engine.sendCommand(`go nodes ${nodes}`);
            } else if (depth != null) {
                engine.sendCommand(`go depth ${depth}`);
            } else {
                engine.sendCommand(`go movetime ${movetimeMs}`);
            }
        });
    }

    private stopAndReject(job: ActiveJob, error: Error) {
        this.needsNewGameBoundary = true;
        if (!job.settled) {
            job.settled = true;
            clearTimeout(job.timeout);
            job.abortCleanup?.();
            job.reject(error);
        }
        this.engine?.sendCommand('stop');

        // Stockfish normally emits bestmove after stop. If it does not, unblock
        // the serialized queue and force a fresh readiness handshake.
        job.forceResetTimeout = setTimeout(() => {
            if (this.active?.id !== job.id) return;
            this.engine?.terminate?.();
            this.engine = null;
            this.enginePromise = null;
            this.clearActive();
        }, 2_000);
    }

    private clearActive() {
        const job = this.active;
        if (job?.forceResetTimeout) clearTimeout(job.forceResetTimeout);
        if (job) {
            clearTimeout(job.timeout);
            job.abortCleanup?.();
        }
        this.active = null;
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
    }

    private captureIdentity(line: string) {
        if (line.startsWith('id name ')) {
            const name = line.slice('id name '.length).trim();
            this.identity = { ...this.identity, name };
            return;
        }
        if (line.startsWith('id author ')) {
            this.identity = {
                ...this.identity,
                author: line.slice('id author '.length).trim(),
            };
            return;
        }
        const evalFile =
            /^option name EvalFile type string default (.+)$/.exec(line)?.[1];
        if (evalFile) {
            this.identity = { ...this.identity, evalFile: evalFile.trim() };
        }
    }

    private onLine(line: string) {
        this.captureIdentity(line);

        for (const waiter of Array.from(this.protocolWaiters)) {
            if (!waiter.predicate(line)) continue;
            clearTimeout(waiter.timeout);
            this.protocolWaiters.delete(waiter);
            waiter.resolve(line);
        }

        const job = this.active;
        if (!job || line === 'readyok') return;

        if (line.startsWith('info ')) {
            const parsed = parseUciInfoLine(line);
            if (parsed.depth != null) job.latestDepth = parsed.depth;
            if (parsed.selDepth != null) job.latestSelDepth = parsed.selDepth;
            if (parsed.nodes != null) job.latestNodes = parsed.nodes;
            if (parsed.nps != null) job.latestNps = parsed.nps;
            if (parsed.timeMs != null) job.latestTimeMs = parsed.timeMs;

            const depth = parsed.depth ?? job.latestDepth ?? 0;
            const linesAtDepth =
                job.linesByDepth.get(depth) ?? new Map<number, MultiPvLine>();
            const previous = linesAtDepth.get(parsed.multipv);
            if (
                parsed.score &&
                parsed.pvUci?.length &&
                (!previous ||
                    (parsed.depth ?? 0) >= (previous.depth ?? 0))
            ) {
                linesAtDepth.set(parsed.multipv, {
                    multipv: parsed.multipv,
                    score: parsed.score,
                    wdl: parsed.wdl,
                    pvUci: parsed.pvUci,
                    depth: parsed.depth ?? job.latestDepth,
                    selDepth: parsed.selDepth ?? job.latestSelDepth,
                    nodes: parsed.nodes ?? job.latestNodes,
                    nps: parsed.nps ?? job.latestNps,
                    timeMs: parsed.timeMs ?? job.latestTimeMs,
                });
                job.linesByDepth.set(depth, linesAtDepth);
            }
            return;
        }

        if (!line.startsWith('bestmove ')) return;
        const bestMoveUci = (line.split(/\s+/)[1] ?? '').trim();
        job.bestMoveUci = bestMoveUci === '(none)' ? '' : bestMoveUci;

        if (!job.settled) {
            job.settled = true;
            const depthBuckets = Array.from(job.linesByDepth.entries()).sort(
                ([depthA], [depthB]) => depthB - depthA
            );
            const completeBucket = depthBuckets.find(([, linesAtDepth]) => {
                return isStructurallyCompleteMultiPvBundle(
                    Array.from(linesAtDepth.values()),
                    job.multiPv
                );
            });
            const selectedBucket =
                completeBucket ??
                depthBuckets.find(([, linesAtDepth]) =>
                    linesAtDepth.has(1)
                );
            const lines = Array.from(
                selectedBucket?.[1].values() ?? []
            ).sort((a, b) => a.multipv - b.multipv);
            if (lines.length === 0) {
                const terminalFallback = exactMateInOneFallback(job);
                if (!terminalFallback) {
                    job.reject(new Error('Engine returned no exact PV'));
                } else {
                    job.resolve({
                        fen: job.fen,
                        bestMoveUci: job.bestMoveUci,
                        lines: [terminalFallback],
                        // UCI bestmove proves this exact mate, but it does not
                        // prove that no equivalent mating move exists.
                        alternativesComplete: false,
                        identity: {
                            ...this.identity,
                            options: {
                                ...this.identity.options,
                                MultiPV: job.multiPv,
                            },
                        },
                    });
                }
            } else {
                job.resolve({
                    fen: job.fen,
                    bestMoveUci:
                        job.bestMoveUci ||
                        lines.find((candidate) => candidate.multipv === 1)
                            ?.pvUci[0] ||
                        '',
                    lines,
                    alternativesComplete: completeBucket != null,
                    identity: {
                        ...this.identity,
                        options: {
                            ...this.identity.options,
                            MultiPV: job.multiPv,
                        },
                    },
                });
            }
        }
        this.clearActive();
    }
}
