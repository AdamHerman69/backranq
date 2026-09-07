import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import { DEFAULT_ASSESSMENT_POLICY, canonicalJson, canonicalPracticeSemantics, legalMovesUci, parsePracticeMomentRevision, practiceContextId, type AssessmentPolicy, type ComparisonFrame, type PracticeMomentRevision, type SearchRecord, type Side } from '@/lib/training/practiceContract';
import { createAssessmentEvaluator, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex } from '@/lib/training/answerIndex';

/** Synthetic complete engine traces for deterministic UI/persistence fixtures, never used as real chess analysis. */
export function practicePositionFixture(args: {
    fen: string; originalMoveUci: string; bestMoveUci: string;
    momentId?: string; revisionId?: string; gameId?: string; sourcePgnHash?: string; decisionPly?: number;
    positionHistory?: string[]; configHash?: string; confirmationNodes?: number; policy?: AssessmentPolicy;
    scores?: Record<string, number>; snapshotCount?: number; continuation?: { opponentMoveUci: string; userMoveUci: string };
}): PracticeMomentRevision {
    const fen = new Chess(args.fen).fen();
    const side: Side = new Chess(fen).turn() === 'w' ? 'WHITE' : 'BLACK';
    const history = args.positionHistory ?? [];
    const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const configHash = args.configHash ?? 'fixture-profile';
    const budget = args.confirmationNodes ?? 100_000;
    const manifest: PracticeMomentRevision = {
        contractVersion: 4, momentId: args.momentId ?? 'moment', revisionId: args.revisionId ?? 'revision', semanticHash: '0'.repeat(64),
        source: { gameId: args.gameId ?? 'game', sourcePgnHash: args.sourcePgnHash ?? 'pgn-hash', decisionPly: args.decisionPly ?? 0, contextId: practiceContextId(fen, history, side), fen, positionHistory: history, trainingSide: side, originalMoveUci: args.originalMoveUci },
        policyId: policy.id, policySnapshot: policy, executionProfileId: configHash, executionProfileSnapshot: { id: configHash, minimumConfirmationNodes: budget }, generatorVersion: 'fixture-v4',
        decision: {} as PracticeMomentRevision['decision'], rootAnswerIndex: {} as PracticeMomentRevision['rootAnswerIndex'], continuation: { mode: 'SINGLE_DECISION', explanationLines: [], nodes: [], edges: [] },
        frames: [], assessments: [], coverageGroups: [], evidence: { searches: {}, observations: {}, exact: {} },
    };
    const addContext = (position: string, positions: string[], best: string, original: string, scores: Record<string, number> = {}) => {
        const contextId = practiceContextId(position, positions, side);
        const prefix = `trace-${Object.keys(manifest.evidence.searches).length}`;
        const legal = legalMovesUci(position); const scope = [best, ...legal.filter(m => m !== best)];
        const engineFingerprint = 'synthetic-fixture-engine';
        const search: SearchRecord = manifest.evidence.searches[prefix] = {
            id: prefix, sequence: Object.keys(manifest.evidence.searches).length, contextId, sessionId: 'fixture-session', engineIdentity: { fingerprint: engineFingerprint, artifactId: 'fixture-artifact', name: 'Fixture', build: '4', nnue: 'fixture', options: {}, wdlModel: null, source: 'SERVER_ENGINE' },
            request: { fen: position, positionHistory: positions, trainingSide: side, rootScopeUci: legal, multiPv: legal.length, limit: { nodes: budget, depth: null, movetimeMs: null } }, reason: 'MISSING_REFERENCE', reportedNodes: budget, reportedTimeMs: 1_000, completion: 'COMPLETED', observationIds: [] as string[],
        };
        for (let i = 0; i < (args.snapshotCount ?? 3); i++) {
            const id = `${prefix}-depth-${i}`; search.observationIds.push(id);
            manifest.evidence.observations[id] = { id, searchId: prefix, snapshotIndex: i, contextId, engineFingerprint, rootScopeUci: legal, requestedMultiPv: legal.length, completedSlots: legal.length, bundleComplete: true, depth: 12 + 2 * i, nodes: Math.floor(budget * (i + 1) / (args.snapshotCount ?? 3)), elapsedMs: 250 * (i + 1), lines: scope.map(moveUci => ({ moveUci, score: { kind: 'CP', cp: scores[moveUci] ?? ((moveUci === best ? 30 : -200) * (new Chess(position).turn() === (side === 'WHITE' ? 'w' : 'b') ? 1 : -1)), pov: side }, bound: 'UNBOUNDED', wdl: null, pvUci: [moveUci] })) };
        }
        const corroboration = structuredClone(search);
        corroboration.id = `${prefix}-corroboration`; corroboration.sequence = search.sequence;
        search.sequence++; corroboration.observationIds = [];
        for (const id of search.observationIds) {
            const point = structuredClone(manifest.evidence.observations[id]);
            point.id = `corroborating-${id}`; point.searchId = corroboration.id;
            corroboration.observationIds.push(point.id); manifest.evidence.observations[point.id] = point;
        }
        manifest.evidence.searches[corroboration.id] = corroboration;
        const probe = structuredClone(search);
        probe.id = `${prefix}-reference-probe`; probe.sequence = search.sequence + 1;
        probe.reason = 'VERIFY_REFERENCE'; probe.request.rootScopeUci = [best]; probe.request.multiPv = 1;
        probe.request.limit.nodes = policy.minimumReferenceProbeNodes; probe.reportedNodes = policy.minimumReferenceProbeNodes;
        probe.observationIds = [];
        for (let i = 0; i < 3; i++) {
            const point = structuredClone(manifest.evidence.observations[search.observationIds[Math.min(i, search.observationIds.length - 1)]]);
            point.id = `${probe.id}-depth-${i}`; point.searchId = probe.id; point.snapshotIndex = i;
            point.depth = 12 + 2 * i; point.nodes = Math.floor(policy.minimumReferenceProbeNodes * (i + 1) / 3);
            point.rootScopeUci = [best]; point.requestedMultiPv = 1; point.completedSlots = 1;
            point.lines = point.lines.filter(line => line.moveUci === best);
            probe.observationIds.push(point.id); manifest.evidence.observations[point.id] = point;
        }
        manifest.evidence.searches[probe.id] = probe;
        const frame: ComparisonFrame = { id: `${prefix}-frame`, contextId, policyId: policy.id, engineFingerprint, model: 'CP_ONLY', referenceAssessmentId: `${prefix}-${best}`, status: 'CURRENT', supersededById: null };
        manifest.frames.push(frame);
        const evaluate = createAssessmentEvaluator(manifest.evidence);
        const assessments = legal.map(moveUci => evaluate(frame, { id: `${prefix}-${moveUci}`, moveUci, trainingSide: side, referenceMoveUci: best, originalMoveUci: original }, policy));
        manifest.assessments.push(...assessments);
        return { contextId, frame, assessments, index: deriveAnswerIndex({ contextId, frameId: frame.id, legalMovesUci: legal, preferredMoveUci: best, assessments, coverageGroups: [] }) };
    };
    const root = addContext(fen, history, args.bestMoveUci, args.originalMoveUci, args.scores);
    manifest.rootAnswerIndex = root.index;
    manifest.decision = deriveDecisionAssessment({ original: root.assessments.find(a => a.moveUci === args.originalMoveUci)!, reference: root.assessments.find(a => a.moveUci === args.bestMoveUci)!, frame: root.frame, evidence: manifest.evidence, minimumConfirmationNodes: budget, policy });
    manifest.continuation.explanationLines = [{ startContextId: root.contextId, movesUci: [args.bestMoveUci], stopReason: 'FIXTURE' }];
    if (args.continuation) {
        const board = new Chess(fen); const path = [args.bestMoveUci, args.continuation.opponentMoveUci, args.continuation.userMoveUci];
        const nodes = [{ id: 'root', contextId: root.contextId, fen, positionHistory: history, trainingSide: side, role: 'USER' as const, answerIndex: root.index }];
        const full: PracticeMomentRevision['continuation']['nodes'] = [...nodes];
        for (let i = 0; i < path.length; i++) {
            const previous = full[full.length - 1]; const move = path[i]; board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
            const position = board.fen(); const positions = [...previous.positionHistory, previous.fen]; const contextId = practiceContextId(position, positions, side);
            const role = i === 0 ? 'OPPONENT' : i === 1 ? 'USER' : 'TERMINAL';
            const child = i < 2 ? addContext(position, positions, path[i + 1], path[i + 1]) : null;
            full.push({ id: `node-${i}`, contextId, fen: position, positionHistory: positions, trainingSide: side, role, answerIndex: role === 'USER' ? child!.index : null });
            manifest.continuation.edges.push({ from: previous.id, to: full[full.length - 1].id, moveUci: move });
        }
        manifest.continuation.mode = 'VERIFIED_BRANCHES'; manifest.continuation.nodes = full;
        manifest.continuation.explanationLines[0].movesUci = path;
    }
    manifest.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(manifest))).digest('hex');
    return parsePracticeMomentRevision(manifest);
}
