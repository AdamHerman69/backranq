import { Chess } from 'chess.js';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { AnalysisWorkPlanner, type AnalysisWorkReason } from '@/lib/analysis/analysisWorkPlanner';
import { mergePracticeEvidence, practiceEngineFingerprint, practiceEvidenceFromSnapshots, practiceScoreFromEngine } from '@/lib/analysis/practiceEvidence';
import { collectPracticeExactEvidence } from '@/lib/analysis/practiceExactEvidence';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';
import type { EngineIdentity, StockfishEngine } from '@/lib/analysis/stockfishClient';
import { lookupAnswer } from './answerIndex';
import { createAssessmentEvaluator, isPointFirstPolicy, type PracticeReferenceDrift } from './assessmentPolicy';
import { createPracticeValidationFacts, type PracticeValidationFacts } from './practiceValidationFacts';
import { canonicalJson, practiceFingerprint, validatePracticeEvaluationPatch, type ComparisonFrame, type MoveAssessment, type PracticeEvaluationPatch, type PracticeScore, type Tier } from './practiceContract';
import type { TrainingComparisonDto, TrainingGradingManifestDto, TrainingSolutionTreeNodeDto } from './api';
import type { PovScore } from './contracts';

// 100k + 200k + 400k + 800k fits the ordinary 1.5M reservation only
// when no extra reference/retry work has spent that same budget.
const LOCAL_MAX_PASS_NODES = 800_000;
export type LocalMoveEvaluation = {
    result: { status: 'GRADED'; quality: 'GOOD' | 'BELOW_STANDARD'; tier: Tier | null; accepted: boolean; originalRelation: MoveAssessment['originalRelation'] }
        | { status: 'UNRESOLVED'; reason: 'ENGINE_UNAVAILABLE' | 'UNSTABLE_EVIDENCE' | 'MISSING_OUTCOME_EVIDENCE' };
    source: 'PRECOMPUTED' | 'CLIENT_EVALUATED';
    assessment: MoveAssessment | null;
    patch: PracticeEvaluationPatch | null;
    refinementNeeded: boolean;
    scoreAfter: PovScore | null;
    comparison: TrainingComparisonDto | null;
    /** New compatible evidence has withdrawn support for the initial served quality. */
    invalidatedKnownQuality?: boolean;
    /** The user followed the served recommendation; changed analysis does not withdraw that credit. */
    followedRecommendation?: boolean;
};
export type LocalAnalysisSession = { pool: PositionAnalysisPool; frame: ComparisonFrame | null; referenceMoveUci: string | null; validationFacts: PracticeValidationFacts };
export function createLocalAnalysisSession(): LocalAnalysisSession {
    return { pool: new PositionAnalysisPool(), frame: null, referenceMoveUci: null, validationFacts: createPracticeValidationFacts() };
}
/** Optional preparation only for an unready active reference, never a whole answer enumeration. */
export async function prewarmLocalReference(args: {
    engine: StockfishEngine; manifest: TrainingGradingManifestDto; node: TrainingSolutionTreeNodeDto;
    session: LocalAnalysisSession; signal: AbortSignal;
}): Promise<void> {
    if (!isPointFirstPolicy(args.manifest.policySnapshot) || args.signal.aborted) return;
    const preferred = args.node.answerIndex?.preferredMoveUci;
    if (!preferred || gradeKnownLocalMove({ ...args, moveUci: preferred })) return;
    const planner = new AnalysisWorkPlanner({ maxNodes: 100_000, maxWallMs: 2_000 });
    const abort = () => planner.cancelGeneration(); args.signal.addEventListener('abort', abort, { once: true });
    try {
        await planner.enqueue({ id: `prewarm:${args.node.contextId}`, generation: planner.currentGeneration,
            contextId: args.node.contextId, frameId: args.node.answerIndex?.frameId ?? null, attemptId: null,
            reason: 'MISSING_REFERENCE', evidenceDependencies: [`missing:reference:${args.node.contextId}`],
            priority: 'REQUIRED_REFERENCE', nodes: 100_000 }, async job => {
            const result = await args.engine.analyzeMultiPv({ fen: args.node.fen, previousFens: args.node.positionHistory,
                multiPv: 3, nodes: job.nodes, timeoutMs: job.timeoutMs, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED',
                signal: AbortSignal.any([job.signal, args.signal]), onSnapshot(snapshot) { args.session.pool.recordSnapshot(snapshot); job.onSnapshot(snapshot); } });
            args.session.pool.recordResult(result); return result;
        });
    } catch { /* Optional work can be superseded or unavailable; the played move owns the next budget. */ }
    finally { args.signal.removeEventListener('abort', abort); }
}
export type LocalGradingUpdate =
    | { kind: 'LIVE'; score: PovScore; depth: number }
    | { kind: 'INVALIDATED'; evaluation: LocalMoveEvaluation }
    | { kind: 'SUPPORTED'; evaluation: LocalMoveEvaluation };

