import { createHash } from 'node:crypto';
import {
    canonicalJson, canonicalPracticeSemantics, DEFAULT_ASSESSMENT_POLICY, legalMovesUci,
    parsePracticeMomentRevision, practiceContextId, type AssessmentPolicy, type ComparisonFrame,
    type EvidenceStore, type PracticeMomentRevision, type SearchRecord, type SourceDecision,
} from '@/lib/training/practiceContract';
import { createAssessmentEvaluator, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex } from '@/lib/training/answerIndex';

const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function computeIdentity(identity: SearchRecord['engineIdentity']) {
    const model = Object.fromEntries(Object.entries(identity).filter(([key]) => key !== 'source' && key !== 'options'));
    const options = Object.fromEntries(Object.entries(identity.options).filter(([key]) => key !== 'MultiPV'));
    return { ...model, options };
}
/** Re-evaluate paid audit records under the current policy, never old labels.
 * Caller binds baseSource/run fingerprint to a completed immutable audit file
 * and obtains expectedEngineIdentity from the current initialized engine.
 * Unknown or rejected projection authorizes no ground label or saved-work claim. */
export function projectPaidComparator(args: {
    rawEvidenceJson: string; baseEvidenceSha256: string; baseRunFingerprint: string;
    baseSource: SourceDecision; source: SourceDecision;
    expectedEngineIdentity: SearchRecord['engineIdentity']; policy?: AssessmentPolicy;
    minimumConfirmationNodes?: number;
}) {
    if (!/^[0-9a-f]{64}$/.test(args.baseRunFingerprint) || digest(args.rawEvidenceJson) !== args.baseEvidenceSha256) throw new Error('Invalid immutable audit provenance');
    if (canonicalJson(args.source) !== canonicalJson(args.baseSource)
        || args.source.contextId !== practiceContextId(args.source.fen, args.source.positionHistory, args.source.trainingSide)) throw new Error('Comparator source identity differs');
    const evidence = JSON.parse(args.rawEvidenceJson) as EvidenceStore;
    if (!evidence || typeof evidence !== 'object' || Object.keys(evidence).sort().join() !== 'exact,observations,searches'
        || [evidence.searches, evidence.observations, evidence.exact].some(records => !records || typeof records !== 'object' || Array.isArray(records))) throw new Error('Invalid evidence store');
    const expected = canonicalJson(computeIdentity(args.expectedEngineIdentity));
    const source = structuredClone(args.source);
    const legal = legalMovesUci(source.fen);
    const searches = Object.values(evidence.searches).sort((a, b) => a.sequence - b.sequence);
    for (const search of searches) {
        if (canonicalJson(computeIdentity(search.engineIdentity)) !== expected) throw new Error('Comparator compute identity differs');
        if (search.contextId !== source.contextId || search.request.fen !== source.fen
            || search.request.trainingSide !== source.trainingSide || canonicalJson(search.request.positionHistory) !== canonicalJson(source.positionHistory)) throw new Error('Comparator physical request differs from source');
    }
    const observations = Object.values(evidence.observations);
    const rootChoices = searches.filter(search => search.completion === 'COMPLETED'
        && canonicalJson([...search.request.rootScopeUci].sort()) === canonicalJson(legal)).flatMap(search => {
        const latest = observations.filter(o => o.searchId === search.id && o.bundleComplete && o.lines.length && o.lines.every(line => line.bound === 'UNBOUNDED'))
            .sort((a, b) => a.snapshotIndex - b.snapshotIndex).at(-1);
        return latest ? [{ search, observation: latest }] : [];
    });
    const root = rootChoices.at(-1); if (!root) throw new Error('No completed full-root choice');
    const preferredMoveUci = root.observation.lines[0].moveUci;
    const policy = structuredClone(args.policy ?? DEFAULT_ASSESSMENT_POLICY);
    const frameId = `audit-frame:${digest(canonicalJson([source.contextId, root.search.id, policy, args.baseEvidenceSha256]))}`;
    const assessmentId = (move: string) => `${frameId}:move:${move}`;
    const frame: ComparisonFrame = { id: frameId, contextId: source.contextId, policyId: policy.id,
        engineFingerprint: args.expectedEngineIdentity.fingerprint, model: root.observation.lines[0].wdl ? 'MATCHED_WDL' : 'CP_ONLY',
        referenceAssessmentId: assessmentId(preferredMoveUci), status: 'CURRENT', supersededById: null };
    const evaluate = createAssessmentEvaluator(evidence);
    const assessments = legal.map(moveUci => evaluate(frame, { id: assessmentId(moveUci), moveUci,
        trainingSide: source.trainingSide, referenceMoveUci: preferredMoveUci, originalMoveUci: source.originalMoveUci }, policy));
    const reference = assessments.find(a => a.id === frame.referenceAssessmentId)!;
    const original = assessments.find(a => a.moveUci === source.originalMoveUci)!;
    const minimumConfirmationNodes = args.minimumConfirmationNodes ?? 800_000;
    const rootAnswerIndex = deriveAnswerIndex({ contextId: source.contextId, frameId: frame.id, legalMovesUci: legal, preferredMoveUci, assessments, coverageGroups: [] });
    const profileId = 'audit-paid-comparator-projection';
    const manifest: PracticeMomentRevision = { contractVersion: 4, momentId: `audit:${source.contextId}`, revisionId: frameId,
        semanticHash: '0'.repeat(64), source, policyId: policy.id, policySnapshot: policy,
        executionProfileId: profileId, executionProfileSnapshot: { id: profileId, minimumConfirmationNodes },
        generatorVersion: 'audit-comparator-reprojection',
        decision: deriveDecisionAssessment({ original, reference, frame, evidence, minimumConfirmationNodes, policy }),
        rootAnswerIndex, frames: [frame], assessments, coverageGroups: [], evidence,
        continuation: { mode: 'SINGLE_DECISION', explanationLines: [], edges: [], nodes: [{ id: source.contextId,
            contextId: source.contextId, fen: source.fen, positionHistory: source.positionHistory, trainingSide: source.trainingSide,
            role: 'USER', answerIndex: rootAnswerIndex }] } };
    manifest.semanticHash = digest(canonicalJson(canonicalPracticeSemantics(manifest)));
    // This is the authority boundary: every raw record, scope, bound, immutable
    // ID, ordering link and derived label is checked by the current validator.
    const validated = parsePracticeMomentRevision(manifest);
    const readiness = evaluate.referenceReadiness({ frame, trainingSide: source.trainingSide, referenceMoveUci: preferredMoveUci, policy });
    const drift = evaluate.detectReferenceDrift({ frame, trainingSide: source.trainingSide, referenceMoveUci: preferredMoveUci, policy });
    return { manifest: validated, readiness, drift,
        provenance: { baseRunFingerprint: args.baseRunFingerprint, baseEvidenceSha256: args.baseEvidenceSha256,
            sourceSha256: digest(canonicalJson(source)), currentPolicyId: policy.id, physicalIdsPreserved: true },
        retainedEvidenceCost: { physicalSearches: searches.length,
            requestedNodes: searches.reduce((sum, search) => sum + (search.request.limit.nodes ?? 0), 0),
            reportedNodes: searches.reduce((sum, search) => sum + search.reportedNodes, 0),
            reportedTimeMs: searches.reduce((sum, search) => sum + search.reportedTimeMs, 0) },
        newWork: { physicalSearches: 0, requestedNodes: 0 },
        reusableGround: readiness.status === 'READY' && !drift && reference.quality === 'GOOD' && reference.qualitySupport === 'SUPPORTED' };
}
