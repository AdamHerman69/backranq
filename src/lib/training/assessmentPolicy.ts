import { Chess } from 'chess.js';
import type { PracticeValidationFacts } from './practiceValidationFacts';
import {
    DEFAULT_ASSESSMENT_POLICY, legalMovesUci, practiceContextId,
    type AnalysisObservation, type AssessmentPolicy, type ComparisonFrame,
    type DecisionAssessment, type EvidenceStore, type ExactRecord, type MoveAssessment,
    type ObservationLine, type Outcome, type PracticeScore, type SearchRecord,
    type Side, type Tier, type Wdl,
} from './practiceContract';
import { ruleTerminalEvaluation } from '@/lib/analysis/ruleEvaluation';

export function expectedScore(wdl: Wdl): number {
    const total = wdl.win + wdl.draw + wdl.loss;
    if (![wdl.win, wdl.draw, wdl.loss].every(v => Number.isFinite(v) && v >= 0) || total <= 0) throw new Error('Invalid real WDL');
    return (wdl.win + wdl.draw * 0.5) / total;
}
export function toleranceCp(bestCp: number, policy: AssessmentPolicy = DEFAULT_ASSESSMENT_POLICY): number {
    return Math.max(policy.minToleranceCp, Math.min(policy.maxToleranceCp, policy.winningToleranceFraction * Math.max(0, bestCp)));
}
export function normalizeScore(score: PracticeScore, side: Side): PracticeScore {
    if (score.pov === side) return score;
    if (score.kind === 'CP') return { ...score, cp: -score.cp, pov: side };
    if (score.kind === 'MATE') return { ...score, pov: side };
    return { ...score, outcome: score.outcome === 'DRAW' ? 'DRAW' : score.outcome === 'WIN' ? 'LOSS' : 'WIN', pov: side };
}
const rank = (outcome: Outcome) => ({ LOSS: 0, DRAW: 1, WIN: 2 })[outcome];
function lineE(line: ObservationLine, side: Side): number | null {
    if (!line.wdl) return null;
    const value = expectedScore(line.wdl);
    return line.score.pov === side ? value : 1 - value;
}
function pointQuality(reference: PracticeScore, move: PracticeScore, referenceE: number | null, moveE: number | null, frame: ComparisonFrame, policy: AssessmentPolicy): 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN' {
    if (reference.kind === 'EXACT' && move.kind === 'EXACT') return rank(move.outcome) >= rank(reference.outcome) ? 'GOOD' : 'BELOW_STANDARD';
    if (reference.kind === 'MATE' && move.kind === 'MATE') return reference.winner === move.winner ? 'GOOD' : move.winner === move.pov ? 'UNKNOWN' : 'BELOW_STANDARD';
    if (reference.kind !== 'CP' || move.kind !== 'CP' || frame.model === 'EXACT_OUTCOME') return 'UNKNOWN';
    if (frame.model === 'MATCHED_WDL' && (referenceE === null || moveE === null)) return 'UNKNOWN';
    if (frame.model === 'CP_ONLY' && (referenceE !== null || moveE !== null)) return 'UNKNOWN';
    return reference.cp - move.cp <= toleranceCp(reference.cp, policy) && (frame.model !== 'MATCHED_WDL' || referenceE! - moveE! <= policy.maxExpectedScoreLoss) ? 'GOOD' : 'BELOW_STANDARD';
}
function pointTier(quality: MoveAssessment['quality'], lossCp: number | null, lossE: number | null, policy: AssessmentPolicy): Tier | null {
    if (quality === 'UNKNOWN') return null;
    if (quality === 'BELOW_STANDARD') return 'SUBPAR';
    if (lossCp === null) return 'GOOD';
    if (lossCp <= policy.bestMaxLossCp && (lossE === null || lossE <= policy.bestMaxLossExpectedScore)) return 'BEST';
    if (lossCp <= policy.strongMaxLossCp && (lossE === null || lossE <= policy.strongMaxLossExpectedScore)) return 'STRONG';
    return 'GOOD';
}
export type AssessmentInput = {
    id: string; moveUci: string; trainingSide: Side; referenceMoveUci: string;
    originalMoveUci: string; evidence: EvidenceStore;
};
/** Invocation-scoped immutable snapshot: never retained in a global mutable cache. */
class AssessmentEvidenceContext {
    readonly evidence: EvidenceStore;
    readonly observations: AnalysisObservation[];
    private readonly observationValidity = new Map<string, boolean>();
    private readonly exactValidity = new Map<string, boolean>();
    private readonly legalCounts = new Map<string, number>();
    readonly referenceReady = new Map<string, PracticeReferenceReadiness>();
    readonly frameDrift = new Map<string, PracticeReferenceDrift | null>();
    private readonly latestComplete = new Map<string, AnalysisObservation | null>();
    constructor(evidence: EvidenceStore, readonly facts?: PracticeValidationFacts) { this.evidence = structuredClone(evidence); this.observations = orderedObservations(this.evidence); }
    validObservation(observation: AnalysisObservation): boolean {
        if (!this.observationValidity.has(observation.id)) this.observationValidity.set(observation.id, validObservation(observation, this.evidence, this.facts));
        return this.observationValidity.get(observation.id)!;
    }
    validExact(record: ExactRecord): boolean {
        if (!this.exactValidity.has(record.id)) this.exactValidity.set(record.id, validExactRecord(record));
        return this.exactValidity.get(record.id)!;
    }
    legalCount(fen: string): number {
        if (!this.legalCounts.has(fen)) this.legalCounts.set(fen, (this.facts?.legalMovesUci(fen) ?? legalMovesUci(fen)).length);
        return this.legalCounts.get(fen)!;
    }
    currentPoint(sample: Sample): boolean {
        if (!this.latestComplete.has(sample.search.id)) {
            this.latestComplete.set(sample.search.id, this.observations.findLast(o => o.searchId === sample.search.id
                && o.bundleComplete && o.lines.every(line => line.bound === 'UNBOUNDED') && this.validObservation(o)) ?? null);
        }
        return this.latestComplete.get(sample.search.id)?.lines.some(line => line.moveUci === sample.line.moveUci) ?? false;
    }
}
export function createAssessmentEvaluator(evidence: EvidenceStore, facts?: PracticeValidationFacts) {
    const prepared = new AssessmentEvidenceContext(evidence, facts);
    const evaluate = (frame: ComparisonFrame, input: Omit<AssessmentInput, 'evidence'>, policy: AssessmentPolicy = DEFAULT_ASSESSMENT_POLICY): MoveAssessment => assessPreparedMove(frame, { ...input, evidence: prepared.evidence }, policy, prepared);
    return Object.assign(evaluate, {
        referenceReadiness: (args: Omit<PracticeReferenceReadinessInput, 'evidence'>) => preparedReferenceReadiness({ ...args, evidence: prepared.evidence }, prepared),
        detectReferenceDrift: (args: Omit<PracticeReferenceDriftInput, 'evidence'>) => preparedReferenceDrift({ ...args, evidence: prepared.evidence }, prepared),
    });
}
type Sample = { observation: AnalysisObservation; search: SearchRecord; line: ObservationLine; score: PracticeScore; e: number | null };
export function validObservation(observation: AnalysisObservation, store: EvidenceStore, facts?: PracticeValidationFacts): boolean {
    try {
        const search = store.searches[observation.searchId];
        if (!search || search.completion === 'FAILED' || !search.observationIds.includes(observation.id) || observation.contextId !== search.contextId || observation.engineFingerprint !== search.engineIdentity.fingerprint) return false;
        const request = search.request;
        if ((facts?.contextId(request.fen, request.positionHistory, request.trainingSide) ?? practiceContextId(request.fen, request.positionHistory, request.trainingSide)) !== observation.contextId) return false;
        const legal = new Set(facts?.legalMovesUci(request.fen) ?? legalMovesUci(request.fen));
        if (new Set(observation.rootScopeUci).size !== observation.rootScopeUci.length || !observation.rootScopeUci.length || observation.rootScopeUci.some(m => !legal.has(m))) return false;
        if ([...observation.rootScopeUci].sort().join() !== [...request.rootScopeUci].sort().join()) return false;
        const required = Math.min(request.multiPv, request.rootScopeUci.length);
        if (observation.requestedMultiPv !== request.multiPv || observation.completedSlots !== observation.lines.length
            || !observation.completedSlots || observation.completedSlots > required
            || new Set(observation.lines.map(l => l.moveUci)).size !== observation.completedSlots) return false;
        if (observation.bundleComplete ? observation.completedSlots !== required
            : observation.lines.some(line => line.bound === 'UNBOUNDED')) return false;
        return observation.lines.every(line => {
            if (!observation.rootScopeUci.includes(line.moveUci) || line.pvUci[0] !== line.moveUci || line.score.kind === 'EXACT') return false;
            if (line.wdl) expectedScore(line.wdl);
            if (facts) return facts.legalPv(request.fen, line.pvUci);
            const board = new Chess(request.fen);
            for (const uci of line.pvUci) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
            return true;
        });
    } catch { return false; }
}
export function orderedObservations(evidence: EvidenceStore): AnalysisObservation[] {
    return Object.values(evidence.observations).sort((a, b) => (evidence.searches[a.searchId]?.sequence ?? -1) - (evidence.searches[b.searchId]?.sequence ?? -1) || a.snapshotIndex - b.snapshotIndex);
}
function samples(frame: ComparisonFrame, input: AssessmentInput, move: string, reference: boolean, prepared: AssessmentEvidenceContext, searchId?: string): Sample[] {
    const seen = new Set<string>();
    const found: Sample[] = [];
    for (const observation of prepared.observations) {
        if (searchId !== undefined && observation.searchId !== searchId) continue;
        if (observation.contextId !== frame.contextId || observation.engineFingerprint !== frame.engineFingerprint || !prepared.validObservation(observation)) continue;
        const search = input.evidence.searches[observation.searchId];
        if (search.request.trainingSide !== input.trainingSide || (frame.model === 'MATCHED_WDL' && search.engineIdentity.wdlModel === null)) continue;
        const line = observation.lines.find(l => l.moveUci === move);
        if (!line) continue;
        // Any compatible scoped counter can refute a reference. Only a point
        // from a full-root search can establish or restore that reference.
        if (reference && line.bound === 'UNBOUNDED' && search.request.rootScopeUci.length !== prepared.legalCount(search.request.fen)) continue;
        const physicalId = `${observation.searchId}:${observation.snapshotIndex}`;
        if (seen.has(physicalId)) continue;
        seen.add(physicalId);
        found.push({ observation, search, line, score: normalizeScore(line.score, input.trainingSide), e: lineE(line, input.trainingSide) });
    }
    // Physical sequence survives JSON dictionary reordering; cache hits cannot add votes.
    const exactIndices = found.flatMap((sample, index) => sample.line.bound === 'UNBOUNDED' ? [index] : []);
    const latestPoint = exactIndices.at(-1) ?? -1;
    return found.filter((sample, index) => sample.line.bound === 'UNBOUNDED'
        ? index >= (exactIndices.at(-3) ?? exactIndices[0] ?? 0) : index > latestPoint);
}
export type PracticeReferenceDrift = { moveUci: string; observationId: string; referenceObservationId: string };
export type PracticeReferenceDriftInput = {
    evidence: EvidenceStore; frame: ComparisonFrame; trainingSide: Side;
    referenceMoveUci: string; policy?: AssessmentPolicy;
};
/** A newer compatible counterexample invalidates the frame, even before its own quality is supported. */
export function detectPracticeReferenceDrift(args: PracticeReferenceDriftInput, facts?: PracticeValidationFacts): PracticeReferenceDrift | null {
    return preparedReferenceDrift(args, new AssessmentEvidenceContext(args.evidence, facts));
}
function preparedReferenceDrift(args: PracticeReferenceDriftInput, prepared: AssessmentEvidenceContext, evaluationSide: Side = args.trainingSide): PracticeReferenceDrift | null {
    const { frame, trainingSide, referenceMoveUci } = args;
    const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const key = JSON.stringify([frame, trainingSide, referenceMoveUci, policy, evaluationSide]);
    if (prepared.frameDrift.has(key)) return prepared.frameDrift.get(key)!;
    if (frame.status !== 'CURRENT' || frame.model === 'EXACT_OUTCOME' || frame.policyId !== policy.id) return null;
    const input = { id: '', moveUci: referenceMoveUci, referenceMoveUci, originalMoveUci: referenceMoveUci, trainingSide, evidence: prepared.evidence };
    const rawReference = samples(frame, input, referenceMoveUci, true, prepared).findLast(sample => sample.line.bound === 'UNBOUNDED');
    const reference = rawReference && { ...rawReference, score: normalizeScore(rawReference.line.score, evaluationSide), e: lineE(rawReference.line, evaluationSide) };
    if (!reference) return null;
    const latest = new Map<string, Sample[]>();
    for (const observation of prepared.observations) {
        if (observation.contextId !== frame.contextId || observation.engineFingerprint !== frame.engineFingerprint || !prepared.validObservation(observation)) continue;
        const search = prepared.evidence.searches[observation.searchId];
        if (search.request.trainingSide !== trainingSide || search.engineIdentity.wdlModel !== reference.search.engineIdentity.wdlModel) continue;
        for (const line of observation.lines) {
            const sample = { observation, search, line, score: normalizeScore(line.score, evaluationSide), e: lineE(line, evaluationSide) };
            // Retire a completed search's own fleeting point when its final
            // valid bundle omits the move. This adds no BAD/coverage conclusion;
            // earlier proof, active bounds and unfinished counters stay live.
            if (line.bound === 'UNBOUNDED' && search.completion === 'COMPLETED' && !prepared.currentPoint(sample)) continue;
            // Complete points supersede their earlier transient bounds. Until
            // then, a weaker later bound cannot erase a stronger counterexample.
            latest.set(line.moveUci, line.bound === 'UNBOUNDED' ? [sample] : [...latest.get(line.moveUci) ?? [], sample]);
        }
    }
    for (const candidate of [...latest.values()].flat()) {
        // Bounds are expressed in the score's POV. Only a lower bound in the
        // training side's POV can prove an alternative already beats reference.
        const bound = candidate.line.bound === 'UNBOUNDED' ? 'UNBOUNDED'
            : candidate.line.score.pov === evaluationSide ? candidate.line.bound
                : candidate.line.bound === 'LOWER' ? 'UPPER' : 'LOWER';
        if (bound === 'UPPER') continue;
        if (bound === 'UNBOUNDED' && candidate.score.kind === 'CP' && reference.score.kind === 'CP') {
            if (frame.model === 'MATCHED_WDL' && (candidate.e === null || reference.e === null)) continue;
            if (frame.model === 'CP_ONLY' && (candidate.e !== null || reference.e !== null)) continue;
        }
        // A CP score cannot refute an already proven mating win. A newly found
        // mating win (or escape from a losing mate) does require a new reference.
        const improvesKind = reference.score.kind === 'CP' && candidate.score.kind === 'MATE' && candidate.score.winner === evaluationSide
            || reference.score.kind === 'MATE' && reference.score.winner !== evaluationSide && candidate.score.kind === 'CP';
        const improvesComparable = reference.score.kind === 'CP' && candidate.score.kind === 'CP' && assessReferenceDrift(reference.score, candidate.score, bound === 'UNBOUNDED' ? reference.e : null, bound === 'UNBOUNDED' ? candidate.e : null, policy)
            || reference.score.kind === 'MATE' && candidate.score.kind === 'MATE' && reference.score.winner !== evaluationSide && candidate.score.winner === evaluationSide;
        if (improvesKind || improvesComparable) {
            const drift = { moveUci: candidate.line.moveUci, observationId: candidate.observation.id, referenceObservationId: reference.observation.id };
            prepared.frameDrift.set(key, drift); return drift;
        }
    }
    prepared.frameDrift.set(key, null); return null;
}
export type PracticeReferenceReadiness = {
    status: 'READY' | 'MISSING_ROOT' | 'MISSING_REFERENCE_PROBE' | 'REFERENCE_VALUE_DRIFT' | 'UNRESOLVED_REFERENCE';
    requiredWork: 'ROOT' | 'REFERENCE_PROBE' | null;
    contextId: string; frameId: string; preferredMoveUci: string;
    rootSearchId: string | null; probeSearchId: string | null;
    evidenceIds: string[]; counterEvidenceIds: string[];
};
export type PracticeReferenceReadinessInput = PracticeReferenceDriftInput;
/** Full-root choice plus a completed focused value check. This is finite engine
 * evidence, not a mathematical certificate that the selected move is optimal. */