export function practiceScoreToWhite(score: PracticeScore | null): PovScore | null {
    if (!score) return null;
    if (score.kind === 'CP') return { kind: 'cp', cp: score.pov === 'WHITE' ? score.cp : -score.cp, pov: 'WHITE' };
    if (score.kind === 'MATE') return { kind: 'mate', plies: score.plies, winner: score.winner };
    return { kind: 'tablebase', wdl: score.pov === 'WHITE' || score.outcome === 'DRAW' ? score.outcome : score.outcome === 'WIN' ? 'LOSS' : 'WIN', pov: 'WHITE' };
}
function evaluation(assessment: MoveAssessment, patch: PracticeEvaluationPatch | null): LocalMoveEvaluation {
    const scoreAfter = practiceScoreToWhite(assessment.score);
    const supported = assessment.qualitySupport === 'SUPPORTED' && assessment.quality !== 'UNKNOWN';
    return {
        result: supported ? { status: 'GRADED', quality: assessment.quality as 'GOOD' | 'BELOW_STANDARD',
            tier: assessment.tier, accepted: assessment.quality === 'GOOD', originalRelation: assessment.originalRelation }
            : { status: 'UNRESOLVED', reason: 'UNSTABLE_EVIDENCE' },
        source: patch ? 'CLIENT_EVALUATED' : 'PRECOMPUTED', assessment, patch,
        refinementNeeded: assessment.pending.some(task => task !== 'EXPLANATION'), scoreAfter,
        comparison: { submittedScoreAfter: scoreAfter, bestGapCp: assessment.metrics.lossCp,
            bestGapWinChance: assessment.metrics.lossExpectedScore, recoveredCp: assessment.metrics.recoveredCp,
            recoveredWinChance: assessment.metrics.recoveredExpectedScore, preservesOutcome: assessment.metrics.preservesExactOutcome },
    };
}
function gradeCanonicalKnownMove(args: {
    manifest: TrainingGradingManifestDto; node: TrainingSolutionTreeNodeDto; moveUci: string;
}): LocalMoveEvaluation | null {
    const index = args.node.answerIndex;
    if (!index) return null;
    const found = lookupAnswer(index, args.moveUci, args.manifest.assessments, args.manifest.coverageGroups,
        args.manifest.frames.find(frame => frame.id === index.frameId));
    if (found.kind === 'INDIVIDUAL') return evaluation(found.assessment, null);
    if (found.kind === 'GROUP') return {
        result: { status: 'GRADED', quality: 'BELOW_STANDARD', tier: null, accepted: false, originalRelation: args.node.contextId === args.manifest.source.contextId && args.moveUci === args.manifest.source.originalMoveUci ? 'SAME_MOVE' : 'UNKNOWN' },
        source: 'PRECOMPUTED', assessment: null, patch: null, refinementNeeded: true, scoreAfter: null, comparison: null,
    };
    return null;
}

