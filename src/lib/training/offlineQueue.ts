import type { SubmitTrainingAttemptRequest } from '@/lib/training/api';

export const TRAINING_QUEUE_VERSION = 1 as const;
export const TRAINING_QUEUE_MAX_ENTRIES = 100;

export type QueuedTrainingAttempt = {
    version: typeof TRAINING_QUEUE_VERSION;
    ownerId: string;
    momentId: string;
    request: SubmitTrainingAttemptRequest;
    fenBefore: string;
    fenAfterMove: string;
    queuedAt: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAttemptRequest(value: unknown): value is SubmitTrainingAttemptRequest {
    if (!isRecord(value)) return false;
    if (typeof value.clientAttemptId !== 'string') {
        return false;
    }
    if (value.kind === 'RETRY') {
        return (
            typeof value.attemptId === 'string' &&
            typeof value.retryId === 'string' &&
            Number.isSafeInteger(value.stepIndex) &&
            Number(value.stepIndex) >= 0
        );
    }
    if (typeof value.moveUci !== 'string') return false;
    if (value.kind === 'START') {
        return typeof value.solutionRevisionId === 'string';
    }
    return (
        value.kind === 'STEP' &&
        typeof value.attemptId === 'string' &&
        Number.isSafeInteger(value.stepIndex) &&
        Number(value.stepIndex) >= 0
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
            typeof value.fenBefore !== 'string' ||
            typeof value.fenAfterMove !== 'string' ||
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
            entry.request.kind === next.request.kind &&
            (entry.request.kind !== 'STEP' ||
                next.request.kind !== 'STEP' ||
                entry.request.stepIndex === next.request.stepIndex) &&
            (entry.request.kind !== 'RETRY' ||
                next.request.kind !== 'RETRY' ||
                entry.request.retryId === next.request.retryId)
    );
    if (duplicate) return [...entries];
    return [...entries, next].slice(-TRAINING_QUEUE_MAX_ENTRIES);
}
