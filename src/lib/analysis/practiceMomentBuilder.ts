import type { assessPracticeExactPosition } from './practiceExactEvidence';
import { Chess } from 'chess.js';
import { PositionAnalysisPool } from './positionAnalysisPool';
import { practiceEngineFingerprint, practiceEvidenceFromSnapshots } from './practiceEvidence';
import { createAssessmentEvaluator, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex } from '@/lib/training/answerIndex';
import {
    DEFAULT_ASSESSMENT_POLICY, canonicalPracticeSemantics, legalMovesUci, practiceContextId,
    practiceFingerprint, type AssessmentPolicy, type ComparisonFrame, type PracticeMomentRevision,
    type Side, type SourceDecision,
} from '@/lib/training/practiceContract';
import { sha256Hex } from '@/lib/crypto/sha256';
import { stableCanonicalStringify } from '@/lib/training/contracts';

export function assessPracticePosition(args: {
    pool: PositionAnalysisPool; fen: string; positionHistory: string[];
    trainingSide: Side; originalMoveUci: string; minimumConfirmationNodes: number;
    policy?: AssessmentPolicy;
}) {
    const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const legal = legalMovesUci(args.fen);
    const searches = args.pool.find({ fen: args.fen, previousFens: args.positionHistory });
    const referenceSearch = searches.findLast(search => search.result && !search.result.terminal
        && search.evidence.request.rootMoves.length === legal.length && search.result.lines[0]?.pvUci[0]);
    if (!referenceSearch?.result) return null;
    const preferredMoveUci = referenceSearch.result.lines[0]?.pvUci[0];
    if (!preferredMoveUci) return null;
    const evidence = practiceEvidenceFromSnapshots(
        searches.flatMap(search => search.snapshots), args.trainingSide,
        searches.filter(search => search.result).map(search => search.evidence),
    );
    const contextId = practiceContextId(args.fen, args.positionHistory, args.trainingSide);
    const engineFingerprint = practiceEngineFingerprint(referenceSearch.evidence.engine);
    const frameId = `${contextId}:frame:${practiceFingerprint([engineFingerprint, referenceSearch.evidence.id])}`;
    const assessmentId = (move: string) => `${frameId}:move:${move}`;
    const frame: ComparisonFrame = {
        id: frameId, contextId, policyId: policy.id, engineFingerprint,
        model: referenceSearch.result.lines[0]?.wdl ? 'MATCHED_WDL' : 'CP_ONLY',
        referenceAssessmentId: assessmentId(preferredMoveUci), status: 'CURRENT', supersededById: null,
    };
    const assessedMoves = new Set([preferredMoveUci, args.originalMoveUci,
        ...Object.values(evidence.observations).filter(o => o.engineFingerprint === engineFingerprint)
            .flatMap(o => o.lines.map(line => line.moveUci))]);
    const assess = createAssessmentEvaluator(evidence);
    const assessments = [...assessedMoves].sort().map(moveUci => assess(frame, {
        id: assessmentId(moveUci), moveUci, trainingSide: args.trainingSide,
        referenceMoveUci: preferredMoveUci, originalMoveUci: args.originalMoveUci,
    }, policy));
    const reference = assessments.find(a => a.id === frame.referenceAssessmentId)!;
    const original = assessments.find(a => a.moveUci === args.originalMoveUci)!;
    const decision = deriveDecisionAssessment({ original, reference, frame, evidence,
        minimumConfirmationNodes: args.minimumConfirmationNodes, policy });
    const rootAnswerIndex = deriveAnswerIndex({ contextId, frameId, legalMovesUci: legal,
        preferredMoveUci, assessments, coverageGroups: [] });
    return { frame, assessments, evidence, decision, rootAnswerIndex,
        bestLineUci: referenceSearch.result.lines[0]?.pvUci ?? [] };
}

/** Pure projection over already-paid evidence. This function cannot call an engine. */
export async function buildPracticeMomentRevision(args: {
    pool: PositionAnalysisPool; source: SourceDecision; executionProfileId: string;
    minimumConfirmationNodes: number; policy?: AssessmentPolicy;
    exactRoot?: ReturnType<typeof assessPracticeExactPosition>;
}): Promise<PracticeMomentRevision | null> {
    const root = args.exactRoot ?? assessPracticePosition({ ...args, fen: args.source.fen,
        positionHistory: args.source.positionHistory, trainingSide: args.source.trainingSide,
        originalMoveUci: args.source.originalMoveUci });
    if (!root) return null;
    const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const board = new Chess(args.source.fen);
    const explanation: string[] = [];
    for (const move of root.bestLineUci.slice(0, 12)) {
        try { board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] }); }
        catch { break; }
        explanation.push(move);
    }
    const manifest: PracticeMomentRevision = {
        contractVersion: 4,
        momentId: `source:${practiceFingerprint([args.source.gameId, args.source.sourcePgnHash, args.source.decisionPly])}`,
        revisionId: `analysis:${root.frame.id}`, semanticHash: '0'.repeat(64), source: args.source,
        policyId: policy.id, policySnapshot: structuredClone(policy), executionProfileId: args.executionProfileId,
        executionProfileSnapshot: { id: args.executionProfileId, minimumConfirmationNodes: Math.max(1, args.minimumConfirmationNodes) },
        generatorVersion: 'backranq-practice-v4', decision: root.decision,
        rootAnswerIndex: root.rootAnswerIndex,
        continuation: { mode: 'SINGLE_DECISION',
            explanationLines: explanation.length ? [{ startContextId: args.source.contextId,
                movesUci: explanation, stopReason: 'BOUNDED_ENGINE_EXPLANATION' }] : [],
            nodes: [{ id: args.source.contextId, contextId: args.source.contextId, fen: args.source.fen,
                positionHistory: [...args.source.positionHistory], trainingSide: args.source.trainingSide,
                role: 'USER', answerIndex: root.rootAnswerIndex }], edges: [] },
        frames: [root.frame], assessments: root.assessments, coverageGroups: [], evidence: root.evidence,
    };
    manifest.semanticHash = await sha256Hex(stableCanonicalStringify(canonicalPracticeSemantics(manifest)));
    return manifest;
}
