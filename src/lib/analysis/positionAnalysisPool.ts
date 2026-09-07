import {
    createAnalysisSnapshot,
    createBoundAnalysisSnapshot,
    retainAnalysisSnapshots,
    resolveEngineSearchContext,
    type AnalysisSnapshot,
    type EngineIdentity,
    type EngineSearchContext,
    type EvalResult,
    type MultiPvLine,
    type MultiPvResult,
    type SearchEvidence,
    type StockfishEngine,
} from './stockfishClient';

/** Compute compatibility excludes provenance, purpose, budget and per-search root selection. */
export function analysisEngineFingerprint(engine: EngineIdentity): string {
    if (typeof engine.artifactId !== 'string' || !engine.artifactId.trim()) throw new Error('Engine requires an artifact identity');
    const options = Object.entries(engine.options).filter(([key]) => key !== 'MultiPV').sort(([a], [b]) => a.localeCompare(b));
    return JSON.stringify([engine.name, engine.version ?? null, engine.flavor ?? null, engine.artifactId,
        engine.evalFile ?? null, options]);
}

export function analysisContextKey(fen: string, previousFens: readonly string[] = []): string {
    const context = resolveEngineSearchContext({ fen, previousFens });
    return JSON.stringify(['STANDARD_CHESS', context.fen, context.previousFens]);
}

export type PooledSearch = {
    evidence: SearchEvidence;
    /** Complete physical iterations, at most the last three plus explicitly retained snapshots. */
    snapshots: AnalysisSnapshot[];
    /** The final bundle may be partial; it never creates a made-up iteration. */
    result: MultiPvResult | null;
};

export type PoolQueryCost = { queries: number; reusedQueries: number; failedQueries: number; unattributedFailedQueries: number; unattributedFailedRequestedNodes: number };
export type PoolPhysicalCost = { id: string; reason: string; requestedNodes: number; reportedNodes: number; reportedTimeMs: number };
export type PoolCostTotals = PoolQueryCost & { physicalSearches: number; requestedNodes: number; reportedNodes: number; reportedTimeMs: number };
export type PositionAnalysisPoolState = { version: 2; searches: PooledSearch[]; retainedSnapshotIds: string[];
    cost: { queriesByReason: Record<string, PoolQueryCost>; searches: PoolPhysicalCost[] } };
const emptyQueryCost = (): PoolQueryCost => ({ queries: 0, reusedQueries: 0, failedQueries: 0, unattributedFailedQueries: 0, unattributedFailedRequestedNodes: 0 });
const emptyCost = (): PoolCostTotals => ({ ...emptyQueryCost(), physicalSearches: 0, requestedNodes: 0, reportedNodes: 0, reportedTimeMs: 0 });

export type PoolQuery = {
    fen: string;
    previousFens?: readonly string[];
    engine?: EngineIdentity;
    moveUci?: string;
    /** When supplied, require this exact search scope (not merely a matching move). */
    rootMoves?: readonly string[];
};

/** Bounded session evidence, not a second engine cache or a verdict authority. */
export class PositionAnalysisPool {
    private searches = new Map<string, PooledSearch>();
    private searchContextKeys = new Map<string, string>();
    /** Pure chess facts keyed by full input content, never by a claimed physical ID. */
    private normalizedContexts = new Map<string, EngineSearchContext>();
    private retained = new Set<string>();
    private contextOrder = new Map<string, number>();
    private sequence = 0;
    private evidenceGeneration = 0;
    get evidenceVersion(): number { return this.evidenceGeneration; }
    private costSearches = new Map<string, PoolPhysicalCost>();
    private queryCosts: Record<string, PoolQueryCost> = {};
    readonly maxCostSearches: number;
    readonly maxContexts: number;
    readonly maxSearches: number;

    constructor(options: { maxContexts?: number; maxSearches?: number; maxCostSearches?: number } = {}) {
        this.maxCostSearches = options.maxCostSearches ?? 8192;
        if (!Number.isInteger(this.maxCostSearches) || this.maxCostSearches < 1) throw new Error('Invalid cost ledger limit');
        this.maxContexts = options.maxContexts ?? 128;
        this.maxSearches = options.maxSearches ?? 2048;
        if (!Number.isInteger(this.maxContexts) || this.maxContexts < 1 || !Number.isInteger(this.maxSearches) || this.maxSearches < 1) throw new Error('Invalid analysis pool limits');
    }

