import { describe, expect, it } from 'vitest';
import { parseEnrichTrainingAttemptRequest, parseRecordTrainingAttemptRequest } from '@/lib/training/apiValidation';
import { practiceV4PatchFixture } from '../helpers/practice-v4';
const id = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const record = { kind: 'RECORD', clientAttemptId: id, momentRevisionId: id, stepIndex: 0, contextId: 'root', moveUci: 'e2e4', playedAt: '2026-08-01T00:00:00.000Z', timeSpentMs: null, initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING' };
describe('Practice v4 attempt request parser', () => {
    it('accepts a played move before evaluation and a separate move-free reveal', () => {
        expect(parseRecordTrainingAttemptRequest(record)).toEqual(record);
        expect(parseRecordTrainingAttemptRequest({ kind: 'REVEAL', clientAttemptId: id, momentRevisionId: id, revealedAt: record.playedAt })).not.toBeNull();
    });
    it('requires exactly one initial evidence reference for resolved moves', () => {
        expect(parseRecordTrainingAttemptRequest({ ...record, resolution: 'RESOLVED' })).toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, resolution: 'RESOLVED', initialAssessmentId: 'a' })).not.toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, resolution: 'RESOLVED', initialCoverageGroupId: 'g' })).not.toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, resolution: 'RESOLVED', initialAssessmentId: 'a', initialCoverageGroupId: 'g' })).toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, initialCoverageGroupId: 'g' })).toBeNull();
    });
    it('rejects obsolete payloads, malformed identities and unexpected fields', () => {
        expect(parseRecordTrainingAttemptRequest({ kind: 'RECORD', completedAt: record.playedAt, clientAttemptId: id, solutionRevisionId: id, status: 'GRADED', grade: 'BEST', steps: [] })).toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, stepIndex: -1 })).toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, grade: 'BEST' })).toBeNull();
        expect(parseRecordTrainingAttemptRequest({ ...record, moveUci: 'xx' })).toBeNull();
    });
    it('accepts supported evidence payloads for server validation and enforces sequence links', () => {
        const request = { kind: 'ENRICH', clientAttemptId: id, momentRevisionId: id, stepIndex: 0, eventId, sequence: 1, supersedesEventId: null, evaluatedAt: record.playedAt, resolution: 'RESOLVED', assessmentId: 'local-e2e4', evaluation: practiceV4PatchFixture() };
        expect(parseEnrichTrainingAttemptRequest(request)).not.toBeNull();
        expect(parseEnrichTrainingAttemptRequest({ ...request, sequence: 2 })).toBeNull();
        expect(parseEnrichTrainingAttemptRequest({ ...request, sequence: 2, supersedesEventId: eventId })).toBeNull();
        expect(parseEnrichTrainingAttemptRequest({ ...request, sequence: 2, supersedesEventId: id })).not.toBeNull();
        expect(parseEnrichTrainingAttemptRequest({ ...request, resolution: 'UNAVAILABLE' })).toBeNull();
        expect(parseEnrichTrainingAttemptRequest({ ...request, resolution: 'UNAVAILABLE', assessmentId: null, evaluation: null })).not.toBeNull();
    });
});
