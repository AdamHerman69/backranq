import { deriveCorroboratedSelection } from '@/lib/training/selectionPolicy';
import { Chess } from 'chess.js';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import { createAssessmentEvaluator, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex } from '@/lib/training/answerIndex';
import {
    DEFAULT_ASSESSMENT_POLICY, legalMovesUci, practiceContextId,
    type ComparisonFrame, type EvidenceStore, type PracticeMomentRevision,
} from '@/lib/training/practiceContract';
import { reviewForPracticeManifest } from '@/lib/training/practiceReview';
import type { LandingPuzzleDto } from './contracts';

const ROOT_FEN = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const ORIGINAL_MOVE = 'f7e6';
const PREFERRED_MOVE = 'f7f8';
const ID = 'warmup:clean-finish-v4';
const contextId = practiceContextId(ROOT_FEN, [], 'WHITE');
const evidenceId = `${ID}:terminal-rules`;
const legal = legalMovesUci(ROOT_FEN);
const terminalResults = legal.flatMap(moveUci => {
    const board = new Chess(ROOT_FEN);
    board.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4), promotion: moveUci[4] });
    const terminal = ruleTerminalEvaluation(board.fen(), [ROOT_FEN]);
    if (!terminal?.terminal) return [];
    return [{ moveUci, outcome: terminal.terminal.outcome === 'LOSS' ? 'WIN' as const : 'DRAW' as const,
        distance: terminal.terminal.kind === 'CHECKMATE' ? 1 : null }];
});
const evidence: EvidenceStore = { searches: {}, observations: {}, exact: {
    [evidenceId]: { id: evidenceId, contextId, fen: ROOT_FEN, positionHistory: [], trainingSide: 'WHITE',
        source: 'RULE', provider: 'chess.js/FIDE', rules: 'FIDE', complete: true,
        rootScopeUci: terminalResults.map(result => result.moveUci), results: terminalResults },
} };
const frame: ComparisonFrame = { id: `${ID}:frame`, contextId, policyId: DEFAULT_ASSESSMENT_POLICY.id,
    engineFingerprint: 'FIDE-rules', model: 'EXACT_OUTCOME', referenceAssessmentId: `${ID}:${PREFERRED_MOVE}`,
    status: 'CURRENT', supersededById: null };
const evaluate = createAssessmentEvaluator(evidence);
const assessments = terminalResults.map(result => evaluate(frame, {
    id: `${ID}:${result.moveUci}`, moveUci: result.moveUci, trainingSide: 'WHITE', referenceMoveUci: PREFERRED_MOVE,
    originalMoveUci: ORIGINAL_MOVE,
}));
const rootAnswerIndex = deriveAnswerIndex({ contextId, frameId: frame.id, legalMovesUci: legal,
    preferredMoveUci: PREFERRED_MOVE, assessments, coverageGroups: [] });

/** Only terminal moves are classified. Other legal queen/king moves remain unknown. */
export const WARMUP_MANIFEST: PracticeMomentRevision = {
    contractVersion: 5, momentId: ID, revisionId: ID,
    // SHA256 of canonicalPracticeSemantics, verified by the focused warmup test.
    semanticHash: "b0a1dc6b9347d023beffc8e5d28d41302d563f89eff0abd3bb474efffdd7eb9e",
    source: { gameId: 'curated-warmup', sourcePgnHash: 'curated-clean-finish-v4', decisionPly: 0,
        contextId, fen: ROOT_FEN, positionHistory: [], trainingSide: 'WHITE', originalMoveUci: ORIGINAL_MOVE },
    policyId: DEFAULT_ASSESSMENT_POLICY.id, policySnapshot: { ...DEFAULT_ASSESSMENT_POLICY },
    executionProfileId: 'warmup-exact-rules-v4', executionProfileSnapshot: { id: 'warmup-exact-rules-v4', minimumConfirmationNodes: 1 },
    generatorVersion: 'backranq-practice-v4',
    selection: {} as PracticeMomentRevision['selection'],
    decision: deriveDecisionAssessment({ original: assessments.find(a => a.moveUci === ORIGINAL_MOVE)!,
        reference: assessments.find(a => a.moveUci === PREFERRED_MOVE)!, frame, evidence, minimumConfirmationNodes: 1 }),
    rootAnswerIndex,
    continuation: { mode: 'SINGLE_DECISION',
        explanationLines: [{ startContextId: contextId, movesUci: [PREFERRED_MOVE], stopReason: 'CHECKMATE' }],
        nodes: [{ id: contextId, contextId, fen: ROOT_FEN, positionHistory: [], trainingSide: 'WHITE',
            role: 'USER', answerIndex: rootAnswerIndex }], edges: [] },
    frames: [frame], assessments, coverageGroups: [], evidence,
};
WARMUP_MANIFEST.selection = deriveCorroboratedSelection(WARMUP_MANIFEST);
export const WARMUP_PUZZLE: LandingPuzzleDto = {
    id: ID,
    prompt: { id: ID, solutionRevisionId: ID, fen: ROOT_FEN, sideToMove: 'w', grading: WARMUP_MANIFEST,
        review: reviewForPracticeManifest({ manifest: WARMUP_MANIFEST, provider: 'lichess',
            playedAt: '2026-01-01T00:00:00.000Z', sourceKinds: ['MISSED_OPPORTUNITY'], lessonKinds: [], themes: ['mate'] }) },
    context: { kind: 'WARMUP', headline: 'Quick warm-up: find the clean finish',
        teaser: 'A pre-analyzed position while we prepare one from your games.', sourceUrl: null, playedAt: null },
};
