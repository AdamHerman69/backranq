import { atomicJson } from './io';
import type { Attempt, Meter } from './records';
import type { AnalysisLimit, EvalResult, MultiPvResult, StockfishEngine } from '@/lib/analysis/stockfishClient';

export class StudyLimitError extends Error {}

export function createMeteredEngine(engine: StockfishEngine, journalPath: string, attempt: Attempt,
    children = { cpuSeconds: () => 0, maxRssBytes: () => 0 }) {
    const began = performance.now();
    let blocked: string | null = null;
    const seen = new Set<string>();
    const refresh = () => {
        // A worker is a fresh process for one job: include module/startup CPU too.
        const cpu = process.cpuUsage();
        attempt.meter.cpuSeconds = (cpu.user + cpu.system) / 1e6 + children.cpuSeconds();
        attempt.meter.wallMs = performance.now() - began;
        attempt.meter.maxRssBytes = Math.max(attempt.meter.maxRssBytes, process.resourceUsage().maxRSS * 1024 + children.maxRssBytes());
        if (attempt.meter.cpuSeconds >= attempt.cpuAllowance) blocked = 'CPU_LIMIT';
        atomicJson(journalPath, attempt);
        if (blocked) engine.cancelAll?.();
    };
    const timer = setInterval(refresh, 500);
    timer.unref();
    const query = async <T extends EvalResult | MultiPvResult>(opts: AnalysisLimit, run: () => Promise<T>) => {
        if (blocked) throw new StudyLimitError(blocked);
        if (!Number.isSafeInteger(opts.nodes) || opts.nodes! <= 0) throw new Error('Study requires a positive node budget on every query');
        if (attempt.meter.requestedNodes + opts.nodes! > attempt.nodeAllowance) {
            blocked = 'NODE_LIMIT'; refresh(); throw new StudyLimitError(blocked);
        }
        // Durable reservation before dispatch: killed/failed work is never free on resume.
        attempt.meter.requestedNodes += opts.nodes!;
        attempt.meter.queries++;
        refresh();
        if (blocked) throw new StudyLimitError(blocked);
        try {
            const result = await run();
            const evidence = result.searchEvidence;
            if (evidence?.reused || evidence?.source === 'RULE') {
                attempt.meter.requestedNodes -= opts.nodes!;
            } else if (evidence && !seen.has(evidence.id)) {
                seen.add(evidence.id);
                attempt.meter.physicalSearches++;
                attempt.meter.reportedNodes += evidence.reported.nodes;
                attempt.meter.reportedEngineMs += evidence.reported.timeMs;
            }
            refresh();
            return result;
        } catch (error) {
            refresh();
            throw error;
        }
    };
    return {
        engine: {
            evalPosition: opts => query(opts, () => engine.evalPosition(opts)),
            analyzeMultiPv: opts => query(opts, () => engine.analyzeMultiPv(opts)),
            getIdentity: engine.getIdentity?.bind(engine),
            cancelAll: engine.cancelAll?.bind(engine),
            terminate: engine.terminate?.bind(engine),
        } satisfies StockfishEngine,
        finish(state: Attempt['state'], error?: string): Meter {
            clearInterval(timer);
            attempt.state = blocked ? 'CENSORED' : state;
            attempt.error = blocked ?? error;
            refresh();
            if (blocked) { attempt.state = 'CENSORED'; attempt.error = blocked; atomicJson(journalPath, attempt); }
            return structuredClone(attempt.meter);
        },
        blocked: () => blocked,
    };
}

export function emptyMeter(): Meter {
    return { requestedNodes: 0, reportedNodes: 0, reportedEngineMs: 0, queries: 0,
        physicalSearches: 0, cpuSeconds: 0, wallMs: 0, maxRssBytes: 0 };
}
