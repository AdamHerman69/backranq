import { Chess } from 'chess.js';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import { computeT2PointDecision, T2_SELECTION_POLICY_ID, CORROBORATED_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import type { Score } from '@/lib/analysis/stockfishClient';
import {
    canonicalJson, legalMovesUci, practiceContextId,
    type AnalysisObservation, type PracticeMomentRevision, type PracticeScore,
    type PracticeSelection, type SelectionComparison, type SourceDecision, type Side, type Wdl,
} from './practiceContract';

export { T2_SELECTION_POLICY_ID, CORROBORATED_SELECTION_POLICY_ID };
type SelectionRevision = Pick<PracticeMomentRevision, 'source' | 'decision' | 'assessments' | 'frames' | 'evidence' | 'rootAnswerIndex'>;
export type T2SelectionInput = {
    policyId?: typeof T2_SELECTION_POLICY_ID;
    referenceSearchId: string; originalSearchId?: string;
    comparisonBasis: 'SAME_ROOT' | 'PARENT_CHILD_SCAN'; preferredMoveUci: string;
};
function requireSelection(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`Selection: ${message}`);
}
export function originalSelectionContext(source: SourceDecision) {
    const board = new Chess(source.fen); const move = source.originalMoveUci;
    board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    const fen = board.fen(); const positionHistory = [...source.positionHistory, source.fen];
    return { fen, positionHistory, trainingSide: source.trainingSide,
        contextId: practiceContextId(fen, positionHistory, source.trainingSide) };
}
function normalizedScore(score: PracticeScore, side: Side): PracticeScore {
    if (score.pov === side) return { ...score };
    if (score.kind === 'CP') return { ...score, cp: -score.cp, pov: side };
    if (score.kind === 'MATE') return { ...score, pov: side };
    return { ...score, outcome: score.outcome === 'WIN' ? 'LOSS' : score.outcome === 'LOSS' ? 'WIN' : 'DRAW', pov: side };
}
function normalizedWdl(wdl: Wdl | null, score: PracticeScore, side: Side): Wdl | null {
    return !wdl ? null : score.pov === side ? { ...wdl } : { win: wdl.loss, draw: wdl.draw, loss: wdl.win };
}
function finalPoint(revision: SelectionRevision, searchId: string): AnalysisObservation {
    const search = revision.evidence.searches[searchId];
    requireSelection(search?.completion === 'COMPLETED', 'comparison needs a completed physical search');
    const observation = search.observationIds.map(id => revision.evidence.observations[id])
        .filter(o => o?.bundleComplete).sort((a, b) => a.snapshotIndex - b.snapshotIndex).at(-1);
    requireSelection(observation && observation.lines.every(line => line.bound === 'UNBOUNDED'), 'comparison needs a complete point bundle');
    return observation;
}
function comparisonFromSearches(revision: SelectionRevision, input: T2SelectionInput): SelectionComparison {
    const { source, evidence } = revision;
    const reference = finalPoint(revision, input.referenceSearchId);
    requireSelection(reference.contextId === source.contextId, 'reference belongs to a different decision');
    requireSelection(canonicalJson(reference.rootScopeUci) === canonicalJson(legalMovesUci(source.fen)), 'reference must search the full legal root');
    const best = reference.lines[0];
    requireSelection(best?.moveUci === input.preferredMoveUci && best.moveUci === revision.rootAnswerIndex.preferredMoveUci, 'recommendation differs from selected root evidence');
    if (input.comparisonBasis === 'PARENT_CHILD_SCAN' && input.originalSearchId?.startsWith('rule:')) {
        const child = originalSelectionContext(source);
        const terminal = ruleTerminalEvaluation(child.fen, child.positionHistory);
        requireSelection(terminal?.searchEvidence?.id === input.originalSearchId, 'terminal child rule identity differs');
        const exact = Object.values(evidence.exact).find(record => record.source === 'RULE'
            && record.contextId === source.contextId && record.results.some(result => result.moveUci === source.originalMoveUci));
        const entry = exact?.results.find(result => result.moveUci === source.originalMoveUci);
        requireSelection(exact && entry, 'terminal child certificate missing');
        return { basis: 'PARENT_CHILD', referenceMoveUci: best.moveUci, originalMoveUci: source.originalMoveUci,
            referenceScore: normalizedScore(best.score, source.trainingSide),
            originalScore: { kind: 'EXACT', outcome: entry.outcome, distance: entry.distance, pov: source.trainingSide },
            referenceWdl: normalizedWdl(best.wdl, best.score, source.trainingSide),
            originalWdl: entry.outcome === 'DRAW' ? { win: 0, draw: 1000, loss: 0 }
                : entry.outcome === 'WIN' ? { win: 1000, draw: 0, loss: 0 } : { win: 0, draw: 0, loss: 1000 },
            referenceObservationId: reference.id, originalObservationId: null, referenceExactId: null, originalExactId: exact.id };
    }
    const original = finalPoint(revision, input.originalSearchId ?? input.referenceSearchId);
    requireSelection(original.engineFingerprint === reference.engineFingerprint, 'comparison engines or WDL models differ');
    let played;
    if (input.comparisonBasis === 'PARENT_CHILD_SCAN') {
        const child = originalSelectionContext(source);
        requireSelection(original.contextId === child.contextId, 'original observation is not the legal child with full history');
        requireSelection(canonicalJson(original.rootScopeUci) === canonicalJson(legalMovesUci(child.fen)), 'child comparison needs full-root evidence');
        played = original.lines[0];
    } else {
        requireSelection(original.contextId === source.contextId, 'original observation belongs to another root');
        const scope = evidence.searches[original.searchId].request.rootScopeUci;
        requireSelection(scope.includes(source.originalMoveUci), 'original search excludes original move');
        played = original.lines.find(line => line.moveUci === source.originalMoveUci);
    }
    requireSelection(played, 'original move has no selected point evidence');
    return {
        basis: input.comparisonBasis === 'PARENT_CHILD_SCAN' ? 'PARENT_CHILD' : 'SAME_ROOT',
        referenceMoveUci: best.moveUci, originalMoveUci: source.originalMoveUci,
        referenceScore: normalizedScore(best.score, source.trainingSide), originalScore: normalizedScore(played.score, source.trainingSide),
        referenceWdl: normalizedWdl(best.wdl, best.score, source.trainingSide), originalWdl: normalizedWdl(played.wdl, played.score, source.trainingSide),
        referenceObservationId: reference.id, originalObservationId: original.id, referenceExactId: null, originalExactId: null,
    };
}
function engineScore(score: PracticeScore): Score | null {
    if (score.kind === 'CP') return { type: 'cp', value: score.cp };
    if (score.kind === 'MATE') return { type: 'mate', value: (score.winner === score.pov ? 1 : -1) * Math.ceil(score.plies / 2) };
    // Preserve frozen T2 rule-terminal selection arithmetic while transporting
    // the true exact outcome. Terminal mate zero remains unresolved in T2.
    return score.outcome === 'DRAW' ? { type: 'cp', value: 0 } : { type: 'mate', value: 0 };
}
function pointSelection(source: SourceDecision, comparison: SelectionComparison): PracticeSelection {
    const result = computeT2PointDecision({
        ply: source.decisionPly, originalMoveUci: source.originalMoveUci, preferredMoveUci: comparison.referenceMoveUci,
        referenceScore: engineScore(comparison.referenceScore), originalScore: engineScore(comparison.originalScore),
        referenceWdl: comparison.referenceWdl ?? undefined, originalWdl: comparison.originalWdl ?? undefined,
        comparisonBasis: comparison.basis === 'PARENT_CHILD' ? 'PARENT_CHILD_SCAN' : 'SAME_ROOT',
        evidenceIds: [],
    });
    return { policyId: T2_SELECTION_POLICY_ID, status: result.admitted ? 'INCLUDED' : 'OMITTED', reason: result.reason, comparison };
}
/** Reuses paid root/child points; neither manufactures votes nor evaluates a position. */
export function deriveT2Selection(revision: SelectionRevision, input: T2SelectionInput): PracticeSelection {
    return pointSelection(revision.source, comparisonFromSearches(revision, input));
}
/** Explicit research selection policy, still produced in the current contract. */
export function deriveCorroboratedSelection(revision: SelectionRevision): PracticeSelection {
    return { policyId: CORROBORATED_SELECTION_POLICY_ID, status: revision.decision.selection,
        reason: revision.decision.selectionReason, comparison: null };
}
/** Exact outcomes use their already validated rule/provider evidence, with no engine budget gate. */
export function deriveT2ExactSelection(revision: SelectionRevision): PracticeSelection {
    const frame = revision.frames.find(f => f.id === revision.rootAnswerIndex.frameId);
    requireSelection(frame?.model === 'EXACT_OUTCOME', 'exact selection needs an exact root frame');
    const original = revision.assessments.find(a => a.id === revision.decision.originalAssessmentId);
    const reference = revision.assessments.find(a => a.id === frame.referenceAssessmentId);
    let comparison: SelectionComparison | null = null;
    if (reference?.score?.kind === 'EXACT' && original?.score?.kind === 'EXACT') {
        const certificate = (assessment: typeof reference, isReference: boolean) => Object.values(revision.evidence.exact).findLast(record => {
            if (!assessment?.score || assessment.score.kind !== 'EXACT' || !assessment.observationIds.includes(record.id)
                || record.contextId !== revision.source.contextId || record.trainingSide !== assessment.score.pov) return false;
            const score = assessment.score;
            const entry = record.results.find(result => result.moveUci === assessment.moveUci
                && result.outcome === score.outcome && result.distance === score.distance);
            if (!entry) return false;
            if (!isReference) return true;
            const ranks = { LOSS: 0, DRAW: 1, WIN: 2 };
            return (entry.outcome === 'WIN' || record.rootScopeUci.length === legalMovesUci(record.fen).length)
                && record.results.every(result => ranks[result.outcome] <= ranks[entry.outcome]);
        });
        const best = certificate(reference, true); const played = certificate(original, false);
        requireSelection(best && played, 'exact comparison certificates missing');
        comparison = { basis: 'EXACT_OUTCOME', referenceMoveUci: reference.moveUci, originalMoveUci: original.moveUci,
            referenceScore: reference.score, originalScore: original.score, referenceWdl: null, originalWdl: null,
            referenceObservationId: null, originalObservationId: null, referenceExactId: best.id, originalExactId: played.id };
    }
    requireSelection(revision.decision.selection !== 'INCLUDED' || comparison, 'included exact selection requires both outcomes');
    return { policyId: T2_SELECTION_POLICY_ID, status: revision.decision.selection, reason: revision.decision.selectionReason, comparison };
}
export function validatePracticeSelection(revision: PracticeMomentRevision): void {
    const selection = revision.selection;
    if (selection.policyId === CORROBORATED_SELECTION_POLICY_ID) {
        requireSelection(canonicalJson(selection) === canonicalJson(deriveCorroboratedSelection(revision)), 'corroborated selection disagrees with its diagnostic');
        return;
    }
    requireSelection(selection.policyId === T2_SELECTION_POLICY_ID, 'unknown selection policy');
    if (revision.frames.find(f => f.id === revision.rootAnswerIndex.frameId)?.model === 'EXACT_OUTCOME') {
        requireSelection(canonicalJson(selection) === canonicalJson(deriveT2ExactSelection(revision)), 'exact selection disagrees with its evidence');
        return;
    }
    const comparison = selection.comparison;
    requireSelection(comparison && comparison.basis !== 'EXACT_OUTCOME', 'T2 comparison missing');
    requireSelection(comparison.referenceObservationId && (comparison.originalObservationId || comparison.originalExactId), 'comparison observation IDs missing');
    const reference = revision.evidence.observations[comparison.referenceObservationId];
    const original = comparison.originalObservationId ? revision.evidence.observations[comparison.originalObservationId] : null;
    const child = originalSelectionContext(revision.source);
    const terminalId = !original && comparison.basis === 'PARENT_CHILD' ? ruleTerminalEvaluation(child.fen, child.positionHistory)?.searchEvidence?.id : undefined;
    requireSelection(reference && (original || terminalId), 'comparison observations missing');
    const expected = deriveT2Selection(revision, { referenceSearchId: reference.searchId, originalSearchId: original?.searchId ?? terminalId,
        preferredMoveUci: comparison.referenceMoveUci, comparisonBasis: comparison.basis === 'PARENT_CHILD' ? 'PARENT_CHILD_SCAN' : 'SAME_ROOT' });
    requireSelection(canonicalJson(selection) === canonicalJson(expected), 'selection is not implied by the selected evidence and policy');
}
/** Physical allocation does not affect the semantic revision identity. */
export function canonicalSelectionSemantics(selection: PracticeSelection): unknown {
    if (!selection.comparison) return selection;
    const c = selection.comparison;
    return { policyId: selection.policyId, status: selection.status, reason: selection.reason, comparison: {
        basis: c.basis, referenceMoveUci: c.referenceMoveUci, originalMoveUci: c.originalMoveUci,
        referenceScore: c.referenceScore, originalScore: c.originalScore, referenceWdl: c.referenceWdl, originalWdl: c.originalWdl,
    } };
}
