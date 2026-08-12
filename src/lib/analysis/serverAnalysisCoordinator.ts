'use client';

import { useSyncExternalStore } from 'react';
import type { AnalysisDefaults } from '@/lib/preferences';
import {
    ClientRequestTimeoutError,
    fetchJsonWithTimeout,
} from '@/lib/services/gameSync';
import {
    clearLastAnalysisCompletion,
    publishAnalysisCompletion,
    publishLibraryChanged,
} from '@/lib/analysis/analysisCompletion';

export const SERVER_ANALYSIS_TRACKING_EVENT =
    'backranq:server-analysis-tracking';
const TRACKING_PREFIX = 'backranq.analysis.serverRequests.v3';
const TRACKING_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const SERVER_BATCH_CONFIRM_TIMEOUT_MS = 10_000;

class InvalidServerAnalysisBatchResponseError extends Error {
    constructor() {
        super('Invalid server analysis batch response');
        this.name = 'InvalidServerAnalysisBatchResponseError';
    }
}

export type ServerAnalysisBatchSummary = {
    id: string;
    requestId: string;
    status: string;
    requested: number;
    planning: number;
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
    skipped: number;
    completedAt: string | null;
};

export type TrackedServerAnalysisRequest = ServerAnalysisBatchSummary & {
    ownerId: string;
    payloadFingerprint: string;
    confirmingPayload?: {
        gameIds: string[];
        force?: boolean;
        analysisDefaults?: AnalysisDefaults;
    };
    createdAt: string;
    updatedAt: string;
};

export type ServerAnalysisQueueResult =
    | {
          state: 'confirmed';
          requestId: string;
          batch: ServerAnalysisBatchSummary;
      }
    | {
          state: 'confirming';
          requestId: string;
          batch: null;
      };

export function acceptedServerAnalysisCount(
    summary: Pick<
        ServerAnalysisBatchSummary,
        'requested' | 'skipped' | 'failed'
    >
) {
    return Math.max(0, summary.requested - summary.skipped - summary.failed);
}

type QueueArgs = {
    ownerId: string;
    gameIds: string[];
    force?: boolean;
    analysisDefaults?: AnalysisDefaults;
    timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.trunc(value))
        : 0;
}

function generateRequestId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    const random = () => Math.floor(Math.random() * 0x10000)
        .toString(16)
        .padStart(4, '0');
    return `${random()}${random()}-${random()}-4${random().slice(1)}-a${random().slice(1)}-${random()}${random()}${random()}`;
}

function trackingKey(ownerId: string) {
    return `${TRACKING_PREFIX}:${encodeURIComponent(ownerId)}`;
}

function isTerminalStatus(status: string) {
    return [
        'SUCCEEDED',
        'FAILED',
        'PARTIAL',
        'COMPLETED',
        'CANCELLED',
    ].includes(status.toUpperCase());
}

function isTerminalBatch(summary: ServerAnalysisBatchSummary) {
    return (
        isTerminalStatus(summary.status) &&
        summary.planning + summary.queued + summary.running === 0
    );
}

export function isServerAnalysisConfirming(status: string) {
    return ['CONFIRMING', 'PENDING', 'PLANNING'].includes(
        status.toUpperCase()
    );
}