    private recordCost(evidence: SearchEvidence): void {
        if (evidence.source !== 'ENGINE') return;
        const previous = this.costSearches.get(evidence.id);
        const requestedNodes = evidence.request.limits.nodes ?? 0;
        if (previous && (previous.reason !== evidence.request.purpose || previous.requestedNodes !== requestedNodes)) throw new Error('Physical cost identity changed');
        // A cache hit may import already-known evidence, but it performed no new work.
        if (!previous && evidence.reused) return;
        if (!previous && this.costSearches.size >= this.maxCostSearches) throw new Error('Analysis cost ledger capacity exhausted');
        this.costSearches.set(evidence.id, { id: evidence.id, reason: evidence.request.purpose, requestedNodes,
            reportedNodes: Math.max(previous?.reportedNodes ?? 0, evidence.reported.nodes),
            reportedTimeMs: Math.max(previous?.reportedTimeMs ?? 0, evidence.reported.timeMs) });
    }

    /** Query counters cover wrap calls; physical costs also cover directly ingested evidence. */
    report(): PoolCostTotals & { byReason: Record<string, PoolCostTotals> } {
        const byReason: Record<string, PoolCostTotals> = {};
        for (const [reason, queries] of Object.entries(this.queryCosts)) byReason[reason] = { ...emptyCost(), ...queries };
        for (const cost of this.costSearches.values()) {
            const total = byReason[cost.reason] ??= emptyCost();
            total.physicalSearches++; total.requestedNodes += cost.requestedNodes;
            total.reportedNodes += cost.reportedNodes; total.reportedTimeMs += cost.reportedTimeMs;
        }
        const total = emptyCost();
        for (const entry of Object.values(byReason)) for (const key of Object.keys(total) as Array<keyof PoolCostTotals>) total[key] += entry[key];
        return { ...total, byReason };
    }

    private context(fen: string, previousFens: readonly string[] = [], rootMoves?: readonly string[]): EngineSearchContext {
        const input = JSON.stringify([fen, previousFens, rootMoves ?? null]);
        const existing = this.normalizedContexts.get(input);
        if (existing) return existing;
        const context = resolveEngineSearchContext({ fen, previousFens, rootMoves });
        this.normalizedContexts.set(input, context);
        if (this.normalizedContexts.size > this.maxSearches) this.normalizedContexts.delete(this.normalizedContexts.keys().next().value!);
        return context;
    }

    private contextKey(fen: string, previousFens: readonly string[] = []): string {
        const context = this.context(fen, previousFens);
        return JSON.stringify(['STANDARD_CHESS', context.fen, context.previousFens]);
    }

    private key(evidence: SearchEvidence): string {
        return this.contextKey(evidence.request.fen, evidence.request.previousFens);
    }

    private ensure(evidence: SearchEvidence): PooledSearch {
        const fingerprint = analysisEngineFingerprint(evidence.engine);
        const existing = this.searches.get(evidence.id);
        if (existing) {
            if (this.searchContextKeys.get(evidence.id) !== this.key(evidence)
                || analysisEngineFingerprint(existing.evidence.engine) !== fingerprint
                || existing.evidence.engine.source !== evidence.engine.source
                || JSON.stringify(existing.evidence.request) !== JSON.stringify(evidence.request)) {
                throw new Error('Physical search ID reused for different engine/context/request');
            }
            return existing;
        }
        const key = this.key(evidence);
        this.contextOrder.set(key, ++this.sequence);
        // Evict an entire inactive context, never just the only evidence for one alternative.
        while (this.contextOrder.size > this.maxContexts || this.searches.size >= this.maxSearches) {
            const candidate = [...this.contextOrder.keys()].find((context) => context !== key
                && ![...this.searches.values()].some((search) => this.searchContextKeys.get(search.evidence.id) === context
                    && search.snapshots.some((snapshot) => this.retained.has(snapshot.id))));
            if (!candidate) throw new Error('Analysis pool capacity exhausted; checkpoint or release a context');
            for (const id of this.searches.keys()) if (this.searchContextKeys.get(id) === candidate) {
                this.searches.delete(id); this.searchContextKeys.delete(id);
            }
            this.contextOrder.delete(candidate);
        }
        const search: PooledSearch = { evidence: structuredClone({ ...evidence, reused: false }), snapshots: [], result: null };
        this.searches.set(evidence.id, search);
        this.searchContextKeys.set(evidence.id, key);
        return search;
    }

