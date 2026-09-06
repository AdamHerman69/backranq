import { STOCKFISH_BROWSER_WORKER_URL } from '@/lib/analysis/stockfishMetadata';
import { Chess } from 'chess.js';
import { ruleTerminalEvaluation } from './ruleEvaluation';

export type SearchReusePolicy = 'FRESH_REQUIRED' | 'REUSE_ALLOWED';
export type RuleTerminalOutcome = {
    kind: 'CHECKMATE' | 'STALEMATE' | 'INSUFFICIENT_MATERIAL' | 'FIFTY_MOVE_RULE' | 'THREEFOLD_REPETITION' | 'SEVENTY_FIVE_MOVE_RULE' | 'FIVEFOLD_REPETITION';
    outcome: 'LOSS' | 'DRAW';
    pov: 'SIDE_TO_MOVE';
};
export type SearchEvidence = {
    id: string;
    source: 'ENGINE' | 'RULE';
    engine: EngineIdentity;
    request: {
        fen: string;
        rootMoves: string[];
        previousFens: string[];
        historyMode: 'FEN_ONLY' | 'REPLAY';
        purpose: string;
        multiPv: number;
        limits: { nodes?: number; depth?: number; movetimeMs?: number };
    };
    reported: { nodes: number; timeMs: number };
    reused: boolean;
};

export type Score =
    | { type: 'cp'; value: number }
    | { type: 'mate'; value: number };

export type BoundedEngineLine = {
    moveUci: string;
    score: Score;
    bound: 'UPPER' | 'LOWER';
    depth?: number;
    nodes?: number;
    timeMs?: number;
};

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
    rootMoves?: readonly string[];
    previousFens?: readonly string[];
    reuse?: SearchReusePolicy;
    purpose?: string;
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
    boundLines?: BoundedEngineLine[];
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
    terminal?: RuleTerminalOutcome;
    searchEvidence?: SearchEvidence;
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
    /** Bounds retain their direction and are never exact scoring lines. */
    boundLines?: BoundedEngineLine[];
    terminal?: RuleTerminalOutcome;
    searchEvidence?: SearchEvidence;
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