export function assessPracticeReferenceReadiness(args: PracticeReferenceReadinessInput, facts?: PracticeValidationFacts): PracticeReferenceReadiness {
    return preparedReferenceReadiness(args, new AssessmentEvidenceContext(args.evidence, facts));
}
function preparedReferenceReadiness(args: PracticeReferenceReadinessInput, prepared: AssessmentEvidenceContext): PracticeReferenceReadiness {
    const { frame, trainingSide, referenceMoveUci } = args;
    const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const key = JSON.stringify([frame, trainingSide, referenceMoveUci, policy]);
    const cached = prepared.referenceReady.get(key);
    if (cached) return structuredClone(cached);
    const result: PracticeReferenceReadiness = { status: 'MISSING_ROOT', requiredWork: 'ROOT', contextId: frame.contextId,
        frameId: frame.id, preferredMoveUci: referenceMoveUci, rootSearchId: null, probeSearchId: null, evidenceIds: [], counterEvidenceIds: [] };
    const finish = (status: PracticeReferenceReadiness['status'], work: PracticeReferenceReadiness['requiredWork']) => {
        result.status = status; result.requiredWork = work;
        result.evidenceIds = [...new Set(result.evidenceIds)]; result.counterEvidenceIds = [...new Set(result.counterEvidenceIds)];
        prepared.referenceReady.set(key, structuredClone(result)); return result;
    };
    const input: AssessmentInput = { id: '', moveUci: referenceMoveUci, referenceMoveUci, originalMoveUci: referenceMoveUci, trainingSide, evidence: prepared.evidence };
    if (frame.status !== 'CURRENT' || frame.policyId !== policy.id) return finish('UNRESOLVED_REFERENCE', 'ROOT');
    if (frame.model === 'EXACT_OUTCOME') {
        const exact = exactSample(input, frame, referenceMoveUci, true, prepared);
        if (exact) { result.evidenceIds.push(exact.record.id); return finish('READY', null); }
        return finish('MISSING_ROOT', 'ROOT');
    }
    const fullRootObservations = prepared.observations.filter(observation => observation.contextId === frame.contextId
        && observation.engineFingerprint === frame.engineFingerprint && observation.bundleComplete
        && observation.lines.every(line => line.bound === 'UNBOUNDED') && prepared.validObservation(observation)
        && prepared.evidence.searches[observation.searchId].request.trainingSide === trainingSide
        && observation.rootScopeUci.length === prepared.legalCount(prepared.evidence.searches[observation.searchId].request.fen));
    let rootObservation = fullRootObservations.at(-1);
    // With one legal move both scopes are identical. Keep the two physical
    // witnesses distinct instead of counting the focused search twice.
    if (rootObservation?.rootScopeUci.length === 1) {
        const latestSearch = prepared.evidence.searches[rootObservation.searchId];
        if (latestSearch.completion === 'COMPLETED' && latestSearch.reportedNodes >= policy.minimumReferenceProbeNodes) {
            rootObservation = fullRootObservations.findLast(observation => observation.searchId !== latestSearch.id) ?? rootObservation;
        }
    }
    if (!rootObservation) return finish('MISSING_ROOT', 'ROOT');
    const root = prepared.evidence.searches[rootObservation.searchId]; result.rootSearchId = root.id;
    // Context binding uses the original training side. An automatic opponent
    // choice is evaluated from its actual side to move, never by rebinding it.
    const actor: Side = root.request.fen.split(' ')[1] === 'w' ? 'WHITE' : 'BLACK';
    const normalize = (window: Sample[]) => window.map(sample => ({ ...sample, score: normalizeScore(sample.line.score, actor), e: lineE(sample.line, actor) }));
    const rootWindow = normalize(samples(frame, input, referenceMoveUci, true, prepared, root.id));
    const roots = rootWindow.filter(sample => sample.line.bound === 'UNBOUNDED');
    const currentRootWindow = normalize(samples(frame, input, referenceMoveUci, true, prepared));
    const currentMoveWindow = normalize(samples(frame, input, referenceMoveUci, false, prepared));
    result.evidenceIds.push(...rootWindow.map(sample => sample.observation.id));
    result.counterEvidenceIds.push(...currentRootWindow.map(sample => sample.observation.id), ...currentMoveWindow.map(sample => sample.observation.id));
    const singletonSearches = [...new Set(prepared.observations.filter(observation => observation.contextId === frame.contextId
        && observation.engineFingerprint === frame.engineFingerprint && prepared.validObservation(observation)
        && observation.lines.some(line => line.moveUci === referenceMoveUci && line.bound === 'UNBOUNDED'))
        .map(observation => observation.searchId))].map(id => prepared.evidence.searches[id]).filter(search => search.request.trainingSide === trainingSide
            && search.id !== root.id && search.request.multiPv === 1 && search.request.rootScopeUci.length === 1 && search.request.rootScopeUci[0] === referenceMoveUci);
    result.probeSearchId = singletonSearches.at(-1)?.id ?? null;
    const latestRoot = roots.at(-1);
    if (!latestRoot || root.completion !== 'COMPLETED' || !converged(roots, policy, prepared)
        || !compatibleBounds(currentRootWindow, policy)) return finish('UNRESOLVED_REFERENCE', 'ROOT');
    const modelMatches = (window: Sample[]) => window.every(sample => sample.search.engineIdentity.wdlModel === root.engineIdentity.wdlModel
        && (sample.score.kind !== 'CP' || (frame.model === 'MATCHED_WDL' ? sample.e !== null : sample.e === null)));
    if (!modelMatches(roots)) return finish('UNRESOLVED_REFERENCE', 'ROOT');
    const drift = preparedReferenceDrift(args, prepared, actor);
    if (drift) { result.counterEvidenceIds.push(drift.observationId, drift.referenceObservationId); return finish('REFERENCE_VALUE_DRIFT', 'ROOT'); }
    const symbolicMate = roots.every(sample => sample.score.kind === 'MATE' && sample.score.winner === (latestRoot.score.kind === 'MATE' ? latestRoot.score.winner : null));
    if (symbolicMate) {
        const current = currentMoveWindow.filter(sample => sample.line.bound === 'UNBOUNDED');
        if (compatibleBounds(currentMoveWindow, policy) && current.every(sample => sample.score.kind === 'MATE' && latestRoot.score.kind === 'MATE' && sample.score.winner === latestRoot.score.winner)) return finish('READY', null);
        return finish('UNRESOLVED_REFERENCE', 'ROOT');
    }
    // Positive proof eligibility and newer counterevidence are separate. A
    // harmless cheap detail search cannot erase an already paid mature probe.
    const probe = singletonSearches.findLast(search => {
        if (search.completion !== 'COMPLETED' || search.reportedNodes < policy.minimumReferenceProbeNodes) return false;
        const window = normalize(samples(frame, input, referenceMoveUci, false, prepared, search.id));
        const points = window.filter(sample => sample.line.bound === 'UNBOUNDED');
        return modelMatches(points) && converged(points, policy, prepared) && compatibleBounds(window, policy);
    });
    result.probeSearchId = probe?.id ?? singletonSearches.at(-1)?.id ?? null;
    if (!probe) return finish('MISSING_REFERENCE_PROBE', 'REFERENCE_PROBE');
    const probeWindow = normalize(samples(frame, input, referenceMoveUci, false, prepared, probe.id));
    const probes = probeWindow.filter(sample => sample.line.bound === 'UNBOUNDED');
    result.evidenceIds.push(...probeWindow.map(sample => sample.observation.id));
    const nextWork = probe.sequence < root.sequence ? 'REFERENCE_PROBE' as const : 'ROOT' as const;
    if (!converged(probes, policy, prepared) || !modelMatches(probes) || !compatibleBounds(probeWindow, policy)
        || !compatibleBounds(currentMoveWindow, policy)) return finish('UNRESOLVED_REFERENCE', nextWork);
    const current = currentMoveWindow.filter(sample => sample.line.bound === 'UNBOUNDED');
    const latestProbe = probes.at(-1)!;
    const valueDrift = (sample: Sample) => assessReferenceDrift(latestRoot.score, sample.score, latestRoot.e, sample.e, policy)
        || assessReferenceDrift(sample.score, latestRoot.score, sample.e, latestRoot.e, policy);
    if (valueDrift(latestProbe) || current.some(valueDrift)) return finish('REFERENCE_VALUE_DRIFT', nextWork);
    const agrees = (window: Sample[]) => modelMatches(window)
        && roots.every(reference => window.every(move => pointQuality(reference.score, move.score, reference.e, move.e, frame, policy) === 'GOOD'))
        && supportedInterval(roots, window, frame, 'GOOD', policy).quality;
    if (!agrees(probes) || !agrees(current)) return finish('UNRESOLVED_REFERENCE', nextWork);
    return finish('READY', null);
}

