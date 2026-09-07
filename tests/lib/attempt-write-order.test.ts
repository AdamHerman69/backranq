import { expect, it } from 'vitest';
import { attemptWritePrecedes } from '@/lib/training/attemptWriteOrder';
import type { RecordPlayedMoveRequest, EnrichTrainingAttemptRequest, RevealTrainingAttemptRequest } from '@/lib/training/attemptApi';
const record: RecordPlayedMoveRequest = { kind: 'RECORD', clientAttemptId: 'attempt', momentRevisionId: 'revision', stepIndex: 0, contextId: 'context', moveUci: 'e2e4', playedAt: '2026-09-06T00:00:00Z', initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING', timeSpentMs: 0 };
const enrich: EnrichTrainingAttemptRequest = { kind: 'ENRICH', clientAttemptId: 'attempt', momentRevisionId: 'revision', stepIndex: 0, eventId: 'event', sequence: 1, supersedesEventId: null, evaluatedAt: record.playedAt, resolution: 'UNAVAILABLE', assessmentId: null, evaluation: null };
it('blocks same-stream enrichment behind pending record, including in-flight record and older correction', () => {
    expect(attemptWritePrecedes(record, enrich)).toBe(true);
    expect(attemptWritePrecedes(enrich, { ...enrich, sequence: 2 })).toBe(true);
    expect(attemptWritePrecedes(enrich, record)).toBe(false);
    expect(attemptWritePrecedes(record, { ...enrich, clientAttemptId: 'another' })).toBe(false);
    expect(attemptWritePrecedes(record, { ...enrich, momentRevisionId: 'another' })).toBe(false);
});

it('keeps reveal behind all earlier played moves and refinements in its stream', () => {
    const reveal: RevealTrainingAttemptRequest = { kind: 'REVEAL', clientAttemptId: record.clientAttemptId, momentRevisionId: record.momentRevisionId, revealedAt: '2026-09-06T00:00:02Z' };
    expect(attemptWritePrecedes(record, reveal)).toBe(true);
    expect(attemptWritePrecedes(enrich, reveal)).toBe(true);
    expect(attemptWritePrecedes({ ...record, stepIndex: 1 }, reveal)).toBe(true);
    expect(attemptWritePrecedes(reveal, record)).toBe(false);
    expect(attemptWritePrecedes(reveal, enrich)).toBe(false);
    expect(attemptWritePrecedes(reveal, reveal)).toBe(false);
    expect(attemptWritePrecedes(record, { ...reveal, clientAttemptId: 'another' })).toBe(false);
    expect(attemptWritePrecedes(record, { ...reveal, momentRevisionId: 'another' })).toBe(false);
});