/** Retain the constant-time canonical lookup until this session has learned
 * relevant evidence. A local contradiction cannot resurrect a stale verdict. */
export function gradeKnownLocalMove(args: {
    manifest: TrainingGradingManifestDto; node: TrainingSolutionTreeNodeDto; moveUci: string;
    session?: LocalAnalysisSession;
}): LocalMoveEvaluation | null {
    const known = gradeCanonicalKnownMove(args);
    if (!known || !args.session) return known;
    // The served recommendation is an immutable instruction. A user who follows
    // it keeps that credit; subsequent analysis may still correct its explanation.
    if (isPointFirstPolicy(args.manifest.policySnapshot) && args.node.contextId === args.manifest.source.contextId
        && args.moveUci === args.node.answerIndex?.preferredMoveUci && known.result.status === 'GRADED'
        && known.result.quality === 'GOOD' && known.assessment) return known;
    const frame = args.manifest.frames.find(item => item.id === args.node.answerIndex?.frameId);
    const reference = frame && args.manifest.assessments.find(item => item.id === frame.referenceAssessmentId);
    if (!frame || !reference) return null;
    const searches = args.session.pool.find({ fen: args.node.fen, previousFens: args.node.positionHistory })
        .filter(search => practiceEngineFingerprint(search.evidence.engine) === frame.engineFingerprint);
    if (!searches.some(search => search.snapshots.length)) return known;
    const evidence = mergePracticeEvidence(args.manifest.evidence, practiceEvidenceFromSnapshots(
        searches.flatMap(search => search.snapshots), args.node.trainingSide,
        searches.filter(search => search.result).map(search => search.evidence)));
    const assess = createAssessmentEvaluator(evidence, args.session.validationFacts);
    const current = assess(frame, { id: 'known-quality-guard', moveUci: args.moveUci,
        trainingSide: args.node.trainingSide, referenceMoveUci: reference.moveUci,
        originalMoveUci: args.node.contextId === args.manifest.source.contextId ? args.manifest.source.originalMoveUci : reference.moveUci,
    }, args.manifest.policySnapshot);
    return current.qualitySupport === 'SUPPORTED' && known.result.status === 'GRADED'
        && current.quality === known.result.quality ? known : null;
}

function unresolved(reason: 'ENGINE_UNAVAILABLE' | 'UNSTABLE_EVIDENCE'): LocalMoveEvaluation {
    return { result: { status: 'UNRESOLVED', reason }, source: 'CLIENT_EVALUATED', assessment: null,
        patch: null, refinementNeeded: false, scoreAfter: null, comparison: null };
}