    recordSnapshot(snapshot: AnalysisSnapshot): boolean {
        if (snapshot.searchEvidence.source !== 'ENGINE' || snapshot.searchId !== snapshot.searchEvidence.id
            || snapshot.id !== `${snapshot.searchId}:snapshot:${snapshot.snapshotIndex}` || snapshot.fen !== snapshot.searchEvidence.request.fen) {
            throw new Error('Invalid physical snapshot identity');
        }
        const request = snapshot.searchEvidence.request;
        const context = this.context(request.fen, request.previousFens, request.rootMoves);
        const verified = snapshot.bundleComplete
            ? createAnalysisSnapshot(snapshot.searchId, snapshot.snapshotIndex, snapshot.searchEvidence.engine,
                context, { ...request.limits, multiPv: request.multiPv, purpose: request.purpose }, snapshot.lines)
            : createBoundAnalysisSnapshot(snapshot.searchId, snapshot.snapshotIndex, snapshot.searchEvidence.engine,
                context, { ...request.limits, multiPv: request.multiPv, purpose: request.purpose }, snapshot.lines);
        if (!verified || verified.depth !== snapshot.depth) throw new Error('Invalid analysis snapshot');
        this.recordCost(snapshot.searchEvidence);
        const search = this.ensure(snapshot.searchEvidence);
        const existing = search.snapshots.find((item) => item.id === snapshot.id);
        if (existing) {
            if (JSON.stringify(existing.lines) !== JSON.stringify(snapshot.lines) || existing.depth !== snapshot.depth) throw new Error('Observation ID changed its physical contents');
            return false;
        }
        search.snapshots.push(structuredClone(snapshot));
        this.evidenceGeneration++;
        search.snapshots.sort((a, b) => a.snapshotIndex - b.snapshotIndex);
        const retainedIds = new Set(retainAnalysisSnapshots(search.snapshots).map(item => item.id));
        search.snapshots = search.snapshots.filter(item => retainedIds.has(item.id) || this.retained.has(item.id));
        search.evidence.reported.nodes = Math.max(search.evidence.reported.nodes, snapshot.searchEvidence.reported.nodes);
        search.evidence.reported.timeMs = Math.max(search.evidence.reported.timeMs, snapshot.searchEvidence.reported.timeMs);
        return true;
    }

    recordResult(result: MultiPvResult | EvalResult): boolean {
        const evidence = result.searchEvidence;
        if (!evidence) return false;
        this.recordCost(evidence);
        const search = this.ensure(evidence);
        for (const snapshot of result.snapshots ?? []) this.recordSnapshot(evidence.reused ? { ...snapshot, searchEvidence: { ...snapshot.searchEvidence, reused: true } } : snapshot);
        if (search.result) return false;
        const lines: MultiPvLine[] = 'lines' in result ? result.lines : result.score && !result.terminal ? [{
            multipv: 1, pvUci: result.pvUci, score: result.score, wdl: result.wdl, depth: result.depth,
            nodes: result.nodes, timeMs: result.timeMs, selDepth: result.selDepth, nps: result.nps,
        }] : [];
        if (result.fen !== evidence.request.fen || lines.some((line) => !evidence.request.rootMoves.includes(line.pvUci[0]))) throw new Error('Analysis result outside physical search context');
        search.result = structuredClone('lines' in result ? result : {
            fen: result.fen, bestMoveUci: result.bestMoveUci, lines, terminal: result.terminal,
            searchEvidence: evidence, snapshots: result.snapshots,
        });
        // Snapshot retention is centralized; the final bundle does not duplicate the same data.
        delete search.result.snapshots;
        search.evidence = structuredClone({ ...evidence, reused: false });
        this.evidenceGeneration++;
        return true;
    }

    retainSnapshot(id: string): void {
        if (![...this.searches.values()].some((search) => search.snapshots.some((snapshot) => snapshot.id === id))) throw new Error('Cannot retain missing observation');
        this.retained.add(id);
    }

    find(query: PoolQuery): PooledSearch[] {
        // A fresh session has no local counterevidence; avoid replaying its full
        // history merely to prove that an empty pool contains no matches.
        if (this.searches.size === 0) return [];
        const context = this.contextKey(query.fen, query.previousFens);
        const fingerprint = query.engine ? analysisEngineFingerprint(query.engine) : null;
        const roots = query.rootMoves ? JSON.stringify([...query.rootMoves].sort()) : null;
        if (this.contextOrder.has(context)) { this.contextOrder.delete(context); this.contextOrder.set(context, ++this.sequence); }
        return [...this.searches.values()].filter((search) => this.searchContextKeys.get(search.evidence.id) === context
            && (!fingerprint || analysisEngineFingerprint(search.evidence.engine) === fingerprint)
            && (!roots || JSON.stringify([...search.evidence.request.rootMoves].sort()) === roots)
            && (!query.moveUci || search.result?.lines.some((line) => line.pvUci[0] === query.moveUci)
                || search.snapshots.some((snapshot) => snapshot.lines.some((line) => line.pvUci[0] === query.moveUci))))
            .map((search) => structuredClone(search));
    }

