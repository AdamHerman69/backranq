import type { AnalysisSnapshot, SearchEvidence } from './stockfishClient';

export const ANALYSIS_WORK_REASONS = ['SCAN', 'MISSING_REFERENCE', 'VERIFY_REFERENCE', 'MISSING_MOVE', 'UNSTABLE_QUALITY',
    'REFERENCE_DRIFT', 'OPTIONAL_COVERAGE', 'CONTINUATION'] as const;
export type AnalysisWorkReason = typeof ANALYSIS_WORK_REASONS[number];
export const ANALYSIS_WORK_PRIORITY = {
    SUBMITTED_QUALITY: 0, REQUIRED_REFERENCE: 1, SUBMITTED_DETAIL: 2,
    OPEN_WARMUP: 3, OPTIONAL_COVERAGE: 4, EXPLANATION: 5,
} as const;
export type AnalysisWorkPriority = keyof typeof ANALYSIS_WORK_PRIORITY;
export type AnalysisWorkIdentity = {
    id: string;
    generation: number;
    contextId: string;
    frameId: string | null;
    attemptId: string | null;
};
export type AnalysisWorkSpec = AnalysisWorkIdentity & {
    reason: AnalysisWorkReason;
    /** IDs name existing evidence or an explicit missing dependency, e.g. missing:reference:context. */
    evidenceDependencies: string[];
    priority: AnalysisWorkPriority;
    nodes: number;
    /** Optional per-job cap; the global wall deadline always wins. */
    timeoutMs?: number;
};
export type AnalysisWorkContext = {
    signal: AbortSignal;
    nodes: number;
    timeoutMs: number;
    onSnapshot(snapshot: AnalysisSnapshot): void;
};
export type AnalysisWorkTrace = AnalysisWorkSpec & {
    status: 'QUEUED' | 'RUNNING' | 'DONE' | 'CANCELLED' | 'BUDGET_EXHAUSTED' | 'FAILED';
    requestedNodes: number;
    reportedNodes: number;
    elapsedMs: number;
    physicalSearchIds: string[];
};

type QueuedWork = {
    spec: AnalysisWorkSpec;
    trace: AnalysisWorkTrace;
    run(context: AnalysisWorkContext): Promise<{ searchEvidence?: SearchEvidence }>;
    onSnapshot?: (snapshot: AnalysisSnapshot) => void;
    resolve(value: { searchEvidence?: SearchEvidence }): void;
    reject(error: Error): void;
};

/** One engine lane, cumulative reservations and a wall deadline that includes queue/startup/retry. */
export class AnalysisWorkPlanner {
    private queue: QueuedWork[] = [];
    private active: { work: QueuedWork; controller: AbortController } | null = null;
    private traces: AnalysisWorkTrace[] = [];
    private generation = 0;
    private reservedNodes = 0;
    private seenSearches = new Map<string, number>();
    private reportedNodes = 0;
    private scheduled = false;
    private readonly startedAt: number;
    private readonly now: () => number;
    private readonly maxNodes: number;
    private readonly maxWallMs: number;

    constructor(options: { maxNodes: number; maxWallMs: number; generation?: number; now?: () => number }) {
        if (!Number.isInteger(options.maxNodes) || options.maxNodes < 0 || !Number.isFinite(options.maxWallMs) || options.maxWallMs < 0) throw new Error('Invalid cumulative analysis budget');
        this.maxNodes = options.maxNodes;
        this.maxWallMs = options.maxWallMs;
        this.generation = options.generation ?? 0;
        this.now = options.now ?? (() => performance.now());
        this.startedAt = this.now();
    }

    get currentGeneration(): number { return this.generation; }
    get remainingNodes(): number { return Math.max(0, this.maxNodes - this.reservedNodes); }
    get remainingWallMs(): number { return Math.max(0, this.maxWallMs - (this.now() - this.startedAt)); }
    get hasSubmittedWork(): boolean {
        return [...this.queue, ...(this.active ? [this.active.work] : [])]
            .some((work) => work.spec.priority === 'SUBMITTED_QUALITY');
    }
    report() {
        return { requestedNodes: this.reservedNodes, reportedNodes: this.reportedNodes,
            physicalSearches: this.seenSearches.size, elapsedMs: this.now() - this.startedAt,
            jobs: structuredClone(this.traces) };
    }

