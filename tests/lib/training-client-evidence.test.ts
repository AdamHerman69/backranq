import { describe, expect, it } from 'vitest';
import { parseEnrichTrainingAttemptRequest } from '@/lib/training/apiValidation';
import { enqueueTrainingAttempt, reconcileTrainingAttemptFlush, TRAINING_QUEUE_VERSION, type QueuedTrainingAttempt } from '@/lib/training/offlineQueue';
import type { EnrichTrainingAttemptRequest } from '@/lib/training/attemptApi';
import { practiceV4PatchFixture } from '../helpers/practice-v4';
const attemptId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const request: EnrichTrainingAttemptRequest = { kind: 'ENRICH', clientAttemptId: attemptId, momentRevisionId: revisionId, eventId: '33333333-3333-4333-8333-333333333333', stepIndex: 0, sequence: 1, supersedesEventId: null, evaluatedAt: '2026-07-30T08:00:00.000Z', resolution: 'RESOLVED', assessmentId: 'local-e2e4', evaluation: practiceV4PatchFixture() };
describe('v4 client evidence transport', () => {
    it('bounds untrusted evidence numbers and nested payloads', () => {
        expect(parseEnrichTrainingAttemptRequest(request)).toEqual(request);
        const invalid = structuredClone(request);
        invalid.evaluation!.assessments[0].metrics.lossCp = Infinity;
        expect(parseEnrichTrainingAttemptRequest(invalid)).toBeNull();
        expect(parseEnrichTrainingAttemptRequest({ ...request, evaluation: { ...request.evaluation, arbitrary: true } })).toBeNull();
    });
    it('keeps RECORD and multiple ordered ENRICH events independent through a concurrent flush', () => {
        const base = { version: TRAINING_QUEUE_VERSION, ownerId: 'owner', momentId: 'moment', queuedAt: request.evaluatedAt, state: 'PENDING' as const, attemptCount: 0, lastAttemptAt: null, lastError: null };
        const record: QueuedTrainingAttempt = { ...base, request: { kind: 'RECORD', clientAttemptId: attemptId, momentRevisionId: revisionId, stepIndex: 0, contextId: 'root', moveUci: 'e2e4', playedAt: request.evaluatedAt, timeSpentMs: null, initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING' } };
        const refine: QueuedTrainingAttempt = { ...base, request };
        const later: QueuedTrainingAttempt = { ...base, request: { ...request, eventId: '44444444-4444-4444-8444-444444444444', sequence: 2, supersedesEventId: request.eventId } };
        const queue = enqueueTrainingAttempt(enqueueTrainingAttempt([record], later), refine);
        expect(queue).toEqual([record, refine, later]);
        expect(reconcileTrainingAttemptFlush([record], [], queue)).toEqual([refine, later]);
        expect(enqueueTrainingAttempt(queue, refine)).toHaveLength(3);
    });
});
