import { Chess } from 'chess.js';
import type { EngineWdl, MultiPvLine, Score } from './stockfishClient';

export const T2_SELECTION_POLICY_ID = 'practice-selection-t2-v1' as const;
export const CORROBORATED_SELECTION_POLICY_ID = 'practice-selection-corroborated-v1' as const;
export type SelectionPolicyId = typeof T2_SELECTION_POLICY_ID | typeof CORROBORATED_SELECTION_POLICY_ID;
export const T2_BUDGETS = { scanNodes: 100_000, confirmationNodes: 200_000, rootMultiPv: 3, candidateNodes: 400_000, gameNodes: 2_000_000 } as const;
export const invertT2Score = (score: Score): Score => ({ ...score, value: -score.value });
export const invertT2Wdl = (wdl: EngineWdl): EngineWdl => ({ win: wdl.loss, draw: wdl.draw, loss: wdl.win });

export type T2PointDecision = {
    ply: number;
    originalMoveUci: string;
    preferredMoveUci: string | null;
    candidate: boolean;
    admitted: boolean;
    reason: string;
    estimate: 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
    lossCp: number | null;
    lossExpectedScore: number | null;
    referenceScore: Score | null;
    originalScore: Score | null;
    referenceWdl?: EngineWdl;
    originalWdl?: EngineWdl;
    comparisonBasis: 'SAME_ROOT' | 'PARENT_CHILD_SCAN';
    evidenceIds: string[];
    targetedVerification?: {
        triggers: Array<'WDL_ONLY' | 'SCAN_ACCEPTANCE_DISAGREEMENT'>;
        outcome: 'NOT_TRIGGERED' | 'VERIFIED' | 'UNRESOLVED' | 'SKIPPED_BUDGET' | 'INVALID_VERIFICATION';
        requestedNodes: number;
        searchIds: string[];
        scanSnapshotIds: string[];
        initial: Pick<T2PointDecision, 'admitted' | 'estimate' | 'reason' | 'lossCp' | 'lossExpectedScore'>;
    };
};

export function validT2Line(fen: string, line: MultiPvLine | undefined): boolean {
    if (!line?.score || !Number.isFinite(line.score.value) || !line.pvUci.length) return false;
    if ('bound' in line) return false;
    try {
        const board = new Chess(fen);
        for (const move of line.pvUci) {
            if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) return false;
            board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
        }
        return true;
    } catch { return false; }
}

function expected(wdl: EngineWdl | undefined): number | null {
    if (!wdl || [wdl.win, wdl.draw, wdl.loss].some(n => !Number.isFinite(n) || n < 0)) return null;
    const total = wdl.win + wdl.draw + wdl.loss;
    return Number.isFinite(total) && total > 0 ? (wdl.win + wdl.draw / 2) / total : null;
}

export type T2PointInput = Pick<T2PointDecision, 'ply' | 'originalMoveUci' | 'preferredMoveUci' | 'referenceScore' | 'originalScore'
    | 'referenceWdl' | 'originalWdl' | 'comparisonBasis' | 'evidenceIds'>;

