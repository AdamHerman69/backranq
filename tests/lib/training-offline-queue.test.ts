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
    version: 6,
    ownerId: 'owner-a',
    momentId: 'moment-a',
    request: {
        kind: 'RECORD', clientAttemptId: '11111111-1111-4111-8111-111111111111',
        momentRevisionId: '22222222-2222-4222-8222-222222222222', stepIndex: 0,
        contextId: 'root', moveUci: 'e2e4', playedAt: '2026-07-30T08:00:00.000Z',
        timeSpentMs: 100, initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING',
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
        expect(result[0]?.request.kind).toBe('RECORD');
    });

    it('drops malformed or unversioned persisted entries', () => {
        expect(
            parseTrainingAttemptQueue(
                JSON.stringify([
                    queued,
                    { ...queued, version: 3 },
                    { ...queued, request: { ...queued.request, playedAt: undefined } },
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
        expect(() => enqueueTrainingAttempt(full, {
            ...queued,
            momentId: 'new-moment',
            request: { ...queued.request, clientAttemptId: 'new-attempt' },
        })).toThrow('queue is full');
        expect(full).toHaveLength(100);
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


describe('v4 outbox causality', () => {
    const enrichment: QueuedTrainingAttempt = { ...queued, request: {
        kind: 'ENRICH', clientAttemptId: queued.request.clientAttemptId,
        momentRevisionId: queued.request.momentRevisionId, stepIndex: 0,
        eventId: '33333333-3333-4333-8333-333333333333', sequence: 1,
        supersedesEventId: null, evaluatedAt: '2026-07-30T08:01:00.000Z',
        resolution: 'UNAVAILABLE', assessmentId: null, evaluation: null,
    } };
    it('puts a late queued RECORD before an already queued ENRICH', () => {
        expect(enqueueTrainingAttempt([enrichment], queued).map(e => e.request.kind)).toEqual(['RECORD', 'ENRICH']);
        expect(parseTrainingAttemptQueue(JSON.stringify([enrichment, queued])).map(e => e.request.kind)).toEqual(['RECORD', 'ENRICH']);
    });
    it('retains distinct step events but rejects changed payload for the same played identity', () => {
        expect(() => enqueueTrainingAttempt([queued], { ...queued, request: { ...queued.request, moveUci: 'd2d4' } as typeof queued.request })).toThrow('identity conflict');
    });
    it('keeps a retryable missing-parent response pending', () => {
        expect(classifyTrainingWriteFailure(new TrainingClientError({ message: 'Record first', status: 425 })).disposition).toBe('RETRY');
    });
});
