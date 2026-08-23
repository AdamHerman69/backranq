import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { backranqQueueRegion } from '@/lib/queues/region';

type RequestTraceStore = {
    route: string;
    requestId: string;
    startedAt: number;
    coldStart: boolean;
    phases: Map<string, number>;
    dbOperationDurationSumMs: number;
    dbOperationCount: number;
};

export type RequestTraceSnapshot = {
    route: string;
    requestId: string;
    coldStart: boolean;
    functionRegion: string;
    queueRegion: string;
    status: number;
    totalDurationMs: number;
    dbOperationDurationSumMs: number;
    dbOperationCount: number;
    phases: Record<string, number>;
};

const traceStorage = new AsyncLocalStorage<RequestTraceStore>();
const PHASE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
let handledRequest = false;

function rounded(value: number): number {
    return Math.round(value * 100) / 100;
}

function region(value: string | undefined, fallback: string): string {
    const normalized = value?.trim();
    return normalized && /^[a-z0-9-]{2,20}$/i.test(normalized)
        ? normalized
        : fallback;
}

function performanceLogSampleRate(): number {
    const configured = Number(process.env.BACKRANQ_PERFORMANCE_SAMPLE_RATE);
    if (!Number.isFinite(configured)) return 1;
    return Math.min(1, Math.max(0, configured));
}

function shouldLogPerformance(): boolean {
    if (process.env.BACKRANQ_PERFORMANCE_LOGS === 'false') return false;
    if (
        process.env.BACKRANQ_PERFORMANCE_LOGS !== 'true' &&
        !process.env.VERCEL_ENV
    ) {
        return false;
    }
    return Math.random() < performanceLogSampleRate();
}

function snapshot(store: RequestTraceStore, status: number): RequestTraceSnapshot {
    return {
        route: store.route,
        requestId: store.requestId,
        coldStart: store.coldStart,
        functionRegion: region(process.env.VERCEL_REGION, 'local'),
        queueRegion: backranqQueueRegion(),
        status,
        totalDurationMs: rounded(performance.now() - store.startedAt),
        dbOperationDurationSumMs: rounded(
            store.dbOperationDurationSumMs
        ),
        dbOperationCount: store.dbOperationCount,
        phases: Object.fromEntries(
            [...store.phases.entries()].map(([name, duration]) => [
                name,
                rounded(duration),
            ])
        ),
    };
}

function serverTimingHeader(value: RequestTraceSnapshot): string {
    const timings = Object.entries(value.phases).map(
        ([name, duration]) => `${name};dur=${duration}`
    );
    timings.push(
        `db_ops_sum;dur=${value.dbOperationDurationSumMs}`
    );
    timings.push(`total;dur=${value.totalDurationMs}`);
    return timings.join(', ');
}

function attachTraceHeaders(response: Response, value: RequestTraceSnapshot) {
    response.headers.set('Server-Timing', serverTimingHeader(value));
    response.headers.set('X-Backranq-Request-Id', value.requestId);
    response.headers.set('X-Backranq-Function-Region', value.functionRegion);
    response.headers.set('X-Backranq-Queue-Region', value.queueRegion);
    response.headers.set(
        'X-Backranq-Cold-Start',
        value.coldStart ? '1' : '0'
    );
    response.headers.set(
        'X-Backranq-Db-Operation-Count',
        String(value.dbOperationCount)
    );
}

function logSnapshot(value: RequestTraceSnapshot, outcome: 'done' | 'failed') {
    if (!shouldLogPerformance()) return;
    const log = outcome === 'done' ? console.info : console.error;
    log(
        JSON.stringify({
            level: outcome === 'done' ? 'info' : 'error',
            event: 'request.performance',
            outcome,
            ...value,
        })
    );
}

export async function withRequestTrace(
    args: {
        route: string;
        request?: Request;
    },
    handler: () => Promise<Response>
): Promise<Response> {
    const coldStart = !handledRequest;
    handledRequest = true;
    const store: RequestTraceStore = {
        route: args.route,
        requestId:
            args.request?.headers.get('x-vercel-id')?.trim() || randomUUID(),
        startedAt: performance.now(),
        coldStart,
        phases: new Map(),
        dbOperationDurationSumMs: 0,
        dbOperationCount: 0,
    };

    return traceStorage.run(store, async () => {
        try {
            const response = await handler();
            const value = snapshot(store, response.status);
            attachTraceHeaders(response, value);
            logSnapshot(value, 'done');
            return response;
        } catch (error) {
            logSnapshot(snapshot(store, 500), 'failed');
            throw error;
        }
    });
}

export async function measureRequestPhase<T>(
    name: string,
    operation: () => Promise<T>
): Promise<T> {
    if (!PHASE_NAME.test(name)) {
        throw new Error(`Invalid request performance phase: ${name}`);
    }
    const store = traceStorage.getStore();
    if (!store) return operation();
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        store.phases.set(
            name,
            (store.phases.get(name) ?? 0) + performance.now() - startedAt
        );
    }
}

/**
 * Measures one Prisma client operation, not one emitted SQL statement. Parallel
 * operation durations are intentionally a sum and may exceed request wall time.
 */
export async function measurePrismaOperation<T>(
    operation: () => Promise<T>
): Promise<T> {
    const store = traceStorage.getStore();
    if (!store) return operation();
    const startedAt = performance.now();
    try {
        return await operation();
    } finally {
        store.dbOperationCount += 1;
        store.dbOperationDurationSumMs += performance.now() - startedAt;
    }
}

export function currentRequestTrace(): RequestTraceSnapshot | null {
    const store = traceStorage.getStore();
    return store ? snapshot(store, 200) : null;
}
