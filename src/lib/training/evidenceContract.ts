import type { DecisionAssessment } from './practiceContract';

/** A receipt projects status/reason only; it is not an authority for Practice grading. */
export function decisionAssessment(value: unknown): Pick<DecisionAssessment, 'status' | 'reason'> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    if ((input.status !== 'CONFIRMED_MISTAKE' && input.status !== 'NOT_A_MISTAKE' && input.status !== 'UNRESOLVED') || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 512) return null;
    return { status: input.status, reason: input.reason };
}