export function parseServerAnalysisBatchResponse(
    value: unknown
): ServerAnalysisBatchSummary | null {
    const candidate = isRecord(value) && isRecord(value.batch)
        ? value.batch
        : value;
    if (
        !isRecord(candidate) ||
        typeof candidate.id !== 'string' ||
        typeof candidate.requestId !== 'string' ||
        typeof candidate.status !== 'string'
    ) {
        return null;
    }
    const counts = isRecord(candidate.counts) ? candidate.counts : candidate;
    return {
        id: candidate.id,
        requestId: candidate.requestId,
        status: candidate.status.toUpperCase(),
        requested: nonNegativeInteger(counts.total ?? candidate.requested),
        planning: nonNegativeInteger(counts.pending ?? candidate.planning),
        queued: nonNegativeInteger(counts.queued ?? candidate.queued),
        running: nonNegativeInteger(counts.running ?? candidate.running),
        succeeded: nonNegativeInteger(
            counts.succeeded ?? candidate.succeeded
        ),
        failed:
            nonNegativeInteger(counts.failed ?? candidate.failed) +
            nonNegativeInteger(counts.jobFailed) +
            nonNegativeInteger(counts.jobCancelled) +
            nonNegativeInteger(counts.cancelled),
        skipped: nonNegativeInteger(counts.skipped ?? candidate.skipped),
        completedAt:
            typeof candidate.completedAt === 'string'
                ? candidate.completedAt
                : null,
    };
}

export function readTrackedServerAnalysisRequests(ownerId: string) {
    if (typeof window === 'undefined') return [] as TrackedServerAnalysisRequest[];
    try {
        const parsed = JSON.parse(
            localStorage.getItem(trackingKey(ownerId)) ?? '[]'
        ) as unknown;
        if (!Array.isArray(parsed)) return [];
        const now = Date.now();
        return parsed.filter(
            (item): item is TrackedServerAnalysisRequest =>
                isRecord(item) &&
                item.ownerId === ownerId &&
                typeof item.requestId === 'string' &&
                typeof item.id === 'string' &&
                typeof item.status === 'string' &&
                typeof item.payloadFingerprint === 'string' &&
                (item.confirmingPayload === undefined ||
                    (isRecord(item.confirmingPayload) &&
                        Array.isArray(item.confirmingPayload.gameIds) &&
                        item.confirmingPayload.gameIds.every(
                            (id) => typeof id === 'string'
                        ))) &&
                typeof item.createdAt === 'string' &&
                typeof item.updatedAt === 'string' &&
                now - Date.parse(item.createdAt) <= TRACKING_MAX_AGE_MS
        );
    } catch {
        return [];
    }
}

function writeTrackedRequests(
    ownerId: string,
    requests: TrackedServerAnalysisRequest[]
) {
    if (typeof window === 'undefined') return;
    try {
        localStorage.setItem(trackingKey(ownerId), JSON.stringify(requests));
    } catch {
        // Tracking is best effort; the backend request remains idempotent.
    }
    window.dispatchEvent(
        new CustomEvent(SERVER_ANALYSIS_TRACKING_EVENT, {
            detail: { ownerId },
        })
    );
}

function persistRequest(request: TrackedServerAnalysisRequest) {
    const requests = readTrackedServerAnalysisRequests(request.ownerId);
    const index = requests.findIndex(
        (candidate) => candidate.requestId === request.requestId
    );
    if (index >= 0) requests[index] = request;
    else requests.push(request);
    writeTrackedRequests(request.ownerId, requests.slice(-20));
}

function removeRequest(ownerId: string, requestId: string) {
    writeTrackedRequests(
        ownerId,
        readTrackedServerAnalysisRequests(ownerId).filter(
            (request) => request.requestId !== requestId
        )
    );
}

function trackingRecord(
    ownerId: string,
    summary: ServerAnalysisBatchSummary,
    createdAt?: string,
    payloadFingerprint = ''
): TrackedServerAnalysisRequest {
    const now = new Date().toISOString();
    return {
        ...summary,
        ownerId,
        payloadFingerprint,
        confirmingPayload: undefined,
        createdAt: createdAt ?? now,
        updatedAt: now,
    };
}

