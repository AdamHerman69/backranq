import type { RecordTrainingAttemptRequest } from '@/lib/training/api';
import { TrainingClientError } from '@/lib/training/client';

export const TRAINING_QUEUE_VERSION = 3 as const;
export const TRAINING_QUEUE_MAX_ENTRIES = 100;

export type TrainingAttemptOutboxError = {
    status: number | null;
    code: string | null;
    message: string;
};

export type QueuedTrainingAttempt = {
    version: typeof TRAINING_QUEUE_VERSION;
    ownerId: string;
    momentId: string;
    request: RecordTrainingAttemptRequest;
    queuedAt: string;
    state: 'PENDING' | 'NEEDS_ATTENTION';
    attemptCount: number;
    lastAttemptAt: string | null;
    lastError: TrainingAttemptOutboxError | null;
};

export type TrainingWriteFailure = {
    disposition: 'RETRY' | 'NEEDS_ATTENTION';
    offline: boolean;
    error: TrainingAttemptOutboxError;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAttemptRequest(value: unknown): value is RecordTrainingAttemptRequest {
    if (!isRecord(value)) return false;
    return (
        value.kind === 'RECORD' &&
        typeof value.clientAttemptId === 'string' &&
        typeof value.solutionRevisionId === 'string' &&
        (value.status === 'GRADED' || value.status === 'REVEALED') &&
        Array.isArray(value.steps)
    );
}

function isOutboxError(value: unknown): value is TrainingAttemptOutboxError {
    return (
        isRecord(value) &&
        (value.status === null || typeof value.status === 'number') &&
        (value.code === null || typeof value.code === 'string') &&
        typeof value.message === 'string'
    );
}

export function trainingQueueStorageKey(ownerId: string): string {
    return `backranq:training-attempts:v${TRAINING_QUEUE_VERSION}:${ownerId}`;
}

export function parseTrainingAttemptQueue(
    raw: string | null
): QueuedTrainingAttempt[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const entries: QueuedTrainingAttempt[] = [];
    for (const value of parsed.slice(0, TRAINING_QUEUE_MAX_ENTRIES)) {
        if (
            !isRecord(value) ||
            value.version !== TRAINING_QUEUE_VERSION ||
            typeof value.ownerId !== 'string' ||
            typeof value.momentId !== 'string' ||
            typeof value.queuedAt !== 'string' ||
            (value.state !== 'PENDING' && value.state !== 'NEEDS_ATTENTION') ||
            !Number.isSafeInteger(value.attemptCount) ||
            (value.attemptCount as number) < 0 ||
            (value.lastAttemptAt !== null &&
                typeof value.lastAttemptAt !== 'string') ||
            (value.lastError !== null && !isOutboxError(value.lastError)) ||
            !isAttemptRequest(value.request)
        ) {
            continue;
        }
        entries.push(value as QueuedTrainingAttempt);
    }
    return entries;
}

export function enqueueTrainingAttempt(
    entries: readonly QueuedTrainingAttempt[],
    next: QueuedTrainingAttempt
): QueuedTrainingAttempt[] {
    const duplicate = entries.some(
        (entry) =>
            entry.momentId === next.momentId &&
            entry.request.clientAttemptId === next.request.clientAttemptId &&
            entry.request.kind === next.request.kind
    );
    if (duplicate || entries.length >= TRAINING_QUEUE_MAX_ENTRIES) {
        return [...entries];
    }
    return [...entries, next];
}

export function classifyTrainingWriteFailure(
    error: unknown,
    navigatorOnline = true
): TrainingWriteFailure {
    const browserOffline = !navigatorOnline;
    if (error instanceof TrainingClientError) {
        const retryable =
            error.status === 408 ||
            error.status === 425 ||
            error.status === 429 ||
            error.status >= 500;
        return {
            disposition: retryable ? 'RETRY' : 'NEEDS_ATTENTION',
            offline: browserOffline,
            error: {
                status: error.status,
                code: error.code,
                message:
                    error.status === 401
                        ? 'Sign in again to save this practice result.'
                        : error.message,
            },
        };
    }
    const networkFailure = error instanceof TypeError || browserOffline;
    return {
        disposition: 'RETRY',
        offline: networkFailure,
        error: {
            status: null,
            code: null,
            message:
                error instanceof Error
                    ? error.message
                    : 'Practice history sync failed.',
        },
    };
}

export function failedTrainingAttempt(
    entry: QueuedTrainingAttempt,
    failure: TrainingWriteFailure,
    attemptedAt: string
): QueuedTrainingAttempt {
    return {
        ...entry,
        state:
            failure.disposition === 'RETRY'
                ? 'PENDING'
                : 'NEEDS_ATTENTION',
        attemptCount: entry.attemptCount + 1,
        lastAttemptAt: attemptedAt,
        lastError: failure.error,
    };
}

/**
 * Applies a flush result to the latest storage value. Entries that appeared
 * after the flush snapshot was captured are never removed or overwritten.
 */
export function reconcileTrainingAttemptFlush(
    snapshot: readonly QueuedTrainingAttempt[],
    processedSnapshot: readonly QueuedTrainingAttempt[],
    latest: readonly QueuedTrainingAttempt[]
): QueuedTrainingAttempt[] {
    const snapshotById = new Map(
        snapshot.map((entry) => [
            entry.request.clientAttemptId,
            entry,
        ])
    );
    const processedById = new Map(
        processedSnapshot.map((entry) => [
            entry.request.clientAttemptId,
            entry,
        ])
    );
    const reconciled = latest.flatMap((entry) => {
        const clientAttemptId = entry.request.clientAttemptId;
        const snapshotEntry = snapshotById.get(clientAttemptId);
        if (!snapshotEntry) return [entry];
        // A user action or another queue mutation changed this snapshot entry
        // while the remote flush was awaiting I/O. That newer local intent is
        // authoritative and must not be overwritten by the stale flush result.
        if (!sameQueuedTrainingAttempt(entry, snapshotEntry)) return [entry];
        const processed = processedById.get(clientAttemptId);
        return processed ? [processed] : [];
    });
    return reconciled.slice(0, TRAINING_QUEUE_MAX_ENTRIES);
}

function sameQueuedTrainingAttempt(
    left: QueuedTrainingAttempt,
    right: QueuedTrainingAttempt
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}
