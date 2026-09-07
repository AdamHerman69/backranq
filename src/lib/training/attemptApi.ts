import type { AttemptMove, MoveAssessment, PracticeEvaluationPatch, Quality, Tier } from './practiceContract';

export type AttemptResolution = 'PENDING' | 'RESOLVED' | 'UNAVAILABLE';
export type AttemptStatus = AttemptResolution | 'REVEALED';
export type RecordPlayedMoveRequest = AttemptMove & { kind: 'RECORD'; timeSpentMs: number | null };
export type RevealTrainingAttemptRequest = {
    kind: 'REVEAL'; clientAttemptId: string; momentRevisionId: string; revealedAt: string;
};
export type RecordTrainingAttemptRequest = RecordPlayedMoveRequest | RevealTrainingAttemptRequest;
export type EnrichTrainingAttemptRequest = {
    kind: 'ENRICH'; clientAttemptId: string; momentRevisionId: string; stepIndex: number;
    eventId: string; sequence: number; supersedesEventId: string | null; evaluatedAt: string;
    resolution: 'RESOLVED' | 'UNAVAILABLE'; assessmentId: string | null;
    evaluation: PracticeEvaluationPatch | null;
};
export type TrainingAttemptWriteRequest = RecordTrainingAttemptRequest | EnrichTrainingAttemptRequest;
export type RecordTrainingAttemptResponse = {
    attemptId: string; idempotentReplay: boolean; status: AttemptStatus;
    quality: Quality; tier: Tier | null; originalRelation: MoveAssessment['originalRelation'];
};
export type EnrichTrainingAttemptResponse = RecordTrainingAttemptResponse & { applied: boolean };
