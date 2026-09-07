import { Chess } from 'chess.js';
import { STOCKFISH_ARTIFACT_ID } from './stockfishMetadata';
import {
    isStructurallyCompleteMultiPvBundle,
    resolveEngineSearchContext,
    resolvedEngineLimit,
    engineSearchCacheKey,
    createSearchEvidence,
    createAnalysisSnapshot,
    createBoundAnalysisSnapshot,
    retainAnalysisSnapshots,
    type AnalysisSnapshot,
    terminalEngineResult,
    type EngineSearchContext,
    type BoundedEngineLine,
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
import { ExactPvUnavailableError } from '@/lib/analysis/serverStockfishErrors';

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
    context: EngineSearchContext;
    limit: AnalysisLimit & { multiPv?: number };
    snapshots: AnalysisSnapshot[];
    snapshotIndex: number;
    completeSnapshot?: { depth: number; lines: MultiPvLine[] };
    boundLines: Map<string, BoundedEngineLine>;
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
    boundedScore: Score | null;
    bound: 'UPPER' | 'LOWER' | null;
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
        boundedScore: isBound ? scoreMate ? { type: 'mate', value: Number(scoreMate[1]) } : scoreCp ? { type: 'cp', value: Number(scoreCp[1]) } : null : null,
        bound: isBound ? /\bupperbound\b/.test(line) ? 'UPPER' : 'LOWER' : null,
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
    private terminated = false;
    private sessionId = uid();
    private cacheMulti = new Map<string, MultiPvResult>();
    private requests = new Set<{ reject: (error: Error) => void; abortCleanup?: () => void }>();
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
        artifactId: STOCKFISH_ARTIFACT_ID,
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
        opts: AnalysisLimit & { fen: string; cacheKey?: string }
    ): Promise<EvalResult> {
        const res = await this.analyzeMultiPv({
            ...opts,
            multiPv: 1,
        });
        const first = res.lines[0];
        if (!first && !res.terminal) throw new ExactPvUnavailableError();
        return {
            fen: res.fen,
            bestMoveUci: first?.pvUci?.[0] || res.bestMoveUci || '',
            pvUci: first?.pvUci ?? [],
            score: res.terminal ? { type: res.terminal.outcome === 'LOSS' ? 'mate' : 'cp', value: 0 } : first?.score ?? null,
            wdl: res.terminal ? { win: 0, draw: res.terminal.outcome === 'DRAW' ? 1000 : 0, loss: res.terminal.outcome === 'LOSS' ? 1000 : 0 } : first?.wdl,
            depth: first?.depth,
            selDepth: first?.selDepth,
            nodes: res.searchEvidence?.reported.nodes ?? first?.nodes,
            nps: first?.nps,
            timeMs: res.searchEvidence?.reported.timeMs ?? first?.timeMs,
            terminal: res.terminal,
            searchEvidence: res.searchEvidence,
            snapshots: res.snapshots,
        };
    }

    async analyzeMultiPv(
        opts: AnalysisLimit & { fen: string; multiPv?: number; cacheKey?: string }
    ): Promise<MultiPvResult> {
        const generation = this.cancellationGeneration;
        if (this.terminated) throw new Error('Engine terminated');
        if (opts.signal?.aborted) throw new Error('Analysis aborted');
        const run = () => {
            if (generation !== this.cancellationGeneration) {
                throw new Error('Analysis cancelled');
            }
            return this.runAnalysis(opts, generation);
        };
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return new Promise<MultiPvResult>((resolve, reject) => {
            const request = { reject, abortCleanup: undefined as (() => void) | undefined };
            const finish = () => { this.requests.delete(request); request.abortCleanup?.(); };
            if (opts.signal) {
                const abort = () => { finish(); reject(new Error('Analysis aborted')); };
                opts.signal.addEventListener('abort', abort, { once: true });
                request.abortCleanup = () => opts.signal?.removeEventListener('abort', abort);
            }
            this.requests.add(request);
            next.then((value) => { finish(); resolve(value); }, (error) => { finish(); reject(error); });
        });
    }

    cancelAll() {
        this.cancellationGeneration++;
        for (const request of this.requests) {
            request.abortCleanup?.();
            request.reject(new Error('Analysis cancelled'));
        }
        this.requests.clear();
        const job = this.active;
        if (!job) return;
        this.stopAndReject(job, new Error('Analysis cancelled'));
    }

    terminate() {
        this.terminated = true;
        this.cancelAll();
        this.cacheMulti.clear();
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
        if (this.terminated) throw new Error('Engine terminated');
        if (this.enginePromise) return this.enginePromise;

        this.enginePromise = this.runtimeFactory()
            .then(async (engine) => {
                if (this.terminated) {
                    engine.terminate?.();
                    throw new Error('Engine terminated');
                }
                this.engine = engine;
                this.sessionId = uid();
                engine.listener = (line) => { if (this.engine === engine) this.onLine(String(line)); };
                engine.errorListener = (error) =>
                    this.handleRuntimeFailure(engine, error);

                const uciOk = this.waitForProtocolLine(
                    (line) => line === 'uciok',
                    10_000,
                    'uciok'
                );
                try {
                    engine.sendCommand('uci');
                } catch (error) {
                    // The outer startup catch rejects all waiters. Attach a
                    // handler first so this locally-created promise cannot
                    // surface as an unhandled rejection while that cleanup
                    // runs.
                    void uciOk.catch(() => undefined);
                    throw error;
                }
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
                const runtimeError =
                    error instanceof Error
                        ? error
                        : new Error(String(error));
                // Startup commands can fail synchronously after the child has
                // been created (for example if IPC disconnects between ready
                // and `uci`). Tear down that runtime and every pending protocol
                // waiter immediately instead of leaving a live child and a
                // later unhandled waiter timeout behind.
                this.resetFailedRuntime(runtimeError);
                throw runtimeError;
            });

        return this.enginePromise;
    }

    private async waitUntilReady(engine: StockfishInstance) {
        const ready = this.waitForProtocolLine(
            (line) => line === 'readyok',
            10_000,
            'readyok'
        );
        try {
            this.sendRuntimeCommand(engine, 'isready');
        } catch (error) {
            void ready.catch(() => undefined);
            throw error;
        }
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
        opts: AnalysisLimit & { fen: string; multiPv?: number; cacheKey?: string },
        generation: number
    ): Promise<MultiPvResult> {
        const assertCurrent = () => {
            if (this.terminated || generation !== this.cancellationGeneration || opts.signal?.aborted) throw new Error('Analysis cancelled or aborted');
        };
        assertCurrent();
        const context = resolveEngineSearchContext(opts);
        const multiPv = Math.max(1, Math.min(16, context.rootMoves?.length ?? 16, Math.trunc(opts.multiPv ?? 1)));
        const limit = { ...resolvedEngineLimit(opts, this.defaultNodes), multiPv };
        const key = engineSearchCacheKey(context, limit, multiPv);
        const cached = this.cacheMulti.get(key);
        if (cached && opts.reuse === 'REUSE_ALLOWED') return { ...cached, searchEvidence: cached.searchEvidence ? { ...cached.searchEvidence, reused: true } : undefined };
        const terminal = terminalEngineResult(context, createSearchEvidence(uid(), this.identity, context, limit));
        if (terminal) return terminal;
        let engine = await this.ensureEngine();
        assertCurrent();
        await this.waitForIdle();
        // A timeout watchdog may terminate and replace the runtime while this
        // request is waiting behind the active job. Never continue with that
        // stale local engine reference.
        engine = await this.ensureEngine();
        assertCurrent();

        if (opts.signal?.aborted) {
            throw new Error('Analysis aborted');
        }

        const id = uid();
        const { nodes, depth, movetimeMs } = limit;
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
            this.sendRuntimeCommand(engine, 'ucinewgame');
            this.needsNewGameBoundary = false;
        }
        this.sendRuntimeCommand(
            engine,
            `setoption name MultiPV value ${multiPv}`
        );
        await this.waitUntilReady(engine);
        assertCurrent();
        if (opts.signal?.aborted) {
            throw new Error('Analysis aborted');
        }

        const result = await new Promise<MultiPvResult>((resolve, reject) => {
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
                fen: context.fen,
                multiPv,
                context,
                limit,
                resolve,
                reject,
                linesByDepth: new Map(),
                snapshots: [],
                snapshotIndex: 0,
                boundLines: new Map(),
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

            this.sendRuntimeCommand(engine, context.positionCommand);
            const searchMoves = context.rootMoves ? ` searchmoves ${context.rootMoves.join(' ')}` : '';

            // Deterministic work limits win over wall time. Movetime remains a
            // compatibility fallback and the watchdog above is always present.
            if (opts.nodes != null || (depth == null && movetimeMs == null)) {
                this.sendRuntimeCommand(engine, `go nodes ${nodes}${searchMoves}`);
            } else if (depth != null) {
                this.sendRuntimeCommand(engine, `go depth ${depth}${searchMoves}`);
            } else {
                this.sendRuntimeCommand(engine, `go movetime ${movetimeMs}${searchMoves}`);
            }
        });
        assertCurrent();
        this.cacheMulti.set(key, result);
        if (this.cacheMulti.size > 256) this.cacheMulti.delete(this.cacheMulti.keys().next().value!);
        return result;
    }

    private sendRuntimeCommand(engine: StockfishInstance, command: string) {
        try {
            engine.sendCommand(command);
        } catch (error) {
            const runtimeError =
                error instanceof Error ? error : new Error(String(error));
            if (this.engine === engine) {
                this.resetFailedRuntime(runtimeError);
            } else {
                try {
                    engine.terminate?.();
                } catch {
                    // Preserve the original IPC error.
                }
            }
            throw runtimeError;
        }
    }

    private stopAndReject(job: ActiveJob, error: Error) {
        this.needsNewGameBoundary = true;
        if (!job.settled) {
            job.settled = true;
            clearTimeout(job.timeout);
            job.abortCleanup?.();
            job.reject(error);
        }
        try {
            this.engine?.sendCommand('stop');
        } catch (stopError) {
            this.resetFailedRuntime(
                stopError instanceof Error
                    ? stopError
                    : new Error(String(stopError))
            );
            return;
        }

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

    private handleRuntimeFailure(engine: StockfishInstance, error: Error) {
        if (this.engine !== engine) return;
        this.resetFailedRuntime(error);
    }

    private resetFailedRuntime(error: Error) {
        const engine = this.engine;
        this.engine = null;
        this.enginePromise = null;
        try {
            engine?.terminate?.();
        } catch {
            // Runtime teardown is best effort; local jobs and protocol waiters
            // still have to be rejected and released below.
        }
        for (const waiter of this.protocolWaiters) {
            clearTimeout(waiter.timeout);
            waiter.reject(error);
        }
        this.protocolWaiters.clear();
        const job = this.active;
        if (job && !job.settled) {
            job.settled = true;
            job.reject(error);
        }
        this.needsNewGameBoundary = true;
        this.clearActive();
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
        if (job.settled && !line.startsWith('bestmove ')) return;

        if (line.startsWith('info ')) {
            const parsed = parseUciInfoLine(line);
            if (parsed.depth != null) job.latestDepth = parsed.depth;
            if (parsed.selDepth != null) job.latestSelDepth = parsed.selDepth;
            if (parsed.nodes != null) job.latestNodes = Math.max(job.latestNodes ?? 0, parsed.nodes);
            if (parsed.nps != null) job.latestNps = parsed.nps;
            if (parsed.timeMs != null) job.latestTimeMs = Math.max(job.latestTimeMs ?? 0, parsed.timeMs);
            const boundedRoot = parsed.pvUci?.[0];
            if (parsed.boundedScore && parsed.bound && boundedRoot && (job.context.rootMoves ?? job.context.legalRootMoves).includes(boundedRoot)) {
                for (const bucket of job.linesByDepth.values()) for (const [slot, point] of bucket) {
                    if (point.pvUci[0] === boundedRoot) bucket.delete(slot);
                }
                if (parsed.depth != null) job.linesByDepth.get(parsed.depth)?.delete(parsed.multipv);
                job.boundLines.set(boundedRoot, { moveUci: boundedRoot, score: parsed.boundedScore, bound: parsed.bound, depth: parsed.depth, nodes: parsed.nodes, timeMs: parsed.timeMs });
                const snapshot = createBoundAnalysisSnapshot(job.id, job.snapshotIndex, this.identity, job.context, job.limit,
                    [{ multipv: parsed.multipv, score: parsed.boundedScore, bound: parsed.bound, pvUci: parsed.pvUci!,
                        depth: parsed.depth, nodes: parsed.nodes, timeMs: parsed.timeMs, wdl: parsed.wdl }], this.sessionId);
                if (snapshot) {
                    job.snapshotIndex++;
                    job.snapshots = retainAnalysisSnapshots([...job.snapshots, snapshot]);
                    try { job.limit.onSnapshot?.(structuredClone(snapshot)); }
                    catch (error) { this.stopAndReject(job, error instanceof Error ? error : new Error(String(error))); return; }
                }
            }

            const depth = parsed.depth ?? job.latestDepth ?? 0;
            const linesAtDepth =
                job.linesByDepth.get(depth) ?? new Map<number, MultiPvLine>();
            const previous = linesAtDepth.get(parsed.multipv);
            if (
                parsed.score &&
                parsed.depth != null &&
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
                const completeLines = Array.from(linesAtDepth.values()).sort((a, b) => a.multipv - b.multipv);
                if (isStructurallyCompleteMultiPvBundle(completeLines, job.multiPv, job.context.rootMoves ?? job.context.legalRootMoves) && (!job.completeSnapshot || depth >= job.completeSnapshot.depth)) {
                    job.completeSnapshot = { depth, lines: completeLines };
                    const previousSnapshot = job.snapshots.findLast(snapshot => snapshot.bundleComplete);
                    const semanticBundle = (lines: MultiPvLine[]) => JSON.stringify(lines.map(line => [line.multipv, line.score, line.wdl, line.pvUci, line.depth]));
                    if (!previousSnapshot || semanticBundle(completeLines) !== semanticBundle(previousSnapshot.lines)
                        || completeLines.some(line => job.boundLines.has(line.pvUci[0]))) {
                        const snapshot = createAnalysisSnapshot(job.id, job.snapshotIndex, this.identity, job.context, job.limit, completeLines, this.sessionId);
                        if (snapshot) {
                            job.snapshotIndex += 1;
                            job.snapshots.push(snapshot);
                            job.snapshots = retainAnalysisSnapshots(job.snapshots);
                            for (const line of completeLines) job.boundLines.delete(line.pvUci[0]);
                            try {
                                job.limit.onSnapshot?.(structuredClone(snapshot));
                            } catch (error) {
                                this.stopAndReject(job, error instanceof Error ? error : new Error(String(error)));
                                return;
                            }
                        }
                    }
                    // Keep protocol buckets bounded independently of retained observations.
                    for (const key of job.linesByDepth.keys()) if (key < depth - 2) job.linesByDepth.delete(key);
                }
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
                    job.multiPv,
                    job.context.rootMoves ?? job.context.legalRootMoves
                );
            });
            const selectedBucket =
                completeBucket ??
                depthBuckets.find(([, linesAtDepth]) =>
                    linesAtDepth.has(1)
                );
            let lines = Array.from(
                selectedBucket?.[1].values() ?? []
            ).sort((a, b) => a.multipv - b.multipv);
            if (job.completeSnapshot && (!completeBucket || job.completeSnapshot.depth >= completeBucket[0])) lines = job.completeSnapshot.lines;
            const legalRoots = job.context.rootMoves ?? job.context.legalRootMoves;
            if (lines.some((line) => !legalRoots.includes(line.pvUci[0] ?? ''))) lines = [];
            if (lines.length === 0) {
                const terminalFallback = legalRoots.includes(job.bestMoveUci) ? exactMateInOneFallback(job) : null;
                if (!terminalFallback && job.boundLines.size > 0) {
                    job.resolve({ fen: job.fen, bestMoveUci: '', lines: [], snapshots: structuredClone(job.snapshots), boundLines: Array.from(job.boundLines.values()), alternativesComplete: false, identity: this.identity, searchEvidence: createSearchEvidence(job.id, this.identity, job.context, job.limit, { nodes: job.latestNodes, timeMs: job.latestTimeMs }, this.sessionId) });
                } else if (!terminalFallback) {
                    job.reject(new ExactPvUnavailableError());
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
                        searchEvidence: createSearchEvidence(job.id, this.identity, job.context, job.limit, { nodes: job.latestNodes, timeMs: job.latestTimeMs }, this.sessionId),
                    });
                }
            } else {
                job.resolve({
                    fen: job.fen,
                    bestMoveUci:
                        lines.find((candidate) => candidate.multipv === 1)
                            ?.pvUci[0] ||
                        '',
                    lines,
                    snapshots: structuredClone(job.snapshots),
                    boundLines: Array.from(job.boundLines.values()),
                    alternativesComplete: isStructurallyCompleteMultiPvBundle(lines, job.multiPv, legalRoots),
                    identity: {
                        ...this.identity,
                        options: {
                            ...this.identity.options,
                            MultiPV: job.multiPv,
                        },
                    },
                    searchEvidence: createSearchEvidence(job.id, this.identity, job.context, job.limit, { nodes: job.latestNodes, timeMs: job.latestTimeMs }, this.sessionId),
                });
            }
        }
        this.clearActive();
    }
}
