import type { PoolCostTotals, PositionAnalysisPool } from './positionAnalysisPool';

export type ExtractionWork = ReturnType<PositionAnalysisPool['report']>;
const KEYS = ['queries', 'reusedQueries', 'failedQueries', 'unattributedFailedQueries',
    'unattributedFailedRequestedNodes', 'physicalSearches', 'requestedNodes', 'reportedNodes', 'reportedTimeMs'] as const;

export function emptyExtractionWork(): ExtractionWork {
    return { queries: 0, reusedQueries: 0, failedQueries: 0, unattributedFailedQueries: 0,
        unattributedFailedRequestedNodes: 0, physicalSearches: 0, requestedNodes: 0,
        reportedNodes: 0, reportedTimeMs: 0, byReason: {} };
}

/** Per-game delta; a resumed single game starts at zero to include earlier slices. */
export function extractionWorkSince(total: ExtractionWork, start: ExtractionWork): ExtractionWork {
    const result = emptyExtractionWork();
    for (const [reason, value] of Object.entries(total.byReason)) {
        const delta = {} as PoolCostTotals;
        for (const key of KEYS) delta[key] = value[key] - (start.byReason[reason]?.[key] ?? 0);
        if (KEYS.some(key => delta[key] !== 0)) result.byReason[reason] = delta;
        for (const key of KEYS) result[key] += delta[key];
    }
    return result;
}

export function isExtractionWork(value: unknown): value is ExtractionWork {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const work = value as Record<string, unknown>;
    if (!work.byReason || typeof work.byReason !== 'object' || Array.isArray(work.byReason)) return false;
    const entries = Object.entries(work.byReason);
    if (entries.length > 64 || entries.some(([reason]) => reason.length > 80)) return false;
    const validCounts = (input: unknown): input is PoolCostTotals => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
        const counts = input as PoolCostTotals;
        return KEYS.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0)
            && counts.reusedQueries <= counts.queries && counts.failedQueries <= counts.queries
            && counts.unattributedFailedQueries <= counts.failedQueries;
    };
    if (!validCounts(work) || !entries.every(([, counts]) => validCounts(counts))) return false;
    return KEYS.every(key => work[key] === entries.reduce((sum, [, counts]) => sum + (counts as PoolCostTotals)[key], 0));
}
