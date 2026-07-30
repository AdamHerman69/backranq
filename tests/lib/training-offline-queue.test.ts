import { describe, expect, it } from 'vitest';

import {
    enqueueTrainingAttempt,
    parseTrainingAttemptQueue,
    trainingQueueStorageKey,
    type QueuedTrainingAttempt,
} from '@/lib/training/offlineQueue';

const queued: QueuedTrainingAttempt = {
    version: 2,
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
                    { ...queued, version: 0 },
                    { ...queued, request: { kind: 'START' } },
                ])
            )
        ).toEqual([queued]);
    });
});