function acceptSummary(
    ownerId: string,
    summary: ServerAnalysisBatchSummary,
    createdAt?: string,
    payloadFingerprint?: string
) {
    const record = trackingRecord(
        ownerId,
        summary,
        createdAt,
        payloadFingerprint
    );
    if (!isTerminalBatch(summary)) {
        persistRequest(record);
        return record;
    }

    removeRequest(ownerId, summary.requestId);
    const failed = summary.failed;
    const succeeded = summary.succeeded;
    publishAnalysisCompletion({
        id: `server-batch:${summary.id}`,
        batchId: summary.id,
        ownerId,
        source: 'server',
        status:
            succeeded === 0 && failed > 0
                ? 'failed'
                : failed > 0
                  ? 'partial'
                  : 'succeeded',
        requested: summary.requested,
        succeeded,
        failed,
        trainingMomentsGenerated: null,
        pendingAtCompletion: null,
        completedAt: summary.completedAt ?? new Date().toISOString(),
    });
    return record;
}

function responseError(json: unknown, fallback: string) {
    return isRecord(json) && typeof json.error === 'string'
        ? json.error
        : fallback;
}

async function postBatch(
    args: Omit<QueueArgs, 'ownerId' | 'timeoutMs'> & { requestId: string },
    timeoutMs: number
) {
    const { response, json } = await fetchJsonWithTimeout(
        '/api/analysis/batches',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(args),
        },
        timeoutMs
    );
    if (!response.ok) {
        throw new Error(responseError(json, 'Failed to queue server analysis'));
    }
    const summary = parseServerAnalysisBatchResponse(json);
    if (!summary) throw new InvalidServerAnalysisBatchResponseError();
    return summary;
}

export async function fetchServerAnalysisBatchByRequestId(
    requestId: string,
    timeoutMs = SERVER_BATCH_CONFIRM_TIMEOUT_MS
) {
    const { response, json } = await fetchJsonWithTimeout(
        `/api/analysis/batches?requestId=${encodeURIComponent(requestId)}`,
        { cache: 'no-store' },
        timeoutMs
    );
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(responseError(json, 'Failed to confirm server analysis'));
    }
    return parseServerAnalysisBatchResponse(json);
}

const detachedReconciliations = new Map<string, Promise<void>>();

function reconcileDetached(
    ownerId: string,
    requestId: string,
    payloadFingerprint: string,
    repostArgs?: Omit<QueueArgs, 'ownerId' | 'timeoutMs'>
) {
    const key = `${ownerId}:${requestId}`;
    if (detachedReconciliations.has(key)) return;
    const task = (async () => {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            try {
                const summary =
                    (await fetchServerAnalysisBatchByRequestId(requestId)) ??
                    (repostArgs
                        ? await postBatch(
                              { ...repostArgs, requestId },
                              SERVER_BATCH_CONFIRM_TIMEOUT_MS
                          )
                        : null);
                if (summary) {
                    acceptSummary(
                        ownerId,
                        summary,
                        undefined,
                        payloadFingerprint
                    );
                    return;
                }
            } catch {
                // The background bar will continue reconciliation on its poll.
            }
            await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
    })().finally(() => detachedReconciliations.delete(key));
    detachedReconciliations.set(key, task);
}

