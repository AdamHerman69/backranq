import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import {
    DEFAULT_ASSESSMENT_POLICY, canonicalJson, canonicalPracticeSemantics,
    legalMovesUci, practiceContextId,
    type ComparisonFrame, type EvidenceStore, type PracticeMomentRevision, type PracticeEvaluationPatch,
} from '@/lib/training/practiceContract';
import { assessMove, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex } from '@/lib/training/answerIndex';

/** Two scripted root groups plus a distinct completed focused reference probe. */
export function practiceV4Fixture(): PracticeMomentRevision {
    const fen = new Chess().fen(); const trainingSide = 'WHITE' as const;
    const contextId = practiceContextId(fen, [], trainingSide); const legal = legalMovesUci(fen);
    const evidence: EvidenceStore = { searches: {}, observations: {}, exact: {} };
    const engineFingerprint = 'fixture-engine-without-wdl';
    evidence.searches.search = {
        id: 'search', contextId, sequence: 0, sessionId: 'session', engineIdentity: { fingerprint: engineFingerprint, artifactId: 'fixture-artifact', name: 'Stockfish fixture', build: '18', nnue: 'fixture', options: {}, wdlModel: null, source: 'SERVER_ENGINE' },
        request: { fen, positionHistory: [], trainingSide, rootScopeUci: legal, multiPv: 3, limit: { nodes: 100_000, depth: null, movetimeMs: null } },
        reason: 'MISSING_REFERENCE', reportedNodes: 100_000, reportedTimeMs: 1_000, completion: 'COMPLETED', observationIds: [],
    };
    for (let i = 0; i < 3; i++) {
        const id = `observation-${i}`;
        evidence.searches.search.observationIds.push(id);
        evidence.observations[id] = { id, searchId: 'search', snapshotIndex: i, contextId, engineFingerprint, rootScopeUci: legal, requestedMultiPv: 3, completedSlots: 3, bundleComplete: true, depth: 10 + i, nodes: [25_000, 50_000, 100_000][i], elapsedMs: 200 * (i + 1), lines: [
            { moveUci: 'e2e4', score: { kind: 'CP', cp: 30, pov: trainingSide }, bound: 'UNBOUNDED', wdl: null, pvUci: ['e2e4'] },
            { moveUci: 'd2d4', score: { kind: 'CP', cp: 20, pov: trainingSide }, bound: 'UNBOUNDED', wdl: null, pvUci: ['d2d4'] },
            { moveUci: 'a2a3', score: { kind: 'CP', cp: -200, pov: trainingSide }, bound: 'UNBOUNDED', wdl: null, pvUci: ['a2a3'] },
        ] };
    }
    // Independent synthetic search record: not an alias/cache vote. Keep the
    // named "search" latest so targeted evidence mutation tests remain direct.
    const prior = structuredClone(evidence.searches.search);
    prior.id = 'corroborating-search'; prior.observationIds = [];
    evidence.searches.search.sequence = 1;
    for (const id of evidence.searches.search.observationIds) {
        const point = structuredClone(evidence.observations[id]);
        point.id = `corroborating-${id}`; point.searchId = prior.id;
        prior.observationIds.push(point.id); evidence.observations[point.id] = point;
    }
    evidence.searches[prior.id] = prior;
    const probe = structuredClone(evidence.searches.search);
    probe.id = 'reference-probe'; probe.sequence = 2; probe.reason = 'VERIFY_REFERENCE';
    probe.request.rootScopeUci = ['e2e4']; probe.request.multiPv = 1;
    probe.request.limit.nodes = 400_000; probe.reportedNodes = 400_000; probe.observationIds = [];
    for (const id of evidence.searches.search.observationIds) {
        const point = structuredClone(evidence.observations[id]);
        point.id = `probe-${id}`; point.searchId = probe.id; point.rootScopeUci = ['e2e4'];
        point.requestedMultiPv = 1; point.completedSlots = 1;
        point.nodes = [100_000, 200_000, 400_000][point.snapshotIndex];
        point.lines = point.lines.filter(line => line.moveUci === 'e2e4');
        probe.observationIds.push(point.id); evidence.observations[point.id] = point;
    }
    evidence.searches[probe.id] = probe;
    const frame: ComparisonFrame = { id: 'frame', contextId, policyId: DEFAULT_ASSESSMENT_POLICY.id, engineFingerprint, model: 'CP_ONLY', referenceAssessmentId: 'assessment-e2e4', status: 'CURRENT', supersededById: null };
    const assessments = ['e2e4', 'd2d4', 'a2a3'].map(moveUci => assessMove(frame, { id: `assessment-${moveUci}`, moveUci, trainingSide, referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence }));
    const revision: PracticeMomentRevision = {
        contractVersion: 4, momentId: 'moment', revisionId: 'revision', semanticHash: '0'.repeat(64),
        source: { gameId: 'game', sourcePgnHash: 'pgn-hash', decisionPly: 0, contextId, fen, positionHistory: [], trainingSide, originalMoveUci: 'a2a3' },
        policyId: DEFAULT_ASSESSMENT_POLICY.id, policySnapshot: { ...DEFAULT_ASSESSMENT_POLICY }, executionProfileId: 'fixture-profile', executionProfileSnapshot: { id: 'fixture-profile', minimumConfirmationNodes: 100_000 }, generatorVersion: 'fixture-v4',
        decision: deriveDecisionAssessment({ original: assessments[2], reference: assessments[0], frame, evidence, minimumConfirmationNodes: 100_000 }),
        rootAnswerIndex: deriveAnswerIndex({ contextId, frameId: frame.id, legalMovesUci: legal, preferredMoveUci: 'e2e4', assessments, coverageGroups: [] }),
        continuation: { mode: 'SINGLE_DECISION', explanationLines: [], nodes: [], edges: [] }, frames: [frame], assessments, coverageGroups: [], evidence,
    };
    revision.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(revision))).digest('hex');
    return revision;
}
export function practiceV4PatchFixture(revision = practiceV4Fixture()): PracticeEvaluationPatch {
    const evidence = structuredClone(revision.evidence);
    for (const search of Object.values(evidence.searches)) { search.engineIdentity.source = 'CLIENT_ENGINE'; search.engineIdentity.fingerprint = 'local-engine'; }
    for (const observation of Object.values(evidence.observations)) observation.engineFingerprint = 'local-engine';
    // New physical identities; the immutable server records cannot be overwritten.
    evidence.searches = Object.fromEntries(Object.values(evidence.searches).map(s => { s.id = `local-${s.id}`; s.observationIds = s.observationIds.map(id => `local-${id}`); return [s.id, s]; }));
    evidence.observations = Object.fromEntries(Object.values(evidence.observations).map(o => { o.id = `local-${o.id}`; o.searchId = `local-${o.searchId}`; return [o.id, o]; }));
    const frame: ComparisonFrame = { ...revision.frames[0], id: 'local-frame', engineFingerprint: 'local-engine', referenceAssessmentId: 'local-e2e4' };
    const assessments = ['e2e4', 'a2a3'].map(moveUci => assessMove(frame, { id: `local-${moveUci}`, moveUci, trainingSide: revision.source.trainingSide, referenceMoveUci: 'e2e4', originalMoveUci: revision.source.originalMoveUci, evidence }));
    return { frame, assessments, evidence };
}

