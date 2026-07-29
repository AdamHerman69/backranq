import { describe, expect, it } from 'vitest';

import {
    enqueueTrainingAttempt,
    parseTrainingAttemptQueue,
    trainingQueueStorageKey,
    type QueuedTrainingAttempt,
} from '@/lib/training/offlineQueue';

const queued: QueuedTrainingAttempt = {
    version: 1,
    ownerId: 'owner-a',
    momentId: 'moment-a',
    request: {
        kind: 'START',
        clientAttemptId: 'client-a',
        solutionRevisionId: 'revision-a',
        moveUci: 'e2e4',
    },
    fenBefore: 'before',
    fenAfterMove: 'after',
    queuedAt: '2026-07-29T00:00:00.000Z',
};

describe('canonical training offline queue', () => {
    it('namespaces pending grading by authenticated owner', () => {
        expect(trainingQueueStorageKey('owner-a')).not.toBe(
            trainingQueueStorageKey('owner-b')
        );
    });

    it('deduplicates an idempotent submission without adding correctness', () => {
        const result = enqueueTrainingAttempt([queued], queued);
        expect(result).toEqual([queued]);
        expect(result[0]).not.toHaveProperty('correct');
        expect(result[0]).not.toHaveProperty('grade');
        expect(result[0]).not.toHaveProperty('accepted');
    });

    it('drops malformed or unversioned persisted entries', () => {
        expect(
            parseTrainingAttemptQueue(
                JSON.stringify([
                    queued,
                    { ...queued, version: 0 },
                    { ...queued, request: { kind: 'START' } },
                ])
            )
        ).toEqual([queued]);
    });
});
