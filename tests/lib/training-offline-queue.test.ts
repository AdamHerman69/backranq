import { describe, expect, it } from 'vitest';

import {
    classifyTrainingWriteFailure,
    enqueueTrainingAttempt,
    failedTrainingAttempt,
    parseTrainingAttemptQueue,
    reconcileTrainingAttemptFlush,
    trainingQueueStorageKey,
    type QueuedTrainingAttempt,
} from '@/lib/training/offlineQueue';
import { TrainingClientError } from '@/lib/training/client';

const queued: QueuedTrainingAttempt = {
    version: 3,
    ownerId: 'owner-a',
    momentId: 'moment-a',
    request: {
        kind: 'RECORD',
        clientAttemptId: 'client-a',
        solutionRevisionId: 'revision-a',
        status: 'GRADED',
        grade: 'BEST',
        gradingSource: 'PRECOMPUTED',
        steps: [
            {
                stepIndex: 0,
                actor: 'USER',
                fenBefore: 'before',
                moveUci: 'e2e4',
                grade: 'BEST',
                source: 'PRECOMPUTED',
            },
        ],
    },
    queuedAt: '2026-07-29T00:00:00.000Z',
    state: 'PENDING',
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
};

describe('canonical training offline queue', () => {
    it('namespaces pending grading by authenticated owner', () => {
        expect(trainingQueueStorageKey('owner-a')).not.toBe(
            trainingQueueStorageKey('owner-b')
        );
    });

    it('deduplicates an idempotent result record', () => {
        const result = enqueueTrainingAttempt([queued], queued);
        expect(result).toEqual([queued]);
        expect(result[0]?.request.grade).toBe('BEST');
    });

    it('drops malformed or unversioned persisted entries', () => {
        expect(
            parseTrainingAttemptQueue(
                JSON.stringify([
                    queued,
                    { ...queued, version: 2 },
                    { ...queued, request: { kind: 'START' } },
                ])
            )
        ).toEqual([queued]);
    });

    it('keeps retryable failures pending and makes permanent 4xx visible', () => {
        const rateLimited = classifyTrainingWriteFailure(
            new TrainingClientError({
                message: 'Try later',
                status: 429,
            })
        );
        const invalid = classifyTrainingWriteFailure(
            new TrainingClientError({
                message: 'Revision changed',
                status: 409,
                code: 'STALE_REVISION',
            })
        );

        expect(rateLimited.disposition).toBe('RETRY');
        expect(invalid.disposition).toBe('NEEDS_ATTENTION');
        expect(
            failedTrainingAttempt(
                queued,
                invalid,
                '2026-07-29T01:00:00.000Z'
            )
        ).toMatchObject({
            state: 'NEEDS_ATTENTION',
            attemptCount: 1,
            lastError: { status: 409, code: 'STALE_REVISION' },
        });
    });

    it('does not silently evict an older unsaved result at capacity', () => {
        const full = Array.from({ length: 100 }, (_, index) => ({
            ...queued,
            momentId: `moment-${index}`,
            request: {
                ...queued.request,
                clientAttemptId: `attempt-${index}`,
            },
        }));
        const next = enqueueTrainingAttempt(full, {
            ...queued,
            momentId: 'new-moment',
            request: { ...queued.request, clientAttemptId: 'new-attempt' },
        });

        expect(next).toEqual(full);
    });

    it('preserves a result enqueued while a deferred flush is in flight', async () => {
        const concurrent = {
            ...queued,
            momentId: 'moment-b',
            request: {
                ...queued.request,
                clientAttemptId: 'client-b',
            },
        };
        const storage = [queued];
        let release!: () => void;
        const remoteWrite = new Promise<void>((resolve) => {
            release = resolve;
        });

        const snapshot = [...storage];
        const flush = remoteWrite.then(() => {
            const reconciled = reconcileTrainingAttemptFlush(
                snapshot,
                [],
                storage
            );
            storage.splice(0, storage.length, ...reconciled);
        });
        storage.push(concurrent);
        release();
        await flush;

        expect(storage).toEqual([concurrent]);
    });

    it('does not resurrect a snapshot result dismissed during a flush', () => {
        expect(
            reconcileTrainingAttemptFlush([queued], [queued], [])
        ).toEqual([]);
    });

    it('preserves an explicit retry made while another snapshot entry flushes', () => {
        const needsAttention: QueuedTrainingAttempt = {
            ...queued,
            momentId: 'moment-b',
            request: {
                ...queued.request,
                clientAttemptId: 'client-b',
            },
            state: 'NEEDS_ATTENTION',
            attemptCount: 1,
            lastAttemptAt: '2026-07-29T01:00:00.000Z',
            lastError: {
                status: 422,
                code: 'INVALID_REQUEST',
                message: 'Invalid attempt',
            },
        };
        const retried: QueuedTrainingAttempt = {
            ...needsAttention,
            state: 'PENDING',
            lastError: null,
        };

        expect(
            reconcileTrainingAttemptFlush(
                [queued, needsAttention],
                [needsAttention],
                [retried]
            )
        ).toEqual([retried]);
    });
});