/** A submitted mandatory ending can use the same exact evidence policy without an engine. */
function gradeRuleTerminalMove(args: {
    manifest: TrainingGradingManifestDto; node: TrainingSolutionTreeNodeDto; moveUci: string;
}): LocalMoveEvaluation | null {
    const board = new Chess(args.node.fen);
    board.move({ from: args.moveUci.slice(0, 2), to: args.moveUci.slice(2, 4), promotion: args.moveUci[4] });
    if (!ruleTerminalEvaluation(board.fen(), [...args.node.positionHistory, args.node.fen])) return null;
    const collected = collectPracticeExactEvidence({ fen: args.node.fen, positionHistory: args.node.positionHistory,
        trainingSide: args.node.trainingSide });
    const result = Object.values(collected.evidence.exact).flatMap(record => record.results).find(item => item.moveUci === args.moveUci);
    if (!result) return null;
    const canonicalFrame = args.manifest.frames.find(frame => frame.id === args.node.answerIndex?.frameId && frame.status === 'CURRENT' && frame.model === 'EXACT_OUTCOME');
    const canonicalReference = canonicalFrame && args.manifest.assessments.find(item => item.id === canonicalFrame.referenceAssessmentId && item.quality === 'GOOD' && item.qualitySupport === 'SUPPORTED' && item.score?.kind === 'EXACT');
    // A win is the maximum outcome. Draw/loss cannot establish the root optimum.
    const referenceMoveUci = result.outcome === 'WIN' ? args.moveUci : canonicalReference?.moveUci;
    if (!referenceMoveUci) return null;
    const evidence = mergePracticeEvidence(args.manifest.evidence, collected.evidence);
    const id = `${args.node.contextId}:local-rule:${practiceFingerprint([args.manifest.revisionId, referenceMoveUci, args.moveUci, Object.keys(collected.evidence.exact)])}`;
    const frame: ComparisonFrame = { id, contextId: args.node.contextId, policyId: args.manifest.policyId,
        engineFingerprint: 'FIDE-rules', model: 'EXACT_OUTCOME', referenceAssessmentId: `${id}:move:${referenceMoveUci}`,
        status: 'CURRENT', supersededById: null };
    const originalMoveUci = args.node.contextId === args.manifest.source.contextId ? args.manifest.source.originalMoveUci : referenceMoveUci;
    const assess = createAssessmentEvaluator(evidence);
    const assessments = [...new Set([referenceMoveUci, args.moveUci])].map(moveUci => assess(frame, {
        id: `${id}:move:${moveUci}`, moveUci, trainingSide: args.node.trainingSide, referenceMoveUci, originalMoveUci,
    }, args.manifest.policySnapshot));
    const assessment = assessments.find(item => item.moveUci === args.moveUci)!;
    if (assessment.qualitySupport !== 'SUPPORTED' || assessment.quality === 'UNKNOWN') return null;
    const patch: PracticeEvaluationPatch = { frame, assessments, evidence: { searches: {}, observations: {}, exact:
        Object.fromEntries(Object.entries(collected.evidence.exact).filter(([recordId]) => !Object.hasOwn(args.manifest.evidence.exact, recordId))) } };
    const checked = validatePracticeEvaluationPatch(args.manifest, patch);
    return checked.success ? evaluation(assessment, checked.value) : null;
}

