import { Chess } from 'chess.js';
import { claimableDraw, ruleTerminalEvaluation } from './ruleEvaluation';
import {
    conservativeTablebaseWdl, invertTablebaseWdl, pieceCountFromFen,
    TABLEBASE_MAX_PIECES, type TablebaseEvidence,
} from './tablebase';
import {
    DEFAULT_ASSESSMENT_POLICY, legalMovesUci, practiceContextId, practiceFingerprint,
    type AssessmentPolicy, type ComparisonFrame, type EvidenceStore, type ExactRecord,
    type Outcome, type Side,
} from '@/lib/training/practiceContract';
import { createAssessmentEvaluator, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex } from '@/lib/training/answerIndex';

export type PracticeExactContext = {
    fen: string; positionHistory: string[]; trainingSide: Side;
    /** Already fetched provider response; this module never probes a provider. */
    tablebase?: TablebaseEvidence | null;
};
function after(fen: string, move: string): Chess {
    const board = new Chess(fen);
    board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    return board;
}
function terminalOutcome(fen: string, history: string[], side: Side): Outcome | null {
    const terminal = ruleTerminalEvaluation(fen, history)?.terminal;
    if (!terminal) return null;
    if (terminal.outcome === 'DRAW') return 'DRAW';
    return (new Chess(fen).turn() === 'w' ? 'WHITE' : 'BLACK') === side ? 'LOSS' : 'WIN';
}
function exactRecord(context: PracticeExactContext, source: ExactRecord['source'], provider: string, results: ExactRecord['results'], physical: unknown): ExactRecord {
    const contextId = practiceContextId(context.fen, context.positionHistory, context.trainingSide);
    return { id: `${source.toLowerCase()}:${contextId}:${practiceFingerprint(physical)}`, contextId,
        fen: context.fen, positionHistory: [...context.positionHistory], trainingSide: context.trainingSide,
        source, provider, rules: 'FIDE', complete: true, rootScopeUci: results.map(result => result.moveUci).sort(), results };
}
/** Exact terminal moves do not imply anything about other legal moves. */
export function collectPracticeExactEvidence(context: PracticeExactContext): { evidence: EvidenceStore; diagnostics: string[] } {
    const evidence: EvidenceStore = { searches: {}, observations: {}, exact: {} }; const diagnostics: string[] = [];
    const board = new Chess(context.fen);
    if ((board.turn() === 'w' ? 'WHITE' : 'BLACK') !== context.trainingSide) return { evidence, diagnostics: ['NOT_TRAINING_SIDE_DECISION'] };
    if (ruleTerminalEvaluation(context.fen, context.positionHistory)) return { evidence, diagnostics: ['MANDATORY_ROOT_TERMINAL'] };
    const legal = legalMovesUci(context.fen); const nextHistory = [...context.positionHistory, context.fen];
    const terminalResults: ExactRecord['results'] = legal.flatMap(moveUci => {
        const next = after(context.fen, moveUci); const outcome = terminalOutcome(next.fen(), nextHistory, context.trainingSide);
        return outcome ? [{ moveUci, outcome, distance: next.isCheckmate() ? 1 : null }] : [];
    });
    if (terminalResults.length) {
        const record = exactRecord(context, 'RULE', 'chess.js/FIDE', terminalResults, terminalResults);
        evidence.exact[record.id] = record;
    }
    const tb = context.tablebase;
    if (!tb) return { evidence, diagnostics };
    const reject = (reason: string) => ({ evidence, diagnostics: [...diagnostics, reason] });
    if (tb.source !== 'LICHESS_SYZYGY' || tb.fen !== context.fen || tb.pieceCount !== pieceCountFromFen(context.fen) || tb.pieceCount > TABLEBASE_MAX_PIECES || context.fen.split(' ')[2] !== '-') return reject('TABLEBASE_INCOMPATIBLE_POSITION');
    if (tb.terminal.checkmate || tb.terminal.stalemate || tb.terminal.insufficientMaterial) return reject('TABLEBASE_INCONSISTENT_TERMINAL_FLAGS');
    if (claimableDraw(context.fen, context.positionHistory)) return reject('TABLEBASE_ROOT_DRAW_CLAIM');
    // Syzygy's FEN-only response cannot certify effects of an already reversible
    // path. A prior irreversible move (halfmove=0) removes that repetition risk.
    const reversiblePlies = Number(context.fen.split(' ')[4]);
    if (reversiblePlies > 0 && context.positionHistory.slice(-reversiblePlies).length) return reject('TABLEBASE_UNMODELLED_REPETITION_HISTORY');
    if (tb.wdl === 'UNKNOWN' || conservativeTablebaseWdl(tb.category) !== tb.wdl || tb.moves.length !== legal.length || new Set(tb.moves.map(move => move.uci)).size !== legal.length || tb.moves.some(move => !legal.includes(move.uci) || move.wdl === 'UNKNOWN' || invertTablebaseWdl(conservativeTablebaseWdl(move.categoryAfterMove)) !== move.wdl)) return reject('TABLEBASE_INCOMPLETE_OR_INCONSISTENT_SCOPE');
    const results: ExactRecord['results'] = [];
    for (const move of tb.moves) {
        const next = after(context.fen, move.uci); const outcome = move.wdl as Outcome;
        const ruleOutcome = terminalOutcome(next.fen(), nextHistory, context.trainingSide);
        if (ruleOutcome && ruleOutcome !== outcome) return reject('TABLEBASE_CONTRADICTS_TERMINAL_RULE');
        if (!ruleOutcome && claimableDraw(next.fen(), nextHistory)) return reject('TABLEBASE_CHILD_DRAW_CLAIM');
        const rawDtz = move.preciseDtz ?? move.dtz;
        const distance = rawDtz === undefined ? null : Math.abs(rawDtz);
        if (distance !== null && (!Number.isSafeInteger(distance) || distance < 0)) return reject('TABLEBASE_INVALID_DISTANCE');
        const childHalfmove = Number(next.fen().split(' ')[4]);
        if (!ruleOutcome && outcome !== 'DRAW' && (distance === null || childHalfmove + distance >= 100)) return reject('TABLEBASE_FIFTY_MOVE_BOUND_UNPROVEN');
        results.push({ moveUci: move.uci, outcome, distance: ruleOutcome ? next.isCheckmate() ? 1 : null : distance });
    }
    const ranks = { LOSS: 0, DRAW: 1, WIN: 2 };
    if (Math.max(...results.map(result => ranks[result.outcome])) !== ranks[tb.wdl]) return reject('TABLEBASE_ROOT_OUTCOME_UNSUPPORTED');
    const record = exactRecord(context, 'TABLEBASE', 'LICHESS_SYZYGY', results, tb);
    evidence.exact[record.id] = record;
    return { evidence, diagnostics };
}