/** Selection estimate; answer assessment is an independent contract. */
function pointDecision(input: T2PointInput): T2PointDecision {
    const result: T2PointDecision = { ...input, candidate: false, admitted: false, estimate: 'UNKNOWN',
        reason: 'MISSING_VALID_EVIDENCE', lossCp: null, lossExpectedScore: null };
    const best = input.referenceScore; const original = input.originalScore;
    if (!best || !original || !input.preferredMoveUci || !Number.isFinite(best.value) || !Number.isFinite(original.value)) return result;
    if (input.originalMoveUci === input.preferredMoveUci) return { ...result, estimate: 'GOOD', reason: 'ORIGINAL_IS_PREFERRED', lossCp: 0, lossExpectedScore: 0 };
    if (best.type !== original.type) return { ...result, candidate: true, reason: 'MIXED_SCORE_KINDS' };
    if (best.type === 'mate' && original.type === 'mate') {
        // mate 0 is ambiguous without an exact terminal certificate; never infer its winner here.
        if (!best.value || !original.value) return { ...result, candidate: true, reason: 'MATE_ZERO_REQUIRES_EXACT_OUTCOME' };
        if (Math.sign(best.value) === Math.sign(original.value)) return { ...result, estimate: 'GOOD', reason: 'SAME_MATE_WINNER' };
        if (best.value < original.value) return { ...result, candidate: true, reason: 'REFERENCE_CONTRADICTION' };
        return { ...result, candidate: true, admitted: true, estimate: 'BELOW_STANDARD', reason: 'ENGINE_MATE_WINNER_LOSS' };
    }
    const lossCp = best.value - original.value;
    const bestE = expected(input.referenceWdl); const originalE = expected(input.originalWdl);
    if ((input.referenceWdl !== undefined || input.originalWdl !== undefined) && (bestE === null || originalE === null)) {
        return { ...result, candidate: true, lossCp, reason: 'WDL_MISSING_OR_INVALID' };
    }
    const lossExpectedScore = bestE === null || originalE === null ? null : bestE - originalE;
    Object.assign(result, { lossCp, lossExpectedScore });
    if (lossCp < 0 || (lossExpectedScore !== null && lossExpectedScore < 0)) return { ...result, candidate: true, reason: 'REFERENCE_CONTRADICTION' };
    result.candidate = lossCp >= 30 || (lossExpectedScore !== null && lossExpectedScore >= 0.03);
    const tolerance = Math.min(300, Math.max(100, 0.6 * Math.max(0, best.value)));
    result.estimate = lossCp > tolerance || (lossExpectedScore !== null && lossExpectedScore > 0.1) ? 'BELOW_STANDARD' : 'GOOD';
    const meaningful = lossExpectedScore === null ? lossCp >= 100 && Math.abs(best.value) < 300 : lossExpectedScore >= 0.08;
    result.admitted = result.estimate === 'BELOW_STANDARD' && meaningful;
    result.reason = result.admitted ? 'POINT_MISTAKE' : result.estimate === 'BELOW_STANDARD' ? 'NO_MEANINGFUL_SELECTION_SIGNAL'
        : result.candidate ? 'POINT_GOOD' : 'BELOW_CANDIDATE_SIGNAL';
    return result;
}

/** Frozen T2 point semantics. WDL is engine evidence, never a rule-exact certificate. */
export function computeT2PointDecision(input: T2PointInput): T2PointDecision {
    const best = input.referenceScore; const original = input.originalScore;
    if (!best || !original || best.type === original.type) return pointDecision(input);
    const unresolved: T2PointDecision = { ...input, candidate: true, admitted: false, estimate: 'UNKNOWN',
        lossCp: null, lossExpectedScore: null, reason: 'MIXED_WDL_MISSING_OR_INVALID' };
    if (!input.preferredMoveUci || !Number.isFinite(best.value) || !Number.isFinite(original.value)) {
        return { ...unresolved, reason: 'MISSING_VALID_EVIDENCE' };
    }
    const normalized = (wdl: EngineWdl | undefined) => {
        if (!wdl || !Number.isFinite(wdl.win + wdl.draw + wdl.loss)) return null;
        return expected(wdl);
    };
    const bestE = normalized(input.referenceWdl); const originalE = normalized(input.originalWdl);
    if (bestE === null || originalE === null) return unresolved;
    const mate = best.type === 'mate' ? best : original;
    if (!Number.isInteger(mate.value) || mate.value === 0) return { ...unresolved, reason: 'MIXED_MATE_REQUIRES_NONZERO_DISTANCE' };
    const mateE = best.type === 'mate' ? bestE : originalE;
    if (mateE !== (mate.value > 0 ? 1 : 0)) return { ...unresolved, reason: 'MIXED_MATE_WDL_CONTRADICTION' };
    const lossExpectedScore = bestE - originalE;
    if (lossExpectedScore < 0) return { ...unresolved, lossExpectedScore, reason: 'MIXED_WDL_REFERENCE_CONTRADICTION' };
    if (input.originalMoveUci === input.preferredMoveUci) return { ...unresolved, candidate: false,
        estimate: 'GOOD', lossExpectedScore: 0, reason: 'ORIGINAL_IS_PREFERRED' };
    const below = lossExpectedScore > 0.1;
    return { ...unresolved, candidate: lossExpectedScore >= 0.03, admitted: below,
        estimate: below ? 'BELOW_STANDARD' : 'GOOD', lossExpectedScore,
        reason: below ? 'MIXED_WDL_OUTCOME_LOSS' : 'MIXED_WDL_WITHIN_TOLERANCE' };
}