/** Counterevidence veto for an automatic opponent root choice; never supplies its positive proof. */
export function practiceRootBoundsCompatible(args: {
    evidence: EvidenceStore; contextId: string; engineFingerprint: string; moveUci: string; trainingSide: Side; policy: AssessmentPolicy;
}, facts?: PracticeValidationFacts): boolean {
    const prepared = new AssessmentEvidenceContext(args.evidence, facts);
    const frame: ComparisonFrame = { id: 'root-bound-check', contextId: args.contextId, policyId: args.policy.id,
        engineFingerprint: args.engineFingerprint, model: 'CP_ONLY', referenceAssessmentId: '', status: 'CURRENT', supersededById: null };
    const input: AssessmentInput = { id: '', moveUci: args.moveUci, referenceMoveUci: args.moveUci,
        originalMoveUci: args.moveUci, trainingSide: args.trainingSide, evidence: prepared.evidence };
    return compatibleBounds(samples(frame, input, args.moveUci, true, prepared), args.policy);
}
/** A bound may coexist with old points only if their empirical interval still fits it. */
function compatibleBounds(window: Sample[], policy: AssessmentPolicy): boolean {
    const points = window.filter(sample => sample.line.bound === 'UNBOUNDED');
    if (!points.length) return false;
    const scalar = (score: PracticeScore) => score.kind === 'CP' ? score.cp
        : score.kind === 'MATE' ? score.winner === score.pov ? Infinity : -Infinity : NaN;
    const scores = points.map(sample => scalar(sample.score));
    const low = Math.min(...scores) - policy.cpSupportMargin;
    const high = Math.max(...scores) + policy.cpSupportMargin;
    return window.every(sample => {
        if (sample.line.bound === 'UNBOUNDED') return true;
        const lower = sample.line.bound === (sample.line.score.pov === sample.score.pov ? 'LOWER' : 'UPPER');
        const value = scalar(sample.score);
        return lower ? value <= high : value >= low;
    });
}
function converged(samples: Sample[], policy: AssessmentPolicy, prepared: AssessmentEvidenceContext): boolean {
    const latest = samples.at(-1);
    if (!latest || !prepared.currentPoint(latest)) return false;
    // Retain a mature earlier anchor, but require stronger actual work in the
    // latest point. A requested budget cannot mature either measurement.
    const mature = (sample: Sample, floor: number) => sample.observation.nodes >= floor
        && sample.search.reportedNodes >= floor;
    for (let index = samples.length - 2; index >= 0; index--) {
        const first = samples[index];
        if (!prepared.currentPoint(first) || !pairConverged([first, latest], policy)) continue;
        // Solved mating searches can finish naturally before any node floor.
        // This is stable symbolic ENGINE evidence, never a RULE/TB certificate.
        const stableMate = first.score.kind === 'MATE' && latest.score.kind === 'MATE'
            && first.score.winner === latest.score.winner;
        if (stableMate || mature(first, policy.minimumSupportNodes) && mature(latest, policy.latestSupportNodes)) return true;
    }
    return false;
}
/** Two adjacent completed mature groups supply positive proof. A younger tail
 * supplies no vote and may retain that proof only while every current interval
 * and bound supports the same conclusion against the current ready reference. */
