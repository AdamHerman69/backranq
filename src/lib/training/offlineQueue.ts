import type { RecordTrainingAttemptRequest } from '@/lib/training/api';

export const TRAINING_QUEUE_VERSION = 2 as const;
export const TRAINING_QUEUE_MAX_ENTRIES = 100;

export type QueuedTrainingAttempt = {
    version: typeof TRAINING_QUEUE_VERSION;
    ownerId: string;
    momentId: string;
    request: RecordTrainingAttemptRequest;
    queuedAt: string;
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

export function trainingQueueStorageKey(ownerId: string): string {
    return `backranq:training-attempts:v${TRAINING_QUEUE_VERSION}:${ownerId}`;
}

export function parseTrainingAttemptQueue(raw: string | null): QueuedTrainingAttempt[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];

    const entries: QueuedTrainingAttempt[] = [];
    for (const value of parsed.slice(-TRAINING_QUEUE_MAX_ENTRIES)) {
        if (
            !isRecord(value) ||
            value.version !== TRAINING_QUEUE_VERSION ||
            typeof value.ownerId !== 'string' ||
            typeof value.momentId !== 'string' ||
            typeof value.queuedAt !== 'string' ||
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
    if (duplicate) return [...entries];
    return [...entries, next].slice(-TRAINING_QUEUE_MAX_ENTRIES);
}