export async function queueServerAnalysisBatch(
    args: QueueArgs
): Promise<ServerAnalysisQueueResult> {
    const postArgs = {
        gameIds: Array.from(new Set(args.gameIds)).sort(),
        force: args.force,
        analysisDefaults: args.analysisDefaults,
    };
    const payloadFingerprint = JSON.stringify({
        gameIds: postArgs.gameIds,
        force: postArgs.force === true,
        analysisDefaults: postArgs.analysisDefaults
            ? {
                  analysisQuality:
                      postArgs.analysisDefaults.analysisQuality,
                  trainingCoveragePreset:
                      postArgs.analysisDefaults.trainingCoveragePreset,
                  trainingGradingTolerance:
                      postArgs.analysisDefaults.trainingGradingTolerance,
              }
            : null,
    });
    const existing = readTrackedServerAnalysisRequests(args.ownerId).find(
        (request) =>
            isServerAnalysisConfirming(request.status) &&
            request.payloadFingerprint === payloadFingerprint
    );
    if (existing) {
        const confirmed = await fetchServerAnalysisBatchByRequestId(
            existing.requestId
        ).catch(() => null);
        if (confirmed) {
            acceptSummary(
                args.ownerId,
                confirmed,
                existing.createdAt,
                payloadFingerprint
            );
            return {
                state: 'confirmed',
                requestId: existing.requestId,
                batch: confirmed,
            };
        }
        return { state: 'confirming', requestId: existing.requestId, batch: null };
    }

    const requestId = generateRequestId();
    const createdAt = new Date().toISOString();
    persistRequest({
        ownerId: args.ownerId,
        payloadFingerprint,
        id: '',
        requestId,
        status: 'CONFIRMING',
        requested: args.gameIds.length,
        planning: args.gameIds.length,
        queued: 0,
        running: 0,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        completedAt: null,
        confirmingPayload: postArgs,
        createdAt,
        updatedAt: createdAt,
    });
    clearLastAnalysisCompletion(args.ownerId);
    publishLibraryChanged(args.ownerId, { invalidateCompletion: true });

    try {
        const summary = await postBatch(
            { ...postArgs, requestId },
            args.timeoutMs ?? SERVER_BATCH_CONFIRM_TIMEOUT_MS
        );
        acceptSummary(
            args.ownerId,
            summary,
            createdAt,
            payloadFingerprint
        );
        return { state: 'confirmed', requestId, batch: summary };
    } catch (error) {
        if (
            error instanceof ClientRequestTimeoutError ||
            error instanceof InvalidServerAnalysisBatchResponseError ||
            error instanceof TypeError ||
            (error instanceof DOMException && error.name === 'AbortError')
        ) {
            reconcileDetached(
                args.ownerId,
                requestId,
                payloadFingerprint,
                postArgs
            );
            return { state: 'confirming', requestId, batch: null };
        }
        removeRequest(args.ownerId, requestId);
        throw error;
    }
}

export async function reconcileTrackedServerAnalysis(ownerId: string) {
    const requests = readTrackedServerAnalysisRequests(ownerId);
    const settled = await Promise.allSettled(
        requests.map(async (request) => {
            const summary = (await fetchServerAnalysisBatchByRequestId(
                request.requestId
            )) ??
                (request.confirmingPayload
                    ? await postBatch(
                          {
                              ...request.confirmingPayload,
                              requestId: request.requestId,
                          },
                          SERVER_BATCH_CONFIRM_TIMEOUT_MS
                      )
                    : null);
            if (!summary) return request;
            return acceptSummary(
                ownerId,
                summary,
                request.createdAt,
                request.payloadFingerprint
            );
        })
    );
    return settled.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
    );
}

export function serverAnalysisTrackingStorageKey(ownerId: string) {
    return trackingKey(ownerId);
}

export function hasConfirmingServerAnalysisRequest(ownerId: string) {
    return readTrackedServerAnalysisRequests(ownerId).some(
        (request) => request.status.toUpperCase() === 'CONFIRMING'
    );
}

export function useHasConfirmingServerAnalysisRequest(ownerId: string | null) {
    return useSyncExternalStore(
        (onStoreChange) => {
            if (typeof window === 'undefined') return () => undefined;
            const onTracking = (event: Event) => {
                const detail = (event as CustomEvent<{ ownerId?: string }>).detail;
                if (!ownerId || detail?.ownerId === ownerId) onStoreChange();
            };
            const onStorage = (event: StorageEvent) => {
                if (ownerId && event.key === trackingKey(ownerId)) {
                    onStoreChange();
                }
            };
            window.addEventListener(SERVER_ANALYSIS_TRACKING_EVENT, onTracking);
            window.addEventListener('storage', onStorage);
            return () => {
                window.removeEventListener(
                    SERVER_ANALYSIS_TRACKING_EVENT,
                    onTracking
                );
                window.removeEventListener('storage', onStorage);
            };
        },
        () =>
            ownerId
                ? hasConfirmingServerAnalysisRequest(ownerId)
                : false,
        () => false
    );
}