function corroboratedFiniteComparison(frame: ComparisonFrame, input: AssessmentInput, refs: Sample[], quality: MoveAssessment['quality'], policy: AssessmentPolicy, prepared: AssessmentEvidenceContext): { supported: boolean; evidenceIds: string[] } {
    const candidates = [...new Set(prepared.observations.filter(observation => observation.contextId === frame.contextId
        && observation.engineFingerprint === frame.engineFingerprint && prepared.validObservation(observation)
        && prepared.evidence.searches[observation.searchId].request.trainingSide === input.trainingSide
        && observation.lines.some(line => line.moveUci === input.moveUci && line.bound === 'UNBOUNDED'))
        .map(observation => observation.searchId).reverse())];
    const groups = candidates.map(searchId => {
        const search = input.evidence.searches[searchId];
        const window = samples(frame, input, input.moveUci, false, prepared, searchId);
        const points = window.filter(sample => sample.line.bound === 'UNBOUNDED');
        // Desired quality never participates in eligibility: an opposite mature
        // group must be examined, not skipped in favour of an older agreement.
        const eligible = search.completion === 'COMPLETED' && converged(points, policy, prepared);
        return { search, window, points, eligible };
    });
    const firstProof = groups.findIndex(group => group.eligible);
    const relevant = firstProof < 0 ? groups : groups.slice(0, firstProof + policy.minimumCompletedSupportingSearches);
    const evidenceIds = relevant.flatMap(group => group.window.map(sample => sample.observation.id));
    if (firstProof < 0 || relevant.length < firstProof + policy.minimumCompletedSupportingSearches
        || relevant.slice(firstProof).some(group => !group.eligible)) return { supported: false, evidenceIds };
    for (const { search, window, points } of relevant) {
        if (search.engineIdentity.wdlModel !== refs.at(-1)?.search.engineIdentity.wdlModel) return { supported: false, evidenceIds };
        const supported = !!points.at(-1) && prepared.currentPoint(points.at(-1)!) && compatibleBounds(window, policy)
            && refs.every(reference => points.every(move => pointQuality(reference.score, move.score, reference.e, move.e, frame, policy) === quality))
            && supportedInterval(refs, points, frame, quality, policy).quality;
        if (!supported) return { supported: false, evidenceIds };
    }
    return { supported: true, evidenceIds };
}
function pairConverged(pair: Sample[], policy: AssessmentPolicy): boolean {
    if (pair.length !== 2) return false;
    const [first, last] = pair;
    if (last.observation.depth - first.observation.depth >= policy.minimumDepthGap) return true;
    if (first.search.id === last.search.id || first.search.completion !== 'COMPLETED' || last.search.completion !== 'COMPLETED') return false;
    const before = first.search.request.limit; const after = last.search.request.limit;
    return (before.nodes !== null && after.nodes !== null && after.nodes > before.nodes) ||
        (before.depth !== null && after.depth !== null && after.depth > before.depth) ||
        (before.movetimeMs !== null && after.movetimeMs !== null && after.movetimeMs > before.movetimeMs);
}
function interval(values: number[], margin: number, clamp = false): number[] {
    const low = Math.min(...values) - margin; const high = Math.max(...values) + margin;
    return clamp ? [Math.max(0, low), Math.min(1, high)] : [low, high];
}
function supportedInterval(reference: Sample[], move: Sample[], frame: ComparisonFrame, quality: MoveAssessment['quality'], policy: AssessmentPolicy): { quality: boolean; tier: Tier | null } {
    if (reference.length === move.length && reference.every((r, i) => r.observation.id === move[i]?.observation.id && r.line.moveUci === move[i]?.line.moveUci)) return { quality: quality === 'GOOD', tier: 'BEST' };
    if (reference.every(r => r.score.kind === 'MATE') && move.every(m => m.score.kind === 'MATE')) {
        const outcomes = reference.flatMap(r => move.map(m => pointQuality(r.score, m.score, null, null, frame, policy)));
        return { quality: outcomes.every(q => q === quality), tier: quality === 'BELOW_STANDARD' ? 'SUBPAR' : 'GOOD' };
    }
    if (!reference.every(r => r.score.kind === 'CP') || !move.every(m => m.score.kind === 'CP')) return { quality: false, tier: null };
    const refCp = interval(reference.map(r => r.score.kind === 'CP' ? r.score.cp : 0), policy.cpSupportMargin);
    const moveCp = interval(move.map(m => m.score.kind === 'CP' ? m.score.cp : 0), policy.cpSupportMargin);
    const refE: (number | null)[] = frame.model === 'MATCHED_WDL' ? interval(reference.map(r => r.e!), policy.expectedScoreSupportMargin, true) : [null];
    const moveE: (number | null)[] = frame.model === 'MATCHED_WDL' ? interval(move.map(m => m.e!), policy.expectedScoreSupportMargin, true) : [null];
    const tiers = new Set<Tier | null>(); let stable = true;
    for (const b of refCp) for (const m of moveCp) for (const be of refE) for (const me of moveE) {
        const q = pointQuality({ kind: 'CP', cp: b, pov: 'WHITE' }, { kind: 'CP', cp: m, pov: 'WHITE' }, be, me, frame, policy);
        if (q !== quality) stable = false;
        tiers.add(pointTier(q, b - m, be === null || me === null ? null : be - me, policy));
    }
    return { quality: stable, tier: tiers.size === 1 ? [...tiers][0] : null };
}
export function validExactRecord(record: ExactRecord): boolean {
    try {
        if (!record.complete || record.rules !== 'FIDE' || record.contextId !== practiceContextId(record.fen, record.positionHistory, record.trainingSide)) return false;
        const legal = legalMovesUci(record.fen);
        if (!record.rootScopeUci.length || new Set(record.rootScopeUci).size !== record.rootScopeUci.length || record.rootScopeUci.some(m => !legal.includes(m)) || record.results.length !== record.rootScopeUci.length || new Set(record.results.map(r => r.moveUci)).size !== record.results.length) return false;
        return record.results.every(result => {
            if (!record.rootScopeUci.includes(result.moveUci)) return false;
            if (record.source === 'TABLEBASE') return record.provider.length > 0;
            const board = new Chess(record.fen);
            board.move({ from: result.moveUci.slice(0, 2), to: result.moveUci.slice(2, 4), promotion: result.moveUci[4] });
            const terminal = ruleTerminalEvaluation(board.fen(), [...record.positionHistory, record.fen]);
            if (!terminal?.terminal) return false;
            const outcome: Outcome = terminal.terminal.outcome === 'DRAW' ? 'DRAW' : (board.turn() === 'w' ? 'WHITE' : 'BLACK') === record.trainingSide ? 'LOSS' : 'WIN';
            return outcome === result.outcome;
        });
    } catch { return false; }
}
function exactSample(input: AssessmentInput, frame: ComparisonFrame, move: string, reference: boolean, prepared: AssessmentEvidenceContext): { record: ExactRecord; score: Extract<PracticeScore, {kind: 'EXACT'}> } | null {
    let result = null;
    for (const record of Object.values(input.evidence.exact)) {
        if (record.contextId !== frame.contextId || record.trainingSide !== input.trainingSide || !prepared.validExact(record)) continue;
        const entry = record.results.find(r => r.moveUci === move);
        if (!entry) continue;
        if (reference && entry.outcome !== 'WIN' && record.rootScopeUci.length !== prepared.legalCount(record.fen)) continue;
        if (reference && record.results.some(r => rank(r.outcome) > rank(entry.outcome))) continue;
        result = { record, score: { kind: 'EXACT' as const, outcome: entry.outcome, distance: entry.distance, pov: input.trainingSide } };
    }
    return result;
}
function relation(move: PracticeScore | null, original: PracticeScore | null, recoveredCp: number | null, recoveredE: number | null, policy: AssessmentPolicy): MoveAssessment['originalRelation'] {
    if (move?.kind === 'EXACT' && original?.kind === 'EXACT') return rank(move.outcome) > rank(original.outcome) ? 'BETTER' : rank(move.outcome) < rank(original.outcome) ? 'WORSE' : 'EQUIVALENT';
    if (recoveredCp === null && recoveredE === null) return 'UNKNOWN';
    if (recoveredCp !== null && recoveredE !== null && recoveredCp * recoveredE < 0) return 'UNKNOWN';
    if ((recoveredCp !== null && recoveredCp >= policy.originalComparisonCp) || (recoveredE !== null && recoveredE >= policy.originalComparisonExpectedScore)) return 'BETTER';
    if ((recoveredCp !== null && recoveredCp <= -policy.originalComparisonCp) || (recoveredE !== null && recoveredE <= -policy.originalComparisonExpectedScore)) return 'WORSE';
    return 'EQUIVALENT';
}
/** Pure projection: never searches and never trusts a supplied support boolean. */
export function assessMove(frame: ComparisonFrame, input: AssessmentInput, policy: AssessmentPolicy = DEFAULT_ASSESSMENT_POLICY): MoveAssessment {
    return createAssessmentEvaluator(input.evidence)(frame, input, policy);
}
function assessPreparedMove(frame: ComparisonFrame, input: AssessmentInput, policy: AssessmentPolicy, prepared: AssessmentEvidenceContext): MoveAssessment {
    const output: MoveAssessment = {
        id: input.id, contextId: frame.contextId, moveUci: input.moveUci, frameId: frame.id,
        quality: 'UNKNOWN', qualitySupport: 'NONE', tier: null, tierSupport: 'NONE', score: null,
        metrics: { lossCp: null, lossExpectedScore: null, recoveredCp: null, recoveredExpectedScore: null, preservesExactOutcome: null },
        originalRelation: input.moveUci === input.originalMoveUci ? 'SAME_MOVE' : 'UNKNOWN', observationIds: [], source: 'CLIENT_ENGINE', pending: ['QUALITY', 'TIER', 'ORIGINAL_COMPARISON', 'EXPLANATION'],
    };
    if (frame.status !== 'CURRENT' || frame.policyId !== policy.id) return output;
    if (frame.model === 'EXACT_OUTCOME') {
        const reference = exactSample(input, frame, input.referenceMoveUci, true, prepared); const move = exactSample(input, frame, input.moveUci, false, prepared);
        const original = exactSample(input, frame, input.originalMoveUci, false, prepared);
        if (reference && move) {
            if (rank(move.score.outcome) > rank(reference.score.outcome)) return output;
            output.score = move.score; output.source = move.record.source;
            output.quality = pointQuality(reference.score, move.score, null, null, frame, policy);
            output.qualitySupport = 'SUPPORTED'; output.tier = output.quality === 'GOOD' ? (input.referenceMoveUci === input.moveUci ? 'BEST' : 'GOOD') : 'SUBPAR'; output.tierSupport = 'SUPPORTED';
            output.metrics.preservesExactOutcome = reference.score.outcome === move.score.outcome;
            output.observationIds = [...new Set([reference.record.id, move.record.id, ...(original ? [original.record.id] : [])])];
            if (output.originalRelation !== 'SAME_MOVE') output.originalRelation = relation(move.score, original?.score ?? null, null, null, policy);
        }
    } else {
        const refWindow = samples(frame, input, input.referenceMoveUci, true, prepared); const moveWindow = samples(frame, input, input.moveUci, false, prepared); const originalWindow = samples(frame, input, input.originalMoveUci, false, prepared);
        const refs = refWindow.filter(sample => sample.line.bound === 'UNBOUNDED'); const moves = moveWindow.filter(sample => sample.line.bound === 'UNBOUNDED'); const originals = originalWindow.filter(sample => sample.line.bound === 'UNBOUNDED');
        const ref = refs.at(-1); const move = moves.at(-1); const original = originals.at(-1);
        output.observationIds = [...new Set([...refWindow, ...moveWindow, ...originalWindow].map(s => s.observation.id))];
        if (move) {
            output.score = move.score;
            // Provenance covers the complete cited comparison, including a
            // browser reference combined with a paid server answer (or vice versa).
            output.source = output.observationIds.some(id => input.evidence.searches[input.evidence.observations[id]?.searchId]?.engineIdentity.source === 'CLIENT_ENGINE')
                ? 'CLIENT_ENGINE' : move.search.engineIdentity.source;
        }
        if (ref && move) {
            // An incompatible WDL model is not repaired by falling back to CP_ONLY.
            if (ref.search.engineIdentity.wdlModel !== move.search.engineIdentity.wdlModel) return output;
            output.metrics.lossCp = ref.score.kind === 'CP' && move.score.kind === 'CP' ? ref.score.cp - move.score.cp : null;
            output.metrics.lossExpectedScore = ref.e !== null && move.e !== null ? ref.e - move.e : null;
            if (original && original.search.engineIdentity.wdlModel === move.search.engineIdentity.wdlModel) {
                output.metrics.recoveredCp = original.score.kind === 'CP' && move.score.kind === 'CP' ? move.score.cp - original.score.cp : null;
                output.metrics.recoveredExpectedScore = original.e !== null && move.e !== null ? move.e - original.e : null;
            }
            const readiness = preparedReferenceReadiness({ evidence: input.evidence, frame, trainingSide: input.trainingSide, referenceMoveUci: input.referenceMoveUci, policy }, prepared);
            output.observationIds = [...new Set([...output.observationIds, ...readiness.evidenceIds, ...readiness.counterEvidenceIds])];
            const quality = pointQuality(ref.score, move.score, ref.e, move.e, frame, policy);
            const latestRoot = prepared.observations.filter(o => o.contextId === frame.contextId && o.engineFingerprint === frame.engineFingerprint && prepared.validObservation(o) && o.rootScopeUci.length === prepared.legalCount(input.evidence.searches[o.searchId].request.fen)).at(-1);
            const newestBest = latestRoot?.lines[0];
            const frameDrift = preparedReferenceDrift({ evidence: input.evidence, frame, trainingSide: input.trainingSide, referenceMoveUci: input.referenceMoveUci, policy }, prepared);
            if (frameDrift) output.observationIds = [...new Set([...output.observationIds, frameDrift.observationId, frameDrift.referenceObservationId])];
            const drift = frameDrift !== null || assessReferenceDrift(ref.score, move.score, ref.e, move.e, policy) || Boolean(newestBest && newestBest.bound === 'UNBOUNDED' && assessReferenceDrift(ref.score, normalizeScore(newestBest.score, input.trainingSide), ref.e, lineE(newestBest, input.trainingSide), policy));
            output.qualitySupport = quality === 'UNKNOWN' ? 'NONE' : 'PROVISIONAL';
            if (readiness.status === 'READY' && quality !== 'UNKNOWN' && !drift && compatibleBounds(refWindow, policy) && compatibleBounds(moveWindow, policy) && converged(refs, policy, prepared)) {
                const sameReference = input.moveUci === input.referenceMoveUci;
                const pointsAgree = sameReference || refs.every(r => moves.every(m => pointQuality(r.score, m.score, r.e, m.e, frame, policy) === quality));
                const support = sameReference ? { quality: quality === 'GOOD', tier: 'BEST' as const } : supportedInterval(refs, moves, frame, quality, policy);
                const symbolicMate = refs.every(sample => sample.score.kind === 'MATE') && moves.every(sample => sample.score.kind === 'MATE');
                const corroboration = input.moveUci === input.referenceMoveUci ? { supported: true, evidenceIds: [] }
                    : symbolicMate ? { supported: converged(moves, policy, prepared), evidenceIds: [] }
                    : corroboratedFiniteComparison(frame, input, refs, quality, policy, prepared);
                output.observationIds = [...new Set([...output.observationIds, ...corroboration.evidenceIds])];
                if (pointsAgree && support.quality && corroboration.supported) {
                    output.quality = quality; output.qualitySupport = 'SUPPORTED';
                    // Same-domain mate outcome prediction stays ENGINE evidence;
                    // no CP conversion or RULE/TABLEBASE provenance is invented.
                    if (ref.score.kind === 'MATE' && move.score.kind === 'MATE') output.metrics.preservesExactOutcome = ref.score.winner === move.score.winner;
                    output.tier = support.tier; output.tierSupport = support.tier ? 'SUPPORTED' : 'NONE';
                }
            }
            if (output.originalRelation !== 'SAME_MOVE' && compatibleBounds(moveWindow, policy) && compatibleBounds(originalWindow, policy) && converged(moves, policy, prepared) && converged(originals, policy, prepared)) {
                const relations = new Set<MoveAssessment['originalRelation']>();
                for (const m of moves) for (const o of originals) {
                    const cp = m.score.kind === 'CP' && o.score.kind === 'CP' ? m.score.cp - o.score.cp : null;
                    const e = m.e !== null && o.e !== null ? m.e - o.e : null;
                    const cps = cp === null ? [null] : [cp - 2 * policy.cpSupportMargin, cp + 2 * policy.cpSupportMargin];
                    const es = e === null ? [null] : [e - 2 * policy.expectedScoreSupportMargin, e + 2 * policy.expectedScoreSupportMargin];
                    for (const c of cps) for (const value of es) relations.add(relation(m.score, o.score, c, value, policy));
                }
                output.originalRelation = relations.size === 1 ? [...relations][0] : 'UNKNOWN';
            }
        }
    }
    if ((output.source === 'SERVER_ENGINE' || output.source === 'CLIENT_ENGINE')
        && output.observationIds.some(id => input.evidence.searches[input.evidence.observations[id]?.searchId]?.engineIdentity.source === 'CLIENT_ENGINE')) output.source = 'CLIENT_ENGINE';
    output.pending = [];
    if (output.qualitySupport !== 'SUPPORTED') output.pending.push('QUALITY');
    if (output.tierSupport !== 'SUPPORTED') output.pending.push('TIER');
    if (output.originalRelation === 'UNKNOWN') output.pending.push('ORIGINAL_COMPARISON');
    output.pending.push('EXPLANATION');
    return output;
}
/** Negative losses beyond observation margins require a new frame, not clamping. */
export function assessReferenceDrift(reference: PracticeScore, candidate: PracticeScore, referenceE: number | null, candidateE: number | null, policy: AssessmentPolicy = DEFAULT_ASSESSMENT_POLICY): boolean {
    if (reference.kind === 'EXACT' && candidate.kind === 'EXACT') return rank(candidate.outcome) > rank(reference.outcome);
    if (reference.kind === 'MATE' && candidate.kind === 'MATE') return reference.winner !== reference.pov && candidate.winner === reference.pov;
    if (reference.kind !== candidate.kind) return reference.kind === 'CP' && candidate.kind === 'MATE' && candidate.winner === reference.pov
        || reference.kind === 'MATE' && reference.winner !== reference.pov && candidate.kind === 'CP';
    return (reference.kind === 'CP' && candidate.kind === 'CP' && candidate.cp - reference.cp > policy.cpSupportMargin * 2) || (referenceE !== null && candidateE !== null && candidateE - referenceE > policy.expectedScoreSupportMargin * 2);
}
export function deriveDecisionAssessment(args: { original: MoveAssessment; reference: MoveAssessment; frame: ComparisonFrame; evidence: EvidenceStore; minimumConfirmationNodes: number; policy?: AssessmentPolicy }): DecisionAssessment {
    const { original, reference, frame, evidence } = args; const policy = args.policy ?? DEFAULT_ASSESSMENT_POLICY;
    const output: DecisionAssessment = { status: 'UNRESOLVED', reason: 'INSUFFICIENT_QUALITY_SUPPORT', originalAssessmentId: original.id, referenceAssessmentId: reference.id, selection: 'OMITTED', selectionReason: 'UNRESOLVED', selectionSignal: 'NONE', evidenceIds: [...new Set([...original.observationIds, ...reference.observationIds])] };
    const atBudget = (assessment: MoveAssessment, referenceScope = false) => {
        if (assessment.source === 'RULE' || assessment.source === 'TABLEBASE') return true;
        const moveObservations = orderedObservations(evidence).filter(observation => {
            const search = evidence.searches[observation.searchId];
            return search && observation.bundleComplete && observation.contextId === frame.contextId
                && observation.engineFingerprint === frame.engineFingerprint && assessment.observationIds.includes(observation.id)
                && observation.lines.some(line => line.moveUci === assessment.moveUci && line.bound === 'UNBOUNDED')
                && (!referenceScope || observation.rootScopeUci.length === legalMovesUci(search.request.fen).length);
        });
        const latest = moveObservations.at(-1); const search = latest && evidence.searches[latest.searchId];
        return Boolean(search?.completion === 'COMPLETED' && (search.request.limit.nodes ?? search.reportedNodes) >= args.minimumConfirmationNodes);
    };
    if (original.qualitySupport !== 'SUPPORTED' || reference.qualitySupport !== 'SUPPORTED' || reference.quality !== 'GOOD' || !atBudget(original) || !atBudget(reference, true)) return output;
    if (original.quality === 'GOOD') return { ...output, status: 'NOT_A_MISTAKE', reason: 'ORIGINAL_IS_GOOD', selectionReason: 'NOT_A_MISTAKE' };
    if (original.quality !== 'BELOW_STANDARD') return output;
    output.status = 'CONFIRMED_MISTAKE'; output.reason = 'SUPPORTED_QUALITY_LOSS'; output.selectionReason = 'NO_SELECTION_SIGNAL';
    const observed = (assessment: MoveAssessment) => orderedObservations(evidence).filter(o => assessment.observationIds.includes(o.id)).flatMap(o => o.lines.filter(l => l.moveUci === assessment.moveUci && l.bound === 'UNBOUNDED').map(line => ({ line, side: evidence.searches[o.searchId].request.trainingSide })));
    const refLines = observed(reference); const originalLines = observed(original);
    const refE = refLines.map(r => lineE(r.line, r.side)).filter((e): e is number => e !== null);
    const originalE = originalLines.map(r => lineE(r.line, r.side)).filter((e): e is number => e !== null);
    const cpValues = (lines: ReturnType<typeof observed>) => lines.map(r => normalizeScore(r.line.score, r.side)).filter((score): score is Extract<PracticeScore, {kind: 'CP'}> => score.kind === 'CP').map(score => score.cp);
    const refCp = cpValues(refLines); const originalCp = cpValues(originalLines);
    const minimumLossE = refE.length && originalE.length ? Math.min(...refE) - Math.max(...originalE) - 2 * policy.expectedScoreSupportMargin : -Infinity;
    const minimumLossCp = refCp.length && originalCp.length ? Math.min(...refCp) - Math.max(...originalCp) - 2 * policy.cpSupportMargin : -Infinity;
    if (original.metrics.preservesExactOutcome === false) output.selectionSignal = 'EXACT_OUTCOME_LOSS';
    else if (frame.model === 'MATCHED_WDL' && original.metrics.lossExpectedScore !== null && minimumLossE >= policy.selectionExpectedScoreLoss) output.selectionSignal = 'EXPECTED_SCORE_LOSS';
    else if (frame.model === 'CP_ONLY' && reference.score?.kind === 'CP' && Math.abs(reference.score.cp) < policy.saturationCp && minimumLossCp >= policy.selectionCpLoss) output.selectionSignal = 'NON_SATURATED_CP_LOSS';
    else if (frame.model === 'CP_ONLY' && reference.score?.kind === 'CP' && Math.abs(reference.score.cp) >= policy.saturationCp) output.selectionReason = 'SATURATED_CP_ONLY_SIGNAL';
    if (output.selectionSignal !== 'NONE') { output.selection = 'INCLUDED'; output.selectionReason = output.selectionSignal; }
    return output;
}