export function normalizeRestrictedRootMoves(
    value: readonly string[] | undefined,
    fen?: string
): string[] | undefined {
    if (value == null) return undefined;
    if (value.length === 0 || value.length > 256) {
        throw new Error(
            'Restricted Stockfish search requires a nonempty legal root scope of at most 256 moves.'
        );
    }
    const seen = new Set<string>();
    const legal = fen == null ? null : new Set(new Chess(fen).moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''}`));
    return value.map((rawMove) => {
        const move = rawMove.trim().toLowerCase();
        if (!ROOT_UCI_RE.test(move) || seen.has(move) || (legal && !legal.has(move))) {
            throw new Error(
                'Restricted Stockfish root moves must be unique, exact legal UCI moves.'
            );
        }
        seen.add(move);
        return move;
    }).sort();
}

export type EngineSearchContext = {
    fen: string;
    previousFens: string[];
    legalRootMoves: string[];
    rootMoves?: string[];
    positionCommand: string;
    terminal?: RuleTerminalOutcome;
};

const historyCommands = new Map<string, string>();

/** Validate the entire historical scope before it can become engine evidence. */
export function resolveEngineSearchContext(opts: AnalysisLimit & { fen: string }): EngineSearchContext {
    const chess = new Chess(opts.fen);
    const fen = chess.fen();
    const previousFens = [...(opts.previousFens ?? [])].map((value) => new Chess(value).fen());
    const rootMoves = normalizeRestrictedRootMoves(opts.rootMoves, fen);
    const legalRootMoves = chess.moves({ verbose: true }).map((move) => `${move.from}${move.to}${move.promotion ?? ''}`).sort();
    const historyKey = JSON.stringify([previousFens, fen]);
    let positionCommand = historyCommands.get(historyKey);
    if (!positionCommand) {
        if (previousFens.length === 0) positionCommand = `position fen ${fen}`;
        else {
            // Adjacent scan positions share an already-validated replay. Reuse
            // only the exact canonical prefix, then validate its new transition.
            const prefixCommand = historyCommands.get(JSON.stringify([
                previousFens.slice(0, -1), previousFens.at(-1),
            ]));
            const replay = new Chess(prefixCommand ? previousFens.at(-1)! : previousFens[0]);
            const moves: string[] = [];
            for (const nextFen of prefixCommand ? [fen] : [...previousFens.slice(1), fen]) {
                const move = replay.moves({ verbose: true }).find((candidate) => candidate.after === nextFen);
                if (!move) throw new Error('Engine history does not legally replay to the requested position');
                moves.push(`${move.from}${move.to}${move.promotion ?? ''}`);
                replay.move({ from: move.from, to: move.to, promotion: move.promotion });
            }
            positionCommand = prefixCommand
                ? `${prefixCommand}${previousFens.length === 1 ? ' moves' : ''} ${moves.join(' ')}`
                : `position fen ${previousFens[0]} moves ${moves.join(' ')}`;
        }
        historyCommands.set(historyKey, positionCommand);
        if (historyCommands.size > 128) historyCommands.delete(historyCommands.keys().next().value!);
    }
    const terminal = ruleTerminalEvaluation(fen, previousFens)?.terminal;
    return { fen, previousFens, rootMoves, legalRootMoves, positionCommand, ...(terminal ? { terminal } : {}) };
}

export function engineSearchCacheKey(context: EngineSearchContext, opts: AnalysisLimit & { cacheKey?: string }, multiPv: number): string {
    return JSON.stringify([opts.cacheKey ?? '', context.fen, context.previousFens, context.rootMoves ?? null, opts.nodes ?? null, opts.depth ?? null, opts.movetimeMs ?? null, multiPv]);
}

export function resolvedEngineLimit<T extends AnalysisLimit>(opts: T, defaultNodes = 100_000): T {
    const positiveInteger = (value: number) => {
        if (!Number.isFinite(value)) throw new Error('Engine budget must be finite');
        return Math.max(1, Math.trunc(value));
    };
    const nodes = opts.nodes != null ? positiveInteger(opts.nodes) : opts.depth == null && opts.movetimeMs == null ? positiveInteger(defaultNodes) : undefined;
    const depth = nodes == null && opts.depth != null ? positiveInteger(opts.depth) : undefined;
    const movetimeMs = nodes == null && depth == null && opts.movetimeMs != null ? positiveInteger(opts.movetimeMs) : undefined;
    return { ...opts, nodes, depth, movetimeMs };
}

export function createSearchEvidence(id: string, engine: EngineIdentity, context: EngineSearchContext, opts: AnalysisLimit & { multiPv?: number }, reported: { nodes?: number; timeMs?: number } = {}): SearchEvidence {
    return { id, source: 'ENGINE', engine: { ...engine, options: { ...engine.options } }, request: { fen: context.fen, rootMoves: [...(context.rootMoves ?? context.legalRootMoves)], previousFens: context.previousFens, historyMode: context.previousFens.length ? 'REPLAY' : 'FEN_ONLY', purpose: opts.purpose ?? 'UNSPECIFIED', multiPv: opts.multiPv ?? 1, limits: { ...(opts.nodes != null ? { nodes: opts.nodes } : {}), ...(opts.depth != null ? { depth: opts.depth } : {}), ...(opts.movetimeMs != null ? { movetimeMs: opts.movetimeMs } : {}) } }, reported: { nodes: reported.nodes ?? 0, timeMs: reported.timeMs ?? 0 }, reused: false };
}

export function terminalEngineResult(context: EngineSearchContext, evidence: SearchEvidence): MultiPvResult | null {
    if (!context.terminal) return null;
    return { fen: context.fen, bestMoveUci: '', lines: [], alternativesComplete: true, terminal: context.terminal, identity: evidence.engine, searchEvidence: { ...evidence, source: 'RULE' } };
}

/**
 * Structural adapter-level proof only. The continuation verifier separately
 * replays every root move against the FEN and decides whether the evaluation
 * frontier is outside the grading tolerance.
 */
export function isStructurallyCompleteMultiPvBundle(
    lines: readonly MultiPvLine[],
    requestedMultiPv: number,
    legalRootMoves?: readonly string[]
): boolean {
    const requested = Math.max(
        1,
        Math.min(16, Math.trunc(requestedMultiPv))
    );
    const expected = legalRootMoves ? Math.min(requested, legalRootMoves.length) : requested;
    if (lines.length !== expected) return false;

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
            || (legalRootMoves && !legalRootMoves.includes(rootMove))
            || !Number.isFinite(line.score.value)
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
              context: EngineSearchContext;
              limit: AnalysisLimit & { multiPv?: number };
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
        this.ensureWorker();
    }

    private ensureWorker() {
        if (this.terminated) throw new Error('Engine terminated');
        if (this.worker) return;
        this.worker = new Worker(STOCKFISH_BROWSER_WORKER_URL);
        this.debugLog('worker created');
        this.worker.onmessage = (ev: MessageEvent) => {
            this.onWorkerMessage(ev.data);
        };
        this.worker.onerror = (ev: ErrorEvent) => {
            const msg = ev?.message || 'Stockfish worker crashed unexpectedly';
            this.debugLog('worker error', msg);
            const failedWorker = this.worker;
            this.worker = null;
            failedWorker?.terminate();
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
        this.ensureWorker();
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

    async evalPosition(opts: AnalysisLimit & { fen: string; cacheKey?: string }): Promise<EvalResult> {
        const result = await this.analyzeMultiPv({ ...opts, multiPv: 1 });
        const first = result.lines[0];
        if (!first && !result.terminal) throw new Error('Engine returned no exact PV');
        return { fen: result.fen, bestMoveUci: first?.pvUci[0] ?? result.bestMoveUci, pvUci: first?.pvUci ?? [], score: result.terminal ? { type: result.terminal.outcome === 'LOSS' ? 'mate' : 'cp', value: 0 } : first?.score ?? null, wdl: result.terminal ? { win: 0, draw: result.terminal.outcome === 'DRAW' ? 1000 : 0, loss: result.terminal.outcome === 'LOSS' ? 1000 : 0 } : first?.wdl, depth: first?.depth, selDepth: first?.selDepth, nodes: result.searchEvidence?.reported.nodes ?? first?.nodes, nps: first?.nps, timeMs: result.searchEvidence?.reported.timeMs ?? first?.timeMs, terminal: result.terminal, searchEvidence: result.searchEvidence };
    }

    async analyzeMultiPv(opts: AnalysisLimit & {
        fen: string;
        multiPv?: number;
        cacheKey?: string;
        rootMoves?: readonly string[];
    }): Promise<MultiPvResult> {
        this.ensureWorker();
        if (opts.signal?.aborted) throw new Error('Analysis aborted');
        const context = resolveEngineSearchContext(opts);
        const normalizedLimit = resolvedEngineLimit(opts);
        const { nodes, depth, movetimeMs } = normalizedLimit;
        const rootMoves = context.rootMoves;
        const multiPv = Math.max(
            1,
            Math.min(
                16,
                rootMoves?.length ?? 16,
                Math.trunc(opts.multiPv ?? 1)
            )
        );

        const limit = { ...normalizedLimit, multiPv };
        const key = engineSearchCacheKey(context, { ...limit, cacheKey: opts.cacheKey }, multiPv);
        const cached = this.cacheMulti.get(key);
        if (cached && opts.reuse === 'REUSE_ALLOWED') {
            return { ...cached, searchEvidence: cached.searchEvidence ? { ...cached.searchEvidence, reused: true } : undefined };
        }

        const id = uid();
        const terminal = terminalEngineResult(context, createSearchEvidence(id, this.identity, context, limit));
        if (terminal) return terminal;
        const p = new Promise<MultiPvResult>((resolve, reject) => {
            this.pending.set(id, {
                kind: 'multipv',
                requestedMultiPv: multiPv,
                context,
                limit,
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
                rootMoves,
            });
            this.worker?.postMessage({
                type: 'start',
                id,
                fen: context.fen,
                positionCommand: context.positionCommand,
                legalRootMoves: rootMoves ?? context.legalRootMoves,
                multiPv,
                maxNodes: nodes,
                maxDepth: depth,
                maxTimeMs: movetimeMs,
                emitIntervalMs: 120,
                rootMoves,
            });
        });

        const res = await p;
        this.cacheMulti.set(key, res);
        if (this.cacheMulti.size > 256) this.cacheMulti.delete(this.cacheMulti.keys().next().value!);
        return res;
    }

    startAnalyzeMultiPvStreaming(opts: {
        fen: string;
        multiPv: number; // 1..16
        minDepth?: number;
        maxDepth?: number;
        maxTimeMs?: number;
        emitIntervalMs?: number;
        onUpdate(u: MultiPvStreamingUpdate): void;
        onError?(e: Error): void;
        onDone?(): void;
    }): StreamingAnalysisHandle {
        this.ensureWorker();
        const id = uid();
        const multiPv = Math.max(1, Math.min(16, Math.trunc(opts.multiPv)));
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
                    const legalRootMoves = p.context.rootMoves ?? p.context.legalRootMoves;
                    const boundLines = (latest.boundLines ?? []).filter((line) => legalRootMoves.includes(line.moveUci) && Number.isFinite(line.score.value));
                    if (latest.fen !== p.context.fen || (lines.length === 0 && boundLines.length === 0) || lines.some((line) => !line.score || !legalRootMoves.includes(line.pvUci[0]))) {
                        p.reject(new Error('Engine returned no valid exact PV in the requested root scope'));
                        if (this.activeJobId === id) this.activeJobId = null;
                        return;
                    }
                    p.resolve({
                        fen: latest.fen,
                        bestMoveUci: lines[0]?.pvUci[0] ?? '',
                        lines,
                        boundLines,
                        alternativesComplete:
                            isStructurallyCompleteMultiPvBundle(
                                lines,
                                p.requestedMultiPv,
                                legalRootMoves
                            ),
                        identity: this.identity,
                        searchEvidence: createSearchEvidence(id, this.identity, p.context, p.limit, { nodes: latest.nodes, timeMs: latest.timeMs }),
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