/** Recompute derived v4 projections after a test deliberately edits evidence. */
export function rebuildPracticeFixture(revision: PracticeMomentRevision): PracticeMomentRevision {
    const frame = revision.frames.find(f => f.status === 'CURRENT' && f.contextId === revision.source.contextId)!;
    const preferred = revision.rootAnswerIndex.preferredMoveUci;
    const ids = new Map(revision.assessments.map(a => [a.moveUci, a.id]));
    const moves = new Set([preferred, revision.source.originalMoveUci, ...Object.values(revision.evidence.observations).flatMap(o => o.lines.map(l => l.moveUci))]);
    const assessments = [...moves].map(moveUci => assessMove(frame, {
        id: moveUci === preferred ? frame.referenceAssessmentId : ids.get(moveUci) ?? `assessment-${moveUci}`,
        moveUci, trainingSide: revision.source.trainingSide, referenceMoveUci: preferred,
        originalMoveUci: revision.source.originalMoveUci, evidence: revision.evidence,
    }, revision.policySnapshot));
    revision.assessments = assessments;
    revision.decision = deriveDecisionAssessment({ original: assessments.find(a => a.moveUci === revision.source.originalMoveUci)!,
        reference: assessments.find(a => a.id === frame.referenceAssessmentId)!, frame, evidence: revision.evidence,
        minimumConfirmationNodes: revision.executionProfileSnapshot.minimumConfirmationNodes, policy: revision.policySnapshot });
    revision.rootAnswerIndex = deriveAnswerIndex({ contextId: frame.contextId, frameId: frame.id,
        legalMovesUci: legalMovesUci(revision.source.fen), preferredMoveUci: preferred, assessments, coverageGroups: revision.coverageGroups });
    revision.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(revision))).digest('hex');
    return revision;
}