/** No engine or network work: projects supplied exact proofs into the shared contract. */
export function assessPracticeExactPosition(args: PracticeExactContext & { originalMoveUci: string; policy?: AssessmentPolicy }) {
    const collected = collectPracticeExactEvidence(args); const { evidence } = collected;
    const records = Object.values(evidence.exact);
    if (!records.length) return null;
    const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const contextId = practiceContextId(args.fen, args.positionHistory, args.trainingSide);
    const legal = legalMovesUci(args.fen); const ranks = { LOSS: 0, DRAW: 1, WIN: 2 };
    if (!legal.includes(args.originalMoveUci) || legal.length < 2) return null;
    // Complete TB can establish DRAW/LOSS as the root optimum. Partial RULE
    // results establish an optimum only when a winning move reaches the maximum.
    const referenceRecord = records.find(record => record.source === 'TABLEBASE') ?? records.find(record => record.results.some(result => result.outcome === 'WIN'));
    if (!referenceRecord) return null;
    const ordered = [...referenceRecord.results].sort((a, b) => ranks[b.outcome] - ranks[a.outcome] || (a.distance ?? Infinity) - (b.distance ?? Infinity) || a.moveUci.localeCompare(b.moveUci));
    const preferredMoveUci = ordered[0].moveUci;
    const frameId = `${contextId}:exact-frame:${practiceFingerprint([policy.id, records.map(record => record.id)])}`;
    const assessmentId = (move: string) => `${frameId}:move:${move}`;
    const frame: ComparisonFrame = { id: frameId, contextId, policyId: policy.id,
        engineFingerprint: referenceRecord.source === 'RULE' ? 'FIDE-rules' : 'LICHESS_SYZYGY', model: 'EXACT_OUTCOME',
        referenceAssessmentId: assessmentId(preferredMoveUci), status: 'CURRENT', supersededById: null };
    const moves = [...new Set([args.originalMoveUci, ...records.flatMap(record => record.results.map(result => result.moveUci))])].sort();
    const evaluate = createAssessmentEvaluator(evidence);
    const assessments = moves.map(moveUci => evaluate(frame, { id: assessmentId(moveUci), moveUci,
        trainingSide: args.trainingSide, referenceMoveUci: preferredMoveUci, originalMoveUci: args.originalMoveUci }, policy));
    const original = assessments.find(a => a.moveUci === args.originalMoveUci)!;
    const reference = assessments.find(a => a.id === frame.referenceAssessmentId)!;
    const decision = deriveDecisionAssessment({ original, reference, frame, evidence, minimumConfirmationNodes: 1, policy });
    const rootAnswerIndex = deriveAnswerIndex({ contextId, frameId, legalMovesUci: legal, preferredMoveUci, assessments, coverageGroups: [] });
    return { frame, assessments, evidence, decision, rootAnswerIndex, bestLineUci: [preferredMoveUci], diagnostics: collected.diagnostics };
}