    serialize(): PositionAnalysisPoolState {
        return JSON.parse(JSON.stringify({ version: 2, searches: [...this.searches.values()], retainedSnapshotIds: [...this.retained], cost: { queriesByReason: this.queryCosts, searches: [...this.costSearches.values()] } })) as PositionAnalysisPoolState;
    }

    static hydrate(state: PositionAnalysisPoolState, options: { maxContexts?: number; maxSearches?: number; maxCostSearches?: number } = {}): PositionAnalysisPool {
        if (state.version !== 2 || !Array.isArray(state.searches) || !Array.isArray(state.retainedSnapshotIds) || !state.cost || !Array.isArray(state.cost.searches) || !state.cost.queriesByReason) throw new Error('Invalid analysis pool checkpoint');
        const pool = new PositionAnalysisPool(options);
        if (state.searches.length > pool.maxSearches) throw new Error('Analysis pool checkpoint exceeds capacity');
        for (const search of state.searches) {
            pool.ensure(search.evidence);
            for (const snapshot of search.snapshots) {
                pool.recordSnapshot(snapshot);
                if (state.retainedSnapshotIds.includes(snapshot.id)) pool.retainSnapshot(snapshot.id);
            }
            if (search.result) pool.recordResult(search.result);
        }
        for (const id of state.retainedSnapshotIds) pool.retainSnapshot(id);
        if (state.cost.searches.length > pool.maxCostSearches || new Set(state.cost.searches.map(cost => cost.id)).size !== state.cost.searches.length) throw new Error('Invalid cost ledger capacity or identity');
        for (const cost of state.cost.searches) if (!cost.id || typeof cost.reason !== 'string' || ![cost.requestedNodes, cost.reportedNodes, cost.reportedTimeMs].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid physical cost record');
        for (const query of Object.values(state.cost.queriesByReason)) if (Object.keys(emptyQueryCost()).some(key => !Number.isInteger(query[key as keyof PoolQueryCost]) || query[key as keyof PoolQueryCost] < 0)) throw new Error('Invalid query cost record');
        const restoredCosts = new Map(state.cost.searches.map(cost => [cost.id, structuredClone(cost)]));
        for (const cost of pool.costSearches.values()) {
            const saved = restoredCosts.get(cost.id);
            if (!saved || saved.reason !== cost.reason || saved.requestedNodes !== cost.requestedNodes || saved.reportedNodes < cost.reportedNodes || saved.reportedTimeMs < cost.reportedTimeMs) throw new Error('Checkpoint cost ledger omits retained physical work');
        }
        pool.costSearches = restoredCosts; pool.queryCosts = structuredClone(state.cost.queriesByReason);
        return pool;
    }

    /** Wrap once for a run: scan, confirmation and coverage all contribute without coupling stages. */
    wrap(engine: StockfishEngine): StockfishEngine {
        const query = async <T extends MultiPvResult | EvalResult>(options: Parameters<StockfishEngine['evalPosition']>[0],
            run: (onSnapshot: (snapshot: AnalysisSnapshot) => void) => Promise<T>): Promise<T> => {
            const reason = options.purpose ?? 'UNSPECIFIED';
            const counts = this.queryCosts[reason] ??= emptyQueryCost(); counts.queries++;
            let observedPhysical = false;
            try {
                const result = await run(snapshot => {
                    observedPhysical = true; this.recordSnapshot(snapshot); options.onSnapshot?.(snapshot);
                });
                if (result.searchEvidence?.reused) counts.reusedQueries++;
                this.recordResult(result); return result;
            } catch (error) {
                counts.failedQueries++;
                if (!observedPhysical) { counts.unattributedFailedQueries++; counts.unattributedFailedRequestedNodes += options.nodes ?? 0; }
                throw error;
            }
        };
        return {
            analyzeMultiPv: options => query(options, onSnapshot => engine.analyzeMultiPv({ ...options, onSnapshot })),
            evalPosition: options => query(options, onSnapshot => engine.evalPosition({ ...options, onSnapshot })),
            ...(engine.getIdentity ? { getIdentity: () => engine.getIdentity!() } : {}),
            ...(engine.cancelAll ? { cancelAll: () => engine.cancelAll!() } : {}),
            ...(engine.terminate ? { terminate: () => engine.terminate!() } : {}),
        };
    }
}