    enqueue<T extends { searchEvidence?: SearchEvidence }>(
        spec: AnalysisWorkSpec,
        run: (context: AnalysisWorkContext) => Promise<T>,
        onSnapshot?: (snapshot: AnalysisSnapshot) => void,
    ): Promise<T> {
        if (!ANALYSIS_WORK_REASONS.includes(spec.reason) || !(spec.priority in ANALYSIS_WORK_PRIORITY)
            || !spec.id || !spec.contextId || !spec.evidenceDependencies.length || spec.evidenceDependencies.some((id) => !id)
            || !Number.isInteger(spec.nodes) || spec.nodes <= 0
            || (spec.timeoutMs != null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0))) {
            return Promise.reject(new Error('Analysis work requires a reason, evidence dependency and bounded node request'));
        }
        if (spec.generation !== this.generation) return Promise.reject(new Error('Stale analysis generation'));
        if (this.traces.some((trace) => trace.id === spec.id)) return Promise.reject(new Error('Duplicate analysis work ID'));
        const trace: AnalysisWorkTrace = { ...structuredClone(spec), status: 'QUEUED', requestedNodes: 0,
            reportedNodes: 0, elapsedMs: 0, physicalSearchIds: [] };
        this.traces.push(trace);
        const promise = new Promise<T>((resolve, reject) => {
            this.queue.push({ spec: structuredClone(spec), trace, run, onSnapshot,
                resolve: (value) => resolve(value as T), reject });
        });
        this.queue.sort((a, b) => ANALYSIS_WORK_PRIORITY[a.spec.priority] - ANALYSIS_WORK_PRIORITY[b.spec.priority]);
        // Only optional work is preempted; the stop belongs to this job's AbortSignal,
        // never a global cancelAll capable of cancelling a newer engine generation.
        if (ANALYSIS_WORK_PRIORITY[spec.priority] <= 1 && this.active
            && ANALYSIS_WORK_PRIORITY[this.active.work.spec.priority] >= 3) this.active.controller.abort();
        this.schedule();
        return promise;
    }

    cancelGeneration(): number {
        this.generation += 1;
        for (const work of this.queue.splice(0)) {
            work.trace.status = 'CANCELLED';
            work.reject(new Error('Analysis generation cancelled'));
        }
        this.active?.controller.abort();
        return this.generation;
    }

    cancelOptional(): void {
        this.queue = this.queue.filter((work) => {
            if (ANALYSIS_WORK_PRIORITY[work.spec.priority] < 3) return true;
            work.trace.status = 'CANCELLED';
            work.reject(new Error('Optional analysis cancelled'));
            return false;
        });
        if (this.active && ANALYSIS_WORK_PRIORITY[this.active.work.spec.priority] >= 3) this.active.controller.abort();
    }

    private schedule() {
        if (this.scheduled || this.active) return;
        this.scheduled = true;
        queueMicrotask(() => { this.scheduled = false; void this.pump(); });
    }

    private async pump() {
        if (this.active) return;
        const work = this.queue.shift();
        if (!work) return;
        if (work.spec.generation !== this.generation) {
            work.trace.status = 'CANCELLED'; work.reject(new Error('Stale analysis generation')); this.schedule(); return;
        }
        const timeoutMs = Math.min(this.remainingWallMs, work.spec.timeoutMs ?? Infinity);
        if (work.spec.nodes > this.remainingNodes || timeoutMs <= 0) {
            work.trace.status = 'BUDGET_EXHAUSTED'; work.reject(new Error('Cumulative analysis budget exhausted')); this.schedule(); return;
        }
        this.reservedNodes += work.spec.nodes;
        work.trace.requestedNodes = work.spec.nodes;
        work.trace.status = 'RUNNING';
        const controller = new AbortController();
        this.active = { work, controller };
        const started = this.now();
        let timedOut = false;
        const account = (evidence?: SearchEvidence) => {
            if (evidence?.source !== 'ENGINE' || evidence.reused) return;
            const previous = this.seenSearches.get(evidence.id) ?? 0;
            const nodes = Math.max(previous, evidence.reported.nodes);
            this.seenSearches.set(evidence.id, nodes);
            this.reportedNodes += nodes - previous;
            work.trace.reportedNodes += nodes - previous;
            if (!work.trace.physicalSearchIds.includes(evidence.id)) work.trace.physicalSearchIds.push(evidence.id);
        };
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            // Even an uncooperative runtime must release the caller. Keep the lane
            // occupied until it settles so no physical searches overlap.
            work.reject(new Error('Cumulative analysis wall budget exhausted'));
        }, timeoutMs);
        try {
            const result = await work.run({ signal: controller.signal, nodes: work.spec.nodes, timeoutMs,
                onSnapshot: (snapshot) => {
                    account(snapshot.searchEvidence);
                    if (!controller.signal.aborted && work.spec.generation === this.generation) work.onSnapshot?.(snapshot);
                } });
            account(result.searchEvidence);
            if (this.now() - started >= timeoutMs) { timedOut = true; controller.abort(); }
            if (controller.signal.aborted || work.spec.generation !== this.generation) {
                work.trace.status = timedOut ? 'BUDGET_EXHAUSTED' : 'CANCELLED';
                work.reject(new Error(timedOut ? 'Cumulative analysis wall budget exhausted' : 'Analysis work cancelled'));
            } else {
                work.trace.status = 'DONE'; work.resolve(result);
            }
        } catch (error) {
            work.trace.status = timedOut ? 'BUDGET_EXHAUSTED' : controller.signal.aborted ? 'CANCELLED' : 'FAILED';
            work.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
            clearTimeout(timer);
            work.trace.elapsedMs = this.now() - started;
            this.active = null;
            this.schedule();
        }
    }
}