/** Only missing reference/move evidence enters the bounded queue; original comparison never blocks quality. */
export async function gradeUnknownLocalMove(args: {
    engine: StockfishEngine | (() => StockfishEngine); retryEngine?: () => StockfishEngine;
    manifest: TrainingGradingManifestDto; node: TrainingSolutionTreeNodeDto; moveUci: string;
    session?: LocalAnalysisSession; planner?: AnalysisWorkPlanner; signal?: AbortSignal;
    attemptId?: string; refine?: boolean; onUpdate?: (update: LocalGradingUpdate) => void;
}): Promise<LocalMoveEvaluation> {
    // Keep the canonical baseline for causal invalidation/refinement, but only
    // return it immediately when the current session still supports its quality.
    const known = gradeCanonicalKnownMove(args);
    if (known && !args.refine) {
        const currentKnown = gradeKnownLocalMove(args);
        if (currentKnown) return currentKnown;
    }
    const board = new Chess(args.node.fen);
    if (!board.moves({ verbose: true }).some(move => `${move.from}${move.to}${move.promotion ?? ''}` === args.moveUci)) throw new Error('Illegal practice move');
    if (args.signal?.aborted) return unresolved('ENGINE_UNAVAILABLE');
    const exact = gradeRuleTerminalMove(args);
    if (exact) { args.onUpdate?.({ kind: 'SUPPORTED', evaluation: exact }); return exact; }
    const session = args.session ?? createLocalAnalysisSession();
    if (session.frame?.contextId !== args.node.contextId) { session.frame = null; session.referenceMoveUci = null; }
    const planner = args.planner ?? new AnalysisWorkPlanner({ maxNodes: args.refine ? 200_000 : 1_500_000, maxWallMs: args.refine ? 2_000 : 8_000 });
    const abort = () => planner.cancelGeneration();
    args.signal?.addEventListener('abort', abort, { once: true });
    let engine = typeof args.engine === 'function' ? args.engine() : args.engine;
    let retried = false;
    let identity: EngineIdentity | null = null;
    let supported: LocalMoveEvaluation | null = null;
    let invalidatedKnownQuality = false;
    let notifiedInvalidation = false;
    let qualityWasWithdrawn = false;
    const failure = (reason: 'ENGINE_UNAVAILABLE' | 'UNSTABLE_EVIDENCE') => ({ ...unresolved(reason), invalidatedKnownQuality });
    const detailComplete = (value: LocalMoveEvaluation) => value.result.status === 'GRADED' &&
        (!args.refine || qualityWasWithdrawn || known?.result.status !== 'GRADED' || value.result.quality !== known.result.quality || value.assessment?.tierSupport === 'SUPPORTED');
    let lastLiveAt = -Infinity;
    const history = args.node.positionHistory;
    let jobIndex = 0;
    const legalMoveCount = board.moves().length;
    // This memo belongs to this grading invocation and immutable manifest only.
    let cachedVersion = -1;
    let cachedIdentity: EngineIdentity | null = null;
    let cachedPatch: PracticeEvaluationPatch | null = null;
    let cachedEvaluator: ReturnType<typeof createAssessmentEvaluator> | null = null;
    const latestPatch = (): PracticeEvaluationPatch | null => {
        if (!identity) return null;
        if (cachedVersion === session.pool.evidenceVersion && cachedIdentity === identity) return cachedPatch;
        cachedVersion = session.pool.evidenceVersion; cachedIdentity = identity; cachedPatch = null;
        const searches = session.pool.find({ fen: args.node.fen, previousFens: history, engine: identity });
        const roots = searches.filter(search => search.evidence.request.rootMoves.length === legalMoveCount);
        const root = roots.at(-1);
        const rootSnapshot = root?.snapshots.findLast(snapshot => snapshot.bundleComplete);
        const localReference = root?.result?.lines[0]?.pvUci[0] ?? rootSnapshot?.lines[0]?.pvUci[0];
        const fingerprint = practiceEngineFingerprint(identity);
        const canonicalFrame = args.manifest.frames.find(frame => frame.id === args.node.answerIndex?.frameId && frame.engineFingerprint === fingerprint);
        if (root && localReference) {
            const frameId = `${args.node.contextId}:local:${practiceFingerprint([root.evidence.id, fingerprint])}`;
            session.frame = { id: frameId, contextId: args.node.contextId, policyId: args.manifest.policyId,
                engineFingerprint: fingerprint, model: (root.result?.lines[0] ?? rootSnapshot?.lines[0])?.wdl ? 'MATCHED_WDL' : 'CP_ONLY',
                referenceAssessmentId: `${frameId}:move:${localReference}`, status: 'CURRENT', supersededById: null };
            session.referenceMoveUci = localReference;
        } else if (!session.frame && canonicalFrame) {
            // Preserve canonical evidence, but derive new personal assessments in a new frame.
            const frameId = `${args.node.contextId}:local:${practiceFingerprint([canonicalFrame.id, args.attemptId ?? 'session'])}`;
            session.referenceMoveUci = args.node.answerIndex!.preferredMoveUci;
            session.frame = { ...canonicalFrame, id: frameId, referenceAssessmentId: `${frameId}:move:${session.referenceMoveUci}` };
        }
        if (!session.frame || session.frame.engineFingerprint !== fingerprint || !session.referenceMoveUci) return null;
        const evidence = mergePracticeEvidence(args.manifest.evidence, practiceEvidenceFromSnapshots(
            searches.flatMap(search => search.snapshots), args.node.trainingSide,
            searches.filter(search => search.result).map(search => search.evidence)));
        // Assessment IDs are immutable conclusions. New observations produce a
        // new projection/frame, even when the best root move stays unchanged.
        const projectionId = `${session.frame.id}:projection:${practiceFingerprint([session.frame, args.moveUci, evidence])}`;
        const frame: ComparisonFrame = { ...session.frame, id: projectionId, referenceAssessmentId: `${projectionId}:move:${session.referenceMoveUci}` };
        const originalMoveUci = args.node.contextId === args.manifest.source.contextId
            ? args.manifest.source.originalMoveUci : session.referenceMoveUci;
        const assess = createAssessmentEvaluator(evidence, session.validationFacts);
        cachedEvaluator = assess;
        if (known?.result.status === 'GRADED' && canonicalFrame) {
            const canonicalReference = args.manifest.assessments.find(item => item.id === canonicalFrame.referenceAssessmentId);
            if (canonicalReference) {
                const currentKnown = assess(canonicalFrame, { id: 'initial-quality-check', moveUci: args.moveUci,
                    trainingSide: args.node.trainingSide, referenceMoveUci: canonicalReference.moveUci,
                    originalMoveUci: args.node.contextId === args.manifest.source.contextId ? args.manifest.source.originalMoveUci : canonicalReference.moveUci,
                }, args.manifest.policySnapshot);
                invalidatedKnownQuality = currentKnown.qualitySupport !== 'SUPPORTED' || currentKnown.quality !== known.result.quality;
            }
        }
        const assessments = [...new Set([session.referenceMoveUci, args.moveUci])].map(moveUci => assess(frame, {
            id: `${projectionId}:move:${moveUci}`, moveUci, trainingSide: args.node.trainingSide,
            referenceMoveUci: session.referenceMoveUci!, originalMoveUci,
        }, args.manifest.policySnapshot));
        cachedPatch = { frame, assessments, evidence };
        return cachedPatch;
    };
    let driftPatch: PracticeEvaluationPatch | null = null;
    let driftResult: PracticeReferenceDrift | null = null;
    const referenceDrift = (patch: PracticeEvaluationPatch | null) => {
        if (!patch || !session.referenceMoveUci) return null;
        if (driftPatch !== patch) {
            driftPatch = patch;
            driftResult = cachedEvaluator!.detectReferenceDrift({ frame: patch.frame, trainingSide: args.node.trainingSide,
                referenceMoveUci: session.referenceMoveUci, policy: args.manifest.policySnapshot });
        }
        return driftResult;
    };
    let projectedPatch: PracticeEvaluationPatch | null = null;
    let projectedValue: LocalMoveEvaluation | null = null;
    const project = () => {
        const patch = latestPatch();
        if (invalidatedKnownQuality && !notifiedInvalidation) {
            notifiedInvalidation = true;
            qualityWasWithdrawn = true;
            args.onUpdate?.({ kind: 'INVALIDATED', evaluation: failure('UNSTABLE_EVIDENCE') });
        } else if (!invalidatedKnownQuality) notifiedInvalidation = false;
        if (patch === projectedPatch) return projectedValue;
        projectedPatch = patch; projectedValue = null;
        const assessment = patch?.assessments.find(item => item.moveUci === args.moveUci);
        if (!assessment || !patch) return null;
        // The server already has immutable canonical evidence. Send only new or
        // changed IDs; validation still compares against the complete merged store.
        const evidence = { searches: {}, observations: {}, exact: {} } as PracticeEvaluationPatch['evidence'];
        for (const kind of ['searches', 'observations', 'exact'] as const) {
            for (const [id, item] of Object.entries(patch.evidence[kind])) {
                const base = args.manifest.evidence[kind][id];
                if (!base || canonicalJson(base) !== canonicalJson(item)) Object.assign(evidence[kind], { [id]: item });
            }
        }
        const evaluated = evaluation(assessment, { ...patch, evidence });
        if (referenceDrift(patch)) { projectedValue = { ...evaluated, result: { status: 'UNRESOLVED', reason: 'UNSTABLE_EVIDENCE' } }; return projectedValue; }
        if (detailComplete(evaluated)) supported = evaluated;
        projectedValue = evaluated; return evaluated;
    };
    const finish = (reason: 'ENGINE_UNAVAILABLE' | 'UNSTABLE_EVIDENCE') => {
        if (supported) return supported;
        // Restoring a withdrawn verdict is quality work. Tier uncertainty must
        // not keep the move neutral after its quality is supported again.
        const current = qualityWasWithdrawn ? project() : null;
        return current?.result.status === 'GRADED' ? current : failure(reason);
    };
    try {
        if (args.signal?.aborted) return unresolved('ENGINE_UNAVAILABLE');
        // Identity/startup participates in the same wall deadline as every search.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            identity = engine.getIdentity ? await Promise.race([engine.getIdentity(), new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('Engine startup budget exhausted')), planner.remainingWallMs);
            })]) : null;
        } finally { clearTimeout(timer); }
        // One dependency per completed search. Reference work must not advance
        // the answer ladder or trigger an answer search against an unready root.
        let nextRootNodes = args.manifest.policySnapshot.latestSupportNodes;
        let nextAnswerNodes = args.manifest.policySnapshot.latestSupportNodes;
        const attemptedProbes = new Set<string>();
        while (!args.signal?.aborted && planner.remainingWallMs > 0) {
            const patch = latestPatch();
            const current = project();
            if (current && detailComplete(current)) return current;
            const readiness = patch && session.referenceMoveUci ? cachedEvaluator!.referenceReadiness({
                frame: patch.frame, trainingSide: args.node.trainingSide,
                referenceMoveUci: session.referenceMoveUci, policy: args.manifest.policySnapshot,
            }) : null;
            let move: string | null;
            let nodes: number;
            let reason: AnalysisWorkReason;
            if (readiness?.status === 'READY') {
                move = args.moveUci; nodes = nextAnswerNodes; reason = 'MISSING_MOVE';
                nextAnswerNodes *= 2;
            } else if (readiness?.requiredWork === 'REFERENCE_PROBE') {
                move = readiness.preferredMoveUci;
                nodes = args.manifest.policySnapshot.minimumReferenceProbeNodes;
                reason = 'VERIFY_REFERENCE';
                const premise = `${patch!.frame.engineFingerprint}:${readiness.rootSearchId}:${move}`;
                // A naturally completed but immature/under-budget probe cannot
                // spin the same 400k request until the wall timer happens to end.
                if (attemptedProbes.has(premise)) break;
                attemptedProbes.add(premise);
            } else {
                move = null;
                reason = readiness?.status === 'REFERENCE_VALUE_DRIFT' || readiness?.status === 'UNRESOLVED_REFERENCE'
                    ? 'REFERENCE_DRIFT' : 'MISSING_REFERENCE';
                const priorRoot = readiness?.rootSearchId && patch?.evidence.searches[readiness.rootSearchId];
                const priorNodes = priorRoot ? priorRoot.request.limit.nodes ?? priorRoot.reportedNodes : 0;
                while (nextRootNodes <= priorNodes) nextRootNodes *= 2;
                nodes = nextRootNodes; nextRootNodes *= 2;
            }
            if (nodes > LOCAL_MAX_PASS_NODES || planner.remainingNodes < nodes) break;
            const qualityStop = new AbortController();
            const run = async () => planner.enqueue({
                id: `${args.attemptId ?? 'local'}:${jobIndex++}`, generation: planner.currentGeneration,
                contextId: args.node.contextId, frameId: session.frame?.id ?? null, attemptId: args.attemptId ?? null,
                reason, evidenceDependencies: [...(readiness?.evidenceIds ?? []), reason === 'VERIFY_REFERENCE'
                    ? `missing:reference-probe:${move}` : move ? `missing:quality:${move}` : `missing:reference:${args.node.contextId}`],
                priority: args.refine ? 'SUBMITTED_DETAIL' : reason === 'MISSING_MOVE' ? 'SUBMITTED_QUALITY' : 'REQUIRED_REFERENCE', nodes,
            }, async job => {
                const result = await engine.analyzeMultiPv({ fen: args.node.fen, previousFens: history, multiPv: 1,
                    rootMoves: move ? [move] : undefined, nodes: job.nodes, timeoutMs: job.timeoutMs,
                    signal: AbortSignal.any([job.signal, qualityStop.signal, ...(args.signal ? [args.signal] : [])]),
                    purpose: reason, reuse: 'FRESH_REQUIRED', onSnapshot(snapshot) {
                        identity ??= snapshot.searchEvidence.engine;
                        session.pool.recordSnapshot(snapshot);
                        const line = snapshot.bundleComplete ? snapshot.lines.find(item => item.pvUci[0] === args.moveUci) : undefined;
                        if (line?.score && performance.now() - lastLiveAt >= 100) {
                            lastLiveAt = performance.now();
                            const score = practiceScoreToWhite(practiceScoreFromEngine(line.score, args.node.fen.split(' ')[1] === 'w' ? 'WHITE' : 'BLACK'));
                            if (score) args.onUpdate?.({ kind: 'LIVE', score, depth: snapshot.depth });
                        }
                        job.onSnapshot(snapshot);
                    } });
                identity ??= result.searchEvidence?.engine ?? null;
                session.pool.recordResult(result);
                return result;
            }, () => {
                if (args.signal?.aborted) return;
                const current = project();
                if (current?.scoreAfter && performance.now() - lastLiveAt >= 100) {
                    lastLiveAt = performance.now();
                    args.onUpdate?.({ kind: 'LIVE', score: current.scoreAfter,
                        depth: session.pool.find({ fen: args.node.fen, previousFens: history }).at(-1)?.snapshots.at(-1)?.depth ?? 0 });
                }
                if (current && detailComplete(current)) {
                    supported = current;
                    args.onUpdate?.({ kind: 'SUPPORTED', evaluation: current });
                    qualityStop.abort();
                }
            });
            try { await run(); }
            catch {
                if (supported) break;
                if (!retried && args.retryEngine && !args.signal?.aborted && planner.remainingWallMs > 0 && planner.remainingNodes >= nodes) {
                    retried = true; engine = args.retryEngine();
                    try { await run(); } catch { if (!supported) return finish('ENGINE_UNAVAILABLE'); }
                } else return finish('ENGINE_UNAVAILABLE');
            }
            project();
            if (supported) return supported;
        }
        return finish('UNSTABLE_EVIDENCE');
    } catch { return finish('ENGINE_UNAVAILABLE'); }
    finally { args.signal?.removeEventListener('abort', abort); }
}

export function localContinuationForMove(args: {
    manifest: TrainingGradingManifestDto; node: TrainingSolutionTreeNodeDto; moveUci: string;
}): { opponentMoveUci: string; fenAfterOpponentMove: string; nextUserNode: TrainingSolutionTreeNodeDto } | null {
    if (args.manifest.continuation.mode !== 'VERIFIED_BRANCHES') return null;
    const { nodes, edges } = args.manifest.continuation;
    const opponentEdge = edges.find(edge => edge.from === args.node.id && edge.moveUci === args.moveUci);
    const opponent = nodes.find(node => node.id === opponentEdge?.to && node.role === 'OPPONENT');
    const reply = edges.find(edge => edge.from === opponent?.id);
    const next = nodes.find(node => node.id === reply?.to && node.role === 'USER' && node.answerIndex);
    if (!opponent || !reply || !next) return null;
    return { opponentMoveUci: reply.moveUci, fenAfterOpponentMove: next.fen, nextUserNode: { ...next, ply: args.node.ply + 2 } };
}
