import { Chess } from 'chess.js';
import { moveToUci } from '@/lib/chess/utils';
import { assessmentPositionKey } from './assessmentIdentity';
import type { AnswerCoverage, ContinuationReadiness, DecisionAssessment } from './contracts';

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown, max = 512): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function decisionAssessment(value: unknown): DecisionAssessment | null {
    return record(value) &&
        ['CONFIRMED_MISTAKE', 'NOT_A_MISTAKE', 'UNRESOLVED'].includes(String(value.status)) &&
        text(value.reason)
        ? value as DecisionAssessment
        : null;
}

export function continuationReadiness(value: unknown): ContinuationReadiness | null {
    if (!record(value)) return null;
    const explanation = value.explanationAvailable;
    const graded = value.gradedContinuationReady;
    if (typeof explanation !== 'boolean' || typeof graded !== 'boolean') return null;
    if (value.status === 'NONE' && !explanation && !graded ||
        value.status === 'EXPLANATION_ONLY' && explanation && !graded ||
        value.status === 'GRADED_BRANCHES_READY' && graded) {
        return value as ContinuationReadiness;
    }
    return null;
}

/** Structural evidence validation; this does not turn client scores into server proof. */
export function answerCoverage(value: unknown, args: {
    fen: string;
    positionHistory: readonly string[];
    policyVersion: number;
    acceptedMovesUci: readonly string[];
}): AnswerCoverage | null {
    if (!record(value) || value.version !== 1 ||
        value.contextId !== assessmentPositionKey(args.fen, args.positionHistory) ||
        value.policyVersion !== args.policyVersion || !text(value.referenceId) ||
        !text(value.reason) ||
        !['PARTIAL', 'QUALITY_BOUNDARY_VERIFIED', 'ALL_LEGAL_ASSESSED'].includes(String(value.status))) return null;
    const legal = new Set(new Chess(args.fen).moves({ verbose: true }).map(moveToUci));
    const arrays: string[][] = [];
    for (const key of ['legalMovesUci', 'assessedMovesUci', 'coveredMovesUci']) {
        const moves = value[key];
        if (!Array.isArray(moves) || moves.length > 256 ||
            moves.some(move => typeof move !== 'string' || !legal.has(move)) ||
            new Set(moves).size !== moves.length) return null;
        arrays.push(moves);
    }
    const [listedLegal, assessed, covered] = arrays as [string[], string[], string[]];
    if (listedLegal.length !== legal.size ||
        args.acceptedMovesUci.some(move => !assessed.includes(move) || covered.includes(move))) return null;
    if (value.status === 'PARTIAL' && covered.length > 0) return null;
    if (value.status === 'ALL_LEGAL_ASSESSED' && assessed.length !== legal.size) return null;
    if (value.status === 'QUALITY_BOUNDARY_VERIFIED' &&
        new Set([...assessed, ...covered]).size !== legal.size) return null;
    if (covered.length > 0 && !record(value.evidence)) return null;
    return value as AnswerCoverage;
}
