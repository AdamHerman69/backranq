export const ANALYSIS_COMPLETION_EVENT = 'backranq:analysis-complete';
export const LIBRARY_CHANGED_EVENT = 'backranq:library-changed';

const LAST_COMPLETION_PREFIX = 'backranq.analysis.lastCompletion.v2';
const SERVER_BATCH_PREFIX = 'backranq.analysis.serverBatch.v2';
const RECENT_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type AnalysisCompletionSummary = {
    id: string;
    ownerId: string;
    batchId?: string;
    source: 'browser' | 'server';
    status: 'succeeded' | 'partial' | 'failed' | 'cancelled';
    requested: number;
    succeeded: number;
    failed: number;
    trainingMomentsGenerated: number | null;
    pendingAtCompletion: number | null;
    completedAt: string;
    error?: string;
};

export type ServerAnalysisBatch = {
    id: string;
    ownerId: string;
    queued: number;
    jobIds: string[];
    failedAtStart: number;
    trainingMomentsAtStart: number | null;
    pendingAtStart: number | null;
    startedAt: string;
};

export type ServerAnalysisObservation = {
    queued: number;
    running: number;
    failed: number;
    trainingMomentCount: number | null;
    pendingCount: number | null;
};

export type ServerAnalysisJobObservation = {
    id: string;
    status: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createId(prefix: string) {
    const random =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : Math.random().toString(36).slice(2);
    return `${prefix}:${Date.now()}:${random}`;
}

function scopedKey(prefix: string, ownerId: string) {
    return `${prefix}:${encodeURIComponent(ownerId)}`;
}

export function createAnalysisCompletion(
    input: Omit<AnalysisCompletionSummary, 'id' | 'completedAt'> & {
        id?: string;
        completedAt?: string;
    }
): AnalysisCompletionSummary {
    return {
        ...input,
        id: input.id ?? createId(input.source),
        completedAt: input.completedAt ?? new Date().toISOString(),
    };
}

export function createBrowserAnalysisCompletion(input: {
    ownerId: string;
    requested: number;
    succeeded: number;
    failed: number;
    cancelled: boolean;
    trainingMomentsGenerated: number;
    pendingAtCompletion: number | null;
    error?: string;
}) {
    const status = input.cancelled
        ? 'cancelled'
        : input.succeeded === 0 && input.failed > 0
          ? 'failed'
          : input.failed > 0
            ? 'partial'
            : 'succeeded';
    return createAnalysisCompletion({
        ownerId: input.ownerId,
        source: 'browser',
        status,
        requested: Math.max(0, input.requested),
        succeeded: Math.max(0, input.succeeded),
        failed: Math.max(0, input.failed),
        trainingMomentsGenerated: Math.max(
            0,
            input.trainingMomentsGenerated
        ),
        pendingAtCompletion: input.pendingAtCompletion,
        error: input.error,
    });
}

export function createServerAnalysisBatch(input: {
    ownerId: string;
    queued: number;
    jobIds?: string[];
    failedAtStart: number;
    trainingMomentsAtStart: number | null;
    pendingAtStart: number | null;
}): ServerAnalysisBatch {
    return {
        id: createId('server-batch'),
        ownerId: input.ownerId,
        queued: Math.max(0, input.queued),
        jobIds: Array.from(new Set(input.jobIds ?? [])),
        failedAtStart: Math.max(0, input.failedAtStart),
        trainingMomentsAtStart: input.trainingMomentsAtStart,
        pendingAtStart: input.pendingAtStart,
        startedAt: new Date().toISOString(),
    };
}

export function mergeServerAnalysisBatches(
    current: ServerAnalysisBatch | null,
    incoming: ServerAnalysisBatch | null
): ServerAnalysisBatch | null {
    if (!current) return incoming;
    if (!incoming) return current;
    if (current.ownerId !== incoming.ownerId) return current;
    if (current.id === incoming.id) {
        return {
            ...current,
            jobIds: Array.from(
                new Set([...current.jobIds, ...incoming.jobIds])
            ),
            queued: Math.max(current.queued, incoming.queued),
        };
    }

    const jobIds = Array.from(
        new Set([...current.jobIds, ...incoming.jobIds])
    );
    return {
        ...current,
        queued:
            jobIds.length > 0
                ? jobIds.length
                : current.queued + incoming.queued,
        jobIds,
        failedAtStart: Math.min(
            current.failedAtStart,
            incoming.failedAtStart
        ),
        trainingMomentsAtStart:
            current.trainingMomentsAtStart ??
            incoming.trainingMomentsAtStart,
        pendingAtStart: current.pendingAtStart ?? incoming.pendingAtStart,
        startedAt:
            Date.parse(current.startedAt) <= Date.parse(incoming.startedAt)
                ? current.startedAt
                : incoming.startedAt,
    };
}

export function deriveServerJobCompletion(
    batch: ServerAnalysisBatch,
    jobs: ServerAnalysisJobObservation[],
    observation: Pick<
        ServerAnalysisObservation,
        'trainingMomentCount' | 'pendingCount'
    >
): AnalysisCompletionSummary | null {
    if (batch.jobIds.length === 0) return null;
    const jobsById = new Map(jobs.map((job) => [job.id, job.status]));
    const statuses = batch.jobIds.map((id) => jobsById.get(id));
    if (
        statuses.some(
            (status) =>
                status == null || status === 'QUEUED' || status === 'RUNNING'
        )
    ) {
        return null;
    }

    const succeeded = statuses.filter((status) => status === 'SUCCEEDED').length;
    const failed = statuses.length - succeeded;
    return createServerCompletion({
        batch,
        succeeded,
        failed,
        observation,
    });
}

export function deriveServerAnalysisCompletion(
    previous: ServerAnalysisObservation | null,
    current: ServerAnalysisObservation,
    batch: ServerAnalysisBatch | null
): AnalysisCompletionSummary | null {
    if (!batch || batch.jobIds.length > 0) return null;

    const wasActive =
        (previous?.queued ?? batch.queued) + (previous?.running ?? 0) > 0;
    const isActive = current.queued + current.running > 0;
    if (!wasActive || isActive) return null;

    const failed = Math.min(
        batch.queued,
        Math.max(0, current.failed - batch.failedAtStart)
    );
    return createServerCompletion({
        batch,
        succeeded: Math.max(0, batch.queued - failed),
        failed,
        observation: current,
    });
}

function createServerCompletion(input: {
    batch: ServerAnalysisBatch;
    succeeded: number;
    failed: number;
    observation: Pick<
        ServerAnalysisObservation,
        'trainingMomentCount' | 'pendingCount'
    >;
}) {
    const trainingMomentsGenerated =
        input.batch.trainingMomentsAtStart != null &&
        input.observation.trainingMomentCount != null
            ? Math.max(
                  0,
                  input.observation.trainingMomentCount -
                      input.batch.trainingMomentsAtStart
              )
            : null;
    return createAnalysisCompletion({
        ownerId: input.batch.ownerId,
        batchId: input.batch.id,
        source: 'server',
        status:
            input.succeeded === 0
                ? 'failed'
                : input.failed > 0
                  ? 'partial'
                  : 'succeeded',
        requested: input.batch.queued,
        succeeded: input.succeeded,
        failed: input.failed,
        trainingMomentsGenerated,
        pendingAtCompletion: input.observation.pendingCount,
    });
}

export function publishAnalysisCompletion(summary: AnalysisCompletionSummary) {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(
            scopedKey(LAST_COMPLETION_PREFIX, summary.ownerId),
            JSON.stringify(summary)
        );
    } catch {
        // Persistence is a convenience; the live event still completes the loop.
    }
    window.dispatchEvent(
        new CustomEvent<AnalysisCompletionSummary>(ANALYSIS_COMPLETION_EVENT, {
            detail: summary,
        })
    );
    publishLibraryChanged(summary.ownerId);
}

