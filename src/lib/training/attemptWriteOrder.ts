import type { TrainingAttemptWriteRequest } from './attemptApi';

export function sameAttemptWriteStream(a: TrainingAttemptWriteRequest, b: TrainingAttemptWriteRequest): boolean {
    return a.clientAttemptId === b.clientAttemptId && a.momentRevisionId === b.momentRevisionId;
}
/** Pending durable predecessors block direct and background sends alike. */
export function attemptWritePrecedes(a: TrainingAttemptWriteRequest, b: TrainingAttemptWriteRequest): boolean {
    if (!sameAttemptWriteStream(a, b) || a.kind === 'REVEAL') return false;
    if (b.kind === 'REVEAL') return true;
    if (a.stepIndex !== b.stepIndex) return a.stepIndex < b.stepIndex;
    if (a.kind === 'RECORD') return b.kind === 'ENRICH';
    return b.kind === 'ENRICH' && a.sequence < b.sequence;
}