export function publishLibraryChanged(
    ownerId: string,
    options?: { invalidateCompletion?: boolean }
) {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(
            new CustomEvent(LIBRARY_CHANGED_EVENT, {
                detail: {
                    ownerId,
                    invalidateCompletion:
                        options?.invalidateCompletion === true,
                },
            })
        );
    }
}

export function readLastAnalysisCompletion(
    ownerId: string
): AnalysisCompletionSummary | null {
    if (typeof window === 'undefined') return null;
    try {
        const parsed = JSON.parse(
            localStorage.getItem(
                scopedKey(LAST_COMPLETION_PREFIX, ownerId)
            ) ?? 'null'
        ) as unknown;
        if (
            !isRecord(parsed) ||
            parsed.ownerId !== ownerId ||
            typeof parsed.id !== 'string' ||
            (parsed.source !== 'browser' && parsed.source !== 'server') ||
            typeof parsed.requested !== 'number' ||
            typeof parsed.succeeded !== 'number' ||
            typeof parsed.failed !== 'number' ||
            typeof parsed.completedAt !== 'string'
        ) {
            return null;
        }
        if (
            Number.isNaN(Date.parse(parsed.completedAt)) ||
            Date.now() - Date.parse(parsed.completedAt) >
                RECENT_RESULT_MAX_AGE_MS
        ) {
            clearLastAnalysisCompletion(ownerId);
            return null;
        }
        return parsed as AnalysisCompletionSummary;
    } catch {
        return null;
    }
}

export function clearLastAnalysisCompletion(ownerId: string) {
    if (typeof window === 'undefined') return;
    try {
        localStorage.removeItem(scopedKey(LAST_COMPLETION_PREFIX, ownerId));
    } catch {
        // ignore
    }
}

export function writeServerAnalysisBatch(
    ownerId: string,
    batch: ServerAnalysisBatch | null
) {
    if (typeof window === 'undefined') return;
    if (batch && batch.ownerId !== ownerId) return;
    try {
        const key = scopedKey(SERVER_BATCH_PREFIX, ownerId);
        if (batch) localStorage.setItem(key, JSON.stringify(batch));
        else localStorage.removeItem(key);
    } catch {
        // ignore
    }
}

export function readServerAnalysisBatch(
    ownerId: string
): ServerAnalysisBatch | null {
    if (typeof window === 'undefined') return null;
    try {
        const parsed = JSON.parse(
            localStorage.getItem(scopedKey(SERVER_BATCH_PREFIX, ownerId)) ??
                'null'
        ) as unknown;
        if (
            !isRecord(parsed) ||
            parsed.ownerId !== ownerId ||
            typeof parsed.id !== 'string' ||
            typeof parsed.queued !== 'number' ||
            !Array.isArray(parsed.jobIds) ||
            !parsed.jobIds.every((id) => typeof id === 'string') ||
            typeof parsed.failedAtStart !== 'number' ||
            typeof parsed.startedAt !== 'string'
        ) {
            return null;
        }
        if (
            Number.isNaN(Date.parse(parsed.startedAt)) ||
            Date.now() - Date.parse(parsed.startedAt) >
                RECENT_RESULT_MAX_AGE_MS
        ) {
            writeServerAnalysisBatch(ownerId, null);
            return null;
        }
        return parsed as ServerAnalysisBatch;
    } catch {
        return null;
    }
}

export function analysisCompletionStorageKeys(ownerId: string) {
    return {
        completion: scopedKey(LAST_COMPLETION_PREFIX, ownerId),
        serverBatch: scopedKey(SERVER_BATCH_PREFIX, ownerId),
    };
}
