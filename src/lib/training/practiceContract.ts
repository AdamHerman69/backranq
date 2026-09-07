import { Chess } from 'chess.js';
import { sha256Hex } from '@/lib/crypto/sha256';
import { assessPracticeReferenceReadiness, createAssessmentEvaluator, deriveDecisionAssessment, expectedScore, orderedObservations, practiceRootBoundsCompatible, validExactRecord, validObservation } from './assessmentPolicy';
import { deriveAnswerIndex, lookupAnswer } from './answerIndex';
import { createPracticeValidationFacts } from './practiceValidationFacts';

/** Canonical, JSON-only Practice v4 transport. No legacy payloads are accepted. */
export const PRACTICE_CONTRACT_VERSION = 4 as const;
export type Side = 'WHITE' | 'BLACK';
export type Outcome = 'WIN' | 'DRAW' | 'LOSS';
export type Quality = 'GOOD' | 'BELOW_STANDARD' | 'UNKNOWN';
export type Support = 'SUPPORTED' | 'PROVISIONAL' | 'NONE';
export type Tier = 'BEST' | 'STRONG' | 'GOOD' | 'SUBPAR';
export type PendingTask = 'QUALITY' | 'TIER' | 'ORIGINAL_COMPARISON' | 'EXPLANATION';
export type Wdl = { win: number; draw: number; loss: number };
export type PracticeScore =
    | { kind: 'CP'; cp: number; pov: Side }
    | { kind: 'MATE'; plies: number; winner: Side; pov: Side }
    | { kind: 'EXACT'; outcome: Outcome; distance: number | null; pov: Side };
export type AssessmentPolicy = {
    version: 4; id: string;
    minToleranceCp: number; maxToleranceCp: number; winningToleranceFraction: number;
    maxExpectedScoreLoss: number;
    bestMaxLossCp: number; bestMaxLossExpectedScore: number;
    strongMaxLossCp: number; strongMaxLossExpectedScore: number;
    cpSupportMargin: number; expectedScoreSupportMargin: number; minimumDepthGap: number; minimumSupportNodes: number; latestSupportNodes: number; minimumCompletedSupportingSearches: number; minimumReferenceProbeNodes: number;
    originalComparisonCp: number; originalComparisonExpectedScore: number;
    selectionExpectedScoreLoss: number; selectionCpLoss: number; saturationCp: number;
};
export const DEFAULT_ASSESSMENT_POLICY: AssessmentPolicy = {
    version: 4, id: 'practice-v4-2026-09-07-verified-reference',
    minToleranceCp: 100, maxToleranceCp: 300, winningToleranceFraction: 0.6,
    maxExpectedScoreLoss: 0.10, bestMaxLossCp: 20, bestMaxLossExpectedScore: 0.02,
    strongMaxLossCp: 50, strongMaxLossExpectedScore: 0.05,
    cpSupportMargin: 20, expectedScoreSupportMargin: 0.02, minimumDepthGap: 2, minimumSupportNodes: 25_000, latestSupportNodes: 100_000, minimumCompletedSupportingSearches: 2, minimumReferenceProbeNodes: 400_000,
    originalComparisonCp: 50, originalComparisonExpectedScore: 0.05,
    selectionExpectedScoreLoss: 0.08, selectionCpLoss: 100, saturationCp: 300,
};
export type SourceDecision = {
    gameId: string; sourcePgnHash: string; decisionPly: number; contextId: string;
    fen: string; positionHistory: string[]; trainingSide: Side; originalMoveUci: string;
};
export type ObservationLine = {
    moveUci: string; score: PracticeScore; bound: 'UNBOUNDED' | 'UPPER' | 'LOWER';
    wdl: Wdl | null; pvUci: string[];
};
export type AnalysisObservation = {
    id: string; searchId: string; snapshotIndex: number; contextId: string;
    engineFingerprint: string; rootScopeUci: string[]; requestedMultiPv: number;
    completedSlots: number; bundleComplete: boolean; depth: number;
    nodes: number; elapsedMs: number; lines: ObservationLine[];
};
export type SearchReason = 'SCAN' | 'MISSING_REFERENCE' | 'VERIFY_REFERENCE' | 'MISSING_MOVE' | 'UNSTABLE_QUALITY' | 'REFERENCE_DRIFT' | 'OPTIONAL_COVERAGE' | 'CONTINUATION';
export type SearchRecord = {
    id: string; contextId: string; sequence: number;
    engineIdentity: { fingerprint: string; artifactId: string; name: string; build: string; nnue: string; options: Record<string, string | number | boolean>; wdlModel: string | null; source: 'SERVER_ENGINE' | 'CLIENT_ENGINE' };
    sessionId: string;
    request: { fen: string; positionHistory: string[]; trainingSide: Side; rootScopeUci: string[]; multiPv: number; limit: { nodes: number | null; depth: number | null; movetimeMs: number | null } };
    reason: SearchReason; reportedNodes: number; reportedTimeMs: number;
    completion: 'COMPLETED' | 'STOPPED' | 'FAILED'; observationIds: string[];
};
/** Exact provider results retain their rule context and per-move outcomes. */
export type ExactRecord = {
    id: string; contextId: string; fen: string; positionHistory: string[]; trainingSide: Side;
    source: 'RULE' | 'TABLEBASE'; provider: string; rules: 'FIDE'; complete: boolean;
    rootScopeUci: string[];
    results: { moveUci: string; outcome: Outcome; distance: number | null }[];
};
export type EvidenceStore = {
    searches: Record<string, SearchRecord>;
    observations: Record<string, AnalysisObservation>;
    exact: Record<string, ExactRecord>;
};
export type ComparisonFrame = {
    id: string; contextId: string; policyId: string; engineFingerprint: string;
    model: 'MATCHED_WDL' | 'CP_ONLY' | 'EXACT_OUTCOME'; referenceAssessmentId: string;
    status: 'CURRENT' | 'SUPERSEDED'; supersededById: string | null;
};
export type MoveAssessment = {
    id: string; contextId: string; moveUci: string; frameId: string;
    quality: Quality; qualitySupport: Support; tier: Tier | null; tierSupport: Support;
    score: PracticeScore | null;
    metrics: { lossCp: number | null; lossExpectedScore: number | null; recoveredCp: number | null; recoveredExpectedScore: number | null; preservesExactOutcome: boolean | null };
    originalRelation: 'SAME_MOVE' | 'BETTER' | 'EQUIVALENT' | 'WORSE' | 'UNKNOWN';
    observationIds: string[]; source: 'SERVER_ENGINE' | 'CLIENT_ENGINE' | 'RULE' | 'TABLEBASE'; pending: PendingTask[];
};
export type CoverageGroup = {
    id: string; contextId: string; frameId: string; movesUci: string[];
    conclusion: 'BELOW_STANDARD'; basis: 'EXACT_OUTCOME' | 'ALL_SCOPE_ASSESSED' | 'CP_SCOPE_UPPER_BOUND'; evidenceIds: string[];
};
export type AnswerIndex = {
    contextId: string; frameId: string; legalMovesUci: string[]; assessmentIds: string[];
    coverageGroupIds: string[]; preferredMoveUci: string; unresolvedMovesUci: string[];
    readiness: 'PARTIAL' | 'ALL_MOVES_CLASSIFIED';
};
export type DecisionAssessment = {
    status: 'CONFIRMED_MISTAKE' | 'NOT_A_MISTAKE' | 'UNRESOLVED'; reason: string;
    originalAssessmentId: string; referenceAssessmentId: string; selection: 'INCLUDED' | 'OMITTED';
    selectionReason: string; selectionSignal: 'EXACT_OUTCOME_LOSS' | 'EXPECTED_SCORE_LOSS' | 'NON_SATURATED_CP_LOSS' | 'NONE'; evidenceIds: string[];
};
export type Continuation = {
    mode: 'SINGLE_DECISION' | 'VERIFIED_BRANCHES';
    explanationLines: { startContextId: string; movesUci: string[]; stopReason: string }[];
    nodes: { id: string; contextId: string; fen: string; positionHistory: string[]; trainingSide: Side; role: 'USER' | 'OPPONENT' | 'TERMINAL'; answerIndex: AnswerIndex | null }[];
    edges: { from: string; to: string; moveUci: string }[];
};
export type PracticeMomentRevision = {
    contractVersion: 4; momentId: string; revisionId: string; semanticHash: string;
    source: SourceDecision; policyId: string; policySnapshot: AssessmentPolicy;
    executionProfileId: string; executionProfileSnapshot: { id: string; minimumConfirmationNodes: number }; generatorVersion: string; decision: DecisionAssessment;
    rootAnswerIndex: AnswerIndex; continuation: Continuation;
    frames: ComparisonFrame[]; assessments: MoveAssessment[]; coverageGroups: CoverageGroup[]; evidence: EvidenceStore;
};
export type AnalysisReceipt = {
    sourcePgnHash: string; mode: 'FULL_GAME' | 'FIRST_PUZZLE'; executionProfileId: string;
    decisions: { decisionPly: number; scan: 'CANDIDATE' | 'NOT_SELECTED' | 'FAILED'; confirmation: DecisionAssessment['status'] | null; selection: DecisionAssessment['selection']; reason: string }[];
    stopReason: string; failureReasons: string[]; completeness: 'COMPLETE' | 'PARTIAL' | 'FAILED';
    cost: { physicalSearches: number; requestedNodes: number; reportedNodes: number; reportedTimeMs: number };
};
export type AttemptMove = {
    clientAttemptId: string; stepIndex: number; momentRevisionId: string; contextId: string;
    moveUci: string; playedAt: string; initialAssessmentId: string | null; initialCoverageGroupId: string | null; resolution: 'PENDING' | 'RESOLVED' | 'UNAVAILABLE';
};
export type AttemptAssessment = {
    eventId: string; clientAttemptId: string; stepIndex: number; sequence: number;
    supersedesEventId: string | null; frameId: string; assessment: MoveAssessment; evidence: EvidenceStore;
};

export function legalMovesUci(fen: string): string[] {
    return new Chess(fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`).sort();
}
/** Stable serialization, used for equality and semantic hashing; not a signature. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
    return JSON.stringify(value);
}
export function practiceFingerprint(value: unknown): string {
    const text = canonicalJson(value);
    return [0x811c9dc5, 0x9e3779b9].map(seed => {
        let hash = seed;
        for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
        return hash.toString(16).padStart(8, '0');
    }).join('');
}
export function practiceContextId(fen: string, positionHistory: readonly string[], trainingSide: Side): string {
    return `context:${practiceFingerprint({ fen: new Chess(fen).fen(), positionHistory: positionHistory.map(p => new Chess(p).fen()), trainingSide, rules: 'FIDE' })}`;
}

export type PracticeEvaluationPatch = { frame: ComparisonFrame; assessments: MoveAssessment[]; evidence: EvidenceStore };
export type ValidationResult<T> = { success: true; value: T } | { success: false; issues: string[] };

// One runtime schema definition generates both JSON Schema and strict parsing.
// The typed object builder checks every canonical field, including nullable fields.
type JsonSchema = { [key: string]: unknown };
type Schema<T> = { json: JsonSchema; read(value: unknown, path: string): T };
const fail = (path: string, message: string): never => { throw new Error(`${path}: ${message}`); };
function scalar<T>(json: JsonSchema, test: (v: unknown) => boolean): Schema<T> {
    return { json, read: (v, p) => test(v) ? v as T : fail(p, 'invalid value') };
}
const textSchema = scalar<string>({ type: 'string', minLength: 1 }, v => typeof v === 'string' && v.trim().length > 0);
const uciSchema = scalar<string>({ type: 'string', pattern: '^[a-h][1-8][a-h][1-8][qrbn]?$' }, v => typeof v === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(v));
const numberSchema = scalar<number>({ type: 'number' }, v => typeof v === 'number' && Number.isFinite(v));
const countSchema = scalar<number>({ type: 'integer', minimum: 0 }, v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
const positiveCount = scalar<number>({ type: 'integer', minimum: 1 }, v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1);
const nonnegativeNumber = scalar<number>({ type: 'number', minimum: 0 }, v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
const boolSchema = scalar<boolean>({ type: 'boolean' }, v => typeof v === 'boolean');
function enumeration<const T extends readonly (string | number)[]>(...values: T): Schema<T[number]> { return scalar({ enum: [...values] }, v => values.includes(v as T[number])); }
function nullable<T>(schema: Schema<T>): Schema<T | null> { return { json: { anyOf: [schema.json, { type: 'null' }] }, read: (v, p) => v === null ? null : schema.read(v, p) }; }
function array<T>(schema: Schema<T>, unique = false): Schema<T[]> {
    return { json: { type: 'array', items: schema.json, ...(unique ? { uniqueItems: true } : {}) }, read(v, p) {
        if (!Array.isArray(v)) return fail(p, 'expected array');
        const result = v.map((item, i) => schema.read(item, `${p}[${i}]`));
        if (unique && new Set(result.map(canonicalJson)).size !== result.length) return fail(p, 'duplicate array item');
        return result;
    } };
}
function object<T extends object>(fields: { [K in keyof T]-?: Schema<T[K]> }): Schema<T> {
    return { json: { type: 'object', properties: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, (v as Schema<unknown>).json])), required: Object.keys(fields), additionalProperties: false }, read(v, p) {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'expected object');
        const input = v as Record<string, unknown>; const result: Record<string, unknown> = {};
        for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) fail(`${p}.${key}`, 'unexpected field');
        for (const [key, schema] of Object.entries(fields)) {
            if (!Object.hasOwn(input, key)) fail(`${p}.${key}`, 'missing required field');
            result[key] = (schema as Schema<unknown>).read(input[key], `${p}.${key}`);
        }
        return result as T;
    } };
}
function dictionary<T>(schema: Schema<T>): Schema<Record<string, T>> {
    return { json: { type: 'object', additionalProperties: schema.json }, read(v, p) {
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(p, 'expected dictionary');
        return Object.fromEntries(Object.entries(v).map(([k, item]) => [textSchema.read(k, p), schema.read(item, `${p}.${k}`)]));
    } };
}
function union<T>(...schemas: Schema<unknown>[]): Schema<T> { return { json: { anyOf: schemas.map(s => s.json) }, read(v, p) { for (const s of schemas) { try { return s.read(v, p) as T; } catch { /* try next discriminant */ } } return fail(p, 'invalid union'); } }; }
const sideSchema = enumeration('WHITE', 'BLACK');
const outcomeSchema = enumeration('WIN', 'DRAW', 'LOSS');
const scoreSchema = union<PracticeScore>(
    object<{ kind: 'CP'; cp: number; pov: Side }>({ kind: enumeration('CP'), cp: numberSchema, pov: sideSchema }),
    object<{ kind: 'MATE'; plies: number; winner: Side; pov: Side }>({ kind: enumeration('MATE'), plies: countSchema, winner: sideSchema, pov: sideSchema }),
    object<{ kind: 'EXACT'; outcome: Outcome; distance: number | null; pov: Side }>({ kind: enumeration('EXACT'), outcome: outcomeSchema, distance: nullable(countSchema), pov: sideSchema }),
);
const wdlSchema = object<Wdl>({ win: nonnegativeNumber, draw: nonnegativeNumber, loss: nonnegativeNumber });
const policySchema = object<AssessmentPolicy>({
    version: enumeration(4), id: textSchema,
    minToleranceCp: nonnegativeNumber, maxToleranceCp: nonnegativeNumber, winningToleranceFraction: nonnegativeNumber,
    maxExpectedScoreLoss: nonnegativeNumber, bestMaxLossCp: nonnegativeNumber, bestMaxLossExpectedScore: nonnegativeNumber,
    strongMaxLossCp: nonnegativeNumber, strongMaxLossExpectedScore: nonnegativeNumber,
    cpSupportMargin: nonnegativeNumber, expectedScoreSupportMargin: nonnegativeNumber, minimumDepthGap: positiveCount, minimumSupportNodes: positiveCount, latestSupportNodes: positiveCount, minimumCompletedSupportingSearches: positiveCount, minimumReferenceProbeNodes: positiveCount,
    originalComparisonCp: nonnegativeNumber, originalComparisonExpectedScore: nonnegativeNumber,
    selectionExpectedScoreLoss: nonnegativeNumber, selectionCpLoss: nonnegativeNumber, saturationCp: nonnegativeNumber,
});
const sourceSchema = object<SourceDecision>({ gameId: textSchema, sourcePgnHash: textSchema, decisionPly: countSchema, contextId: textSchema, fen: textSchema, positionHistory: array(textSchema), trainingSide: sideSchema, originalMoveUci: uciSchema });
const observationSchema = object<AnalysisObservation>({
    id: textSchema, searchId: textSchema, snapshotIndex: countSchema, contextId: textSchema, engineFingerprint: textSchema,
    rootScopeUci: array(uciSchema, true), requestedMultiPv: positiveCount, completedSlots: countSchema,
    bundleComplete: boolSchema, depth: countSchema, nodes: countSchema, elapsedMs: nonnegativeNumber,
    lines: array(object<ObservationLine>({ moveUci: uciSchema, score: scoreSchema, bound: enumeration('UNBOUNDED', 'UPPER', 'LOWER'), wdl: nullable(wdlSchema), pvUci: array(uciSchema) })),
});
const searchSchema = object<SearchRecord>({
    id: textSchema, contextId: textSchema, sequence: countSchema, sessionId: textSchema,
    engineIdentity: object<SearchRecord['engineIdentity']>({ fingerprint: textSchema, artifactId: textSchema, name: textSchema, build: textSchema, nnue: textSchema, options: dictionary(union<string | number | boolean>(textSchema, numberSchema, boolSchema)), wdlModel: nullable(textSchema), source: enumeration('SERVER_ENGINE', 'CLIENT_ENGINE') }),
    request: object<SearchRecord['request']>({ fen: textSchema, positionHistory: array(textSchema), trainingSide: sideSchema, rootScopeUci: array(uciSchema, true), multiPv: positiveCount, limit: object<SearchRecord['request']['limit']>({ nodes: nullable(countSchema), depth: nullable(countSchema), movetimeMs: nullable(nonnegativeNumber) }) }),
    reason: enumeration('SCAN', 'MISSING_REFERENCE', 'VERIFY_REFERENCE', 'MISSING_MOVE', 'UNSTABLE_QUALITY', 'REFERENCE_DRIFT', 'OPTIONAL_COVERAGE', 'CONTINUATION'),
    reportedNodes: countSchema, reportedTimeMs: nonnegativeNumber, completion: enumeration('COMPLETED', 'STOPPED', 'FAILED'), observationIds: array(textSchema, true),
});
const exactSchema = object<ExactRecord>({ id: textSchema, contextId: textSchema, fen: textSchema, positionHistory: array(textSchema), trainingSide: sideSchema, source: enumeration('RULE', 'TABLEBASE'), provider: textSchema, rules: enumeration('FIDE'), complete: boolSchema, rootScopeUci: array(uciSchema, true), results: array(object<ExactRecord['results'][number]>({ moveUci: uciSchema, outcome: outcomeSchema, distance: nullable(countSchema) })) });
const evidenceSchema = object<EvidenceStore>({ searches: dictionary(searchSchema), observations: dictionary(observationSchema), exact: dictionary(exactSchema) });
const frameSchema = object<ComparisonFrame>({ id: textSchema, contextId: textSchema, policyId: textSchema, engineFingerprint: textSchema, model: enumeration('MATCHED_WDL', 'CP_ONLY', 'EXACT_OUTCOME'), referenceAssessmentId: textSchema, status: enumeration('CURRENT', 'SUPERSEDED'), supersededById: nullable(textSchema) });
const assessmentSchema = object<MoveAssessment>({
    id: textSchema, contextId: textSchema, moveUci: uciSchema, frameId: textSchema,
    quality: enumeration('GOOD', 'BELOW_STANDARD', 'UNKNOWN'), qualitySupport: enumeration('SUPPORTED', 'PROVISIONAL', 'NONE'),
    tier: nullable(enumeration('BEST', 'STRONG', 'GOOD', 'SUBPAR')), tierSupport: enumeration('SUPPORTED', 'PROVISIONAL', 'NONE'), score: nullable(scoreSchema),
    metrics: object<MoveAssessment['metrics']>({ lossCp: nullable(numberSchema), lossExpectedScore: nullable(numberSchema), recoveredCp: nullable(numberSchema), recoveredExpectedScore: nullable(numberSchema), preservesExactOutcome: nullable(boolSchema) }),
    originalRelation: enumeration('SAME_MOVE', 'BETTER', 'EQUIVALENT', 'WORSE', 'UNKNOWN'), observationIds: array(textSchema, true), source: enumeration('SERVER_ENGINE', 'CLIENT_ENGINE', 'RULE', 'TABLEBASE'), pending: array(enumeration('QUALITY', 'TIER', 'ORIGINAL_COMPARISON', 'EXPLANATION'), true),
});
const coverageSchema = object<CoverageGroup>({ id: textSchema, contextId: textSchema, frameId: textSchema, movesUci: array(uciSchema, true), conclusion: enumeration('BELOW_STANDARD'), basis: enumeration('EXACT_OUTCOME', 'ALL_SCOPE_ASSESSED', 'CP_SCOPE_UPPER_BOUND'), evidenceIds: array(textSchema, true) });
const indexSchema = object<AnswerIndex>({ contextId: textSchema, frameId: textSchema, legalMovesUci: array(uciSchema, true), assessmentIds: array(textSchema, true), coverageGroupIds: array(textSchema, true), preferredMoveUci: uciSchema, unresolvedMovesUci: array(uciSchema, true), readiness: enumeration('PARTIAL', 'ALL_MOVES_CLASSIFIED') });
const decisionSchema = object<DecisionAssessment>({ status: enumeration('CONFIRMED_MISTAKE', 'NOT_A_MISTAKE', 'UNRESOLVED'), reason: textSchema, originalAssessmentId: textSchema, referenceAssessmentId: textSchema, selection: enumeration('INCLUDED', 'OMITTED'), selectionReason: textSchema, selectionSignal: enumeration('EXACT_OUTCOME_LOSS', 'EXPECTED_SCORE_LOSS', 'NON_SATURATED_CP_LOSS', 'NONE'), evidenceIds: array(textSchema, true) });
const continuationSchema = object<Continuation>({ mode: enumeration('SINGLE_DECISION', 'VERIFIED_BRANCHES'), explanationLines: array(object<Continuation['explanationLines'][number]>({ startContextId: textSchema, movesUci: array(uciSchema), stopReason: textSchema })), nodes: array(object<Continuation['nodes'][number]>({ id: textSchema, contextId: textSchema, fen: textSchema, positionHistory: array(textSchema), trainingSide: sideSchema, role: enumeration('USER', 'OPPONENT', 'TERMINAL'), answerIndex: nullable(indexSchema) })), edges: array(object<Continuation['edges'][number]>({ from: textSchema, to: textSchema, moveUci: uciSchema })) });
const revisionSchema = object<PracticeMomentRevision>({ contractVersion: enumeration(4), momentId: textSchema, revisionId: textSchema, semanticHash: textSchema, source: sourceSchema, policyId: textSchema, policySnapshot: policySchema, executionProfileId: textSchema, executionProfileSnapshot: object<PracticeMomentRevision['executionProfileSnapshot']>({ id: textSchema, minimumConfirmationNodes: positiveCount }), generatorVersion: textSchema, decision: decisionSchema, rootAnswerIndex: indexSchema, continuation: continuationSchema, frames: array(frameSchema), assessments: array(assessmentSchema), coverageGroups: array(coverageSchema), evidence: evidenceSchema });
const patchSchema = object<PracticeEvaluationPatch>({ frame: frameSchema, assessments: array(assessmentSchema), evidence: evidenceSchema });
export const PRACTICE_MOMENT_JSON_SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...revisionSchema.json };
export const PRACTICE_EVALUATION_PATCH_JSON_SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...patchSchema.json };

/** Projection resolves references, so allocation of physical IDs cannot change semantics. */
export function canonicalPracticeSemantics(revision: PracticeMomentRevision): unknown {
    const assessmentById = new Map(revision.assessments.map(a => [a.id, a]));
    const assessment = (a: MoveAssessment) => ({ contextId: a.contextId, moveUci: a.moveUci, quality: a.quality, qualitySupport: a.qualitySupport, tier: a.tier, tierSupport: a.tierSupport, score: a.score, metrics: a.metrics, originalRelation: a.originalRelation, source: a.source, pending: [...a.pending].sort() });
    const frame = (id: string) => {
        const f = revision.frames.find(item => item.id === id);
        if (!f) return null;
        const reference = assessmentById.get(f.referenceAssessmentId);
        return { contextId: f.contextId, policyId: f.policyId, model: f.model, status: f.status, reference: reference ? assessment(reference) : null };
    };
    const coverage = (g: CoverageGroup) => ({ contextId: g.contextId, frame: frame(g.frameId), movesUci: [...g.movesUci].sort(), conclusion: g.conclusion, basis: g.basis });
    const sorted = <T>(values: T[]) => values.sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0);
    const index = (i: AnswerIndex) => ({ contextId: i.contextId, frame: frame(i.frameId), legalMovesUci: [...i.legalMovesUci].sort(), preferredMoveUci: i.preferredMoveUci, unresolvedMovesUci: [...i.unresolvedMovesUci].sort(), readiness: i.readiness, assessments: sorted(i.assessmentIds.map(id => assessmentById.get(id)).filter((a): a is MoveAssessment => Boolean(a)).map(assessment)), coverageGroups: sorted(revision.coverageGroups.filter(g => i.coverageGroupIds.includes(g.id)).map(coverage)) });
    const nodeKey = (id: string) => revision.continuation.nodes.find(n => n.id === id)?.contextId ?? null;
    return {
        contractVersion: 4, source: revision.source, policyId: revision.policyId, policySnapshot: revision.policySnapshot,
        decision: { status: revision.decision.status, reason: revision.decision.reason, selection: revision.decision.selection, selectionReason: revision.decision.selectionReason, selectionSignal: revision.decision.selectionSignal, original: assessmentById.has(revision.decision.originalAssessmentId) ? assessment(assessmentById.get(revision.decision.originalAssessmentId)!) : null, reference: assessmentById.has(revision.decision.referenceAssessmentId) ? assessment(assessmentById.get(revision.decision.referenceAssessmentId)!) : null },
        rootAnswerIndex: index(revision.rootAnswerIndex), frames: sorted(revision.frames.map(f => frame(f.id))),
        assessments: sorted(revision.assessments.map(a => ({ ...assessment(a), frame: frame(a.frameId) }))), coverageGroups: sorted(revision.coverageGroups.map(coverage)),
        continuation: { mode: revision.continuation.mode, explanationLines: sorted(revision.continuation.explanationLines), nodes: sorted(revision.continuation.nodes.map(n => ({ contextId: n.contextId, fen: n.fen, positionHistory: n.positionHistory, trainingSide: n.trainingSide, role: n.role, answerIndex: n.answerIndex ? index(n.answerIndex) : null }))), edges: sorted(revision.continuation.edges.map(e => ({ from: nodeKey(e.from), to: nodeKey(e.to), moveUci: e.moveUci }))) },
    };
}
export async function practiceSemanticHash(revision: PracticeMomentRevision): Promise<string> { return sha256Hex(canonicalJson(canonicalPracticeSemantics(revision))); }

function requireCondition(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal(a: unknown, b: unknown, message: string): void { requireCondition(canonicalJson(a) === canonicalJson(b), message); }
function uniqueIds(items: readonly {id: string}[], kind: string): void { requireCondition(new Set(items.map(x => x.id)).size === items.length, `Duplicate ${kind} ID`); }
function validateHistory(fen: string, history: readonly string[]): void {
    const positions = [...history, fen];
    for (let i = 0; i < positions.length; i++) {
        const board = new Chess(positions[i]);
        requireCondition(board.fen() === positions[i], 'Position must be a canonical FEN');
        if (i === positions.length - 1) continue;
        const target = positions[i + 1];
        // chess.js builds Move.after by making this legal move and serializing
        // the full resulting FEN (including rule counters), then undoing it.
        const replayable = board.moves({ verbose: true }).some(move => move.after === target);
        requireCondition(replayable, 'Position history contains a non-legal transition');
    }
}
/** Fresh for each parse; keys contain full positions/history, never asserted IDs. */
class RevisionPositionValidation {
    readonly facts = createPracticeValidationFacts();
    private readonly legalByFen = new Map<string, readonly string[]>();
    private readonly checkedHistories = new Set<string>();
    private readonly contextIds = new Map<string, string>();

    legal(fen: string): readonly string[] {
        let moves = this.legalByFen.get(fen);
        if (!moves) { moves = this.facts.legalMovesUci(fen); this.legalByFen.set(fen, moves); }
        return moves;
    }
    history(fen: string, history: readonly string[]): void {
        const key = canonicalJson([fen, history]);
        if (this.checkedHistories.has(key)) return;
        validateHistory(fen, history);
        this.checkedHistories.add(key);
    }
    contextId(fen: string, history: readonly string[], side: Side): string {
        const key = canonicalJson([fen, history, side]);
        let id = this.contextIds.get(key);
        if (!id) { id = this.facts.contextId(fen, history, side); this.contextIds.set(key, id); }
        return id;
    }
}
function validatePolicy(policy: AssessmentPolicy): void {
    requireCondition(policy.minimumReferenceProbeNodes >= policy.latestSupportNodes, 'Reference probe strength cannot be weaker than latest support');
    requireCondition(policy.latestSupportNodes >= policy.minimumSupportNodes, 'Latest support strength cannot be weaker than its anchor');
    requireCondition(policy.minToleranceCp <= policy.maxToleranceCp && policy.bestMaxLossCp <= policy.strongMaxLossCp && policy.bestMaxLossExpectedScore <= policy.strongMaxLossExpectedScore, 'Inconsistent policy thresholds');
    requireCondition(policy.winningToleranceFraction <= 1 && [policy.maxExpectedScoreLoss, policy.bestMaxLossExpectedScore, policy.strongMaxLossExpectedScore, policy.expectedScoreSupportMargin, policy.originalComparisonExpectedScore, policy.selectionExpectedScoreLoss].every(n => n <= 1), 'Invalid expected-score policy threshold');
    // The current policy ID denotes these exact rules. New calibration gets a new ID.
    if (policy.id === DEFAULT_ASSESSMENT_POLICY.id) equal(policy, DEFAULT_ASSESSMENT_POLICY, 'Policy snapshot does not match its registered ID');
}
function validateEvidence(store: EvidenceStore, contexts: Map<string, {fen: string; positionHistory: string[]; trainingSide: Side}>, positions: RevisionPositionValidation): void {
    const physical = new Set<string>();
    const searchSequences = new Set<string>();
    const engines = new Map<string, string>();
    for (const [id, search] of Object.entries(store.searches)) {
        requireCondition(id === search.id, 'Search dictionary key differs from ID');
        const searchOrdinal = `${search.contextId}:${search.engineIdentity.fingerprint}:${search.sequence}`;
        requireCondition(!searchSequences.has(searchOrdinal), 'Duplicate physical search sequence'); searchSequences.add(searchOrdinal);
        const request = search.request;
        requireCondition(search.contextId === positions.contextId(request.fen, request.positionHistory, request.trainingSide), 'Search context is not its declared position/history');
        const context = contexts.get(search.contextId);
        requireCondition(context, 'Search context missing from revision');
        equal(context, { fen: request.fen, positionHistory: request.positionHistory, trainingSide: request.trainingSide }, 'Search disagrees with revision context');
        positions.history(request.fen, request.positionHistory);
        const legal = positions.legal(request.fen);
        requireCondition(request.rootScopeUci.length > 0 && request.rootScopeUci.every(m => legal.includes(m)), 'Invalid search root scope');
        requireCondition(Object.values(request.limit).some(n => n !== null && n > 0), 'Search requires a positive work limit');
        const identity = canonicalJson({ ...Object.fromEntries(Object.entries(search.engineIdentity).filter(([key]) => key !== 'source')), options: Object.fromEntries(Object.entries(search.engineIdentity.options).filter(([key]) => key !== 'MultiPV')) });
        const previousIdentity = engines.get(search.engineIdentity.fingerprint);
        requireCondition(!previousIdentity || previousIdentity === identity, 'Engine fingerprint aliases incompatible engines/models');
        engines.set(search.engineIdentity.fingerprint, identity);
        for (const observationId of search.observationIds) requireCondition(store.observations[observationId]?.searchId === id, 'Search observation reference is missing or belongs to another search');
    }
    for (const [id, observation] of Object.entries(store.observations)) {
        requireCondition(id === observation.id, 'Observation dictionary key differs from ID');
        requireCondition(validObservation(observation, store, positions.facts), 'Malformed, partial, illegal, or incompatible observation');
        const key = `${observation.searchId}:${observation.snapshotIndex}`;
        requireCondition(!physical.has(key), 'Duplicate physical snapshot cannot add support'); physical.add(key);
        const search = store.searches[observation.searchId];
        requireCondition(observation.nodes <= search.reportedNodes && observation.elapsedMs <= search.reportedTimeMs, 'Observation exceeds physical search cost');
        for (const line of observation.lines) if (line.wdl) expectedScore(line.wdl);
    }
    for (const [id, record] of Object.entries(store.exact)) {
        requireCondition(id === record.id, 'Exact dictionary key differs from ID');
        requireCondition(validExactRecord(record), 'Invalid rule/exact evidence');
        const context = contexts.get(record.contextId);
        requireCondition(context, 'Exact evidence context missing from revision');
        equal(context, { fen: record.fen, positionHistory: record.positionHistory, trainingSide: record.trainingSide }, 'Exact evidence disagrees with revision context');
        positions.history(record.fen, record.positionHistory);
    }
}
function evidenceHas(store: EvidenceStore, id: string): boolean { return Boolean(store.observations[id] || store.searches[id] || store.exact[id]); }
function validateAssessments(revision: Pick<PracticeMomentRevision, 'source' | 'policyId' | 'policySnapshot' | 'frames' | 'assessments' | 'evidence'>, contexts: Map<string, {fen: string; positionHistory: string[]; trainingSide: Side}>, positions: RevisionPositionValidation): void {
    uniqueIds(revision.frames, 'frame'); uniqueIds(revision.assessments, 'assessment');
    const frameIds = new Set(revision.frames.map(f => f.id));
    const evaluateCurrent = createAssessmentEvaluator(revision.evidence, positions.facts);
    for (const frame of revision.frames) {
        requireCondition(frame.policyId === revision.policyId && contexts.has(frame.contextId), 'Invalid comparison frame context/policy');
        requireCondition(frame.status === 'CURRENT' ? frame.supersededById === null : frame.supersededById !== null && frameIds.has(frame.supersededById) && frame.supersededById !== frame.id, 'Invalid frame supersession');
        const reference = revision.assessments.find(a => a.id === frame.referenceAssessmentId);
        requireCondition(reference && reference.contextId === frame.contextId && reference.frameId === frame.id, 'Missing or incompatible reference assessment');
    }
    for (const assessment of revision.assessments) {
        const frame = revision.frames.find(f => f.id === assessment.frameId);
        const context = contexts.get(assessment.contextId);
        requireCondition(frame && context && frame.contextId === assessment.contextId && positions.legal(context.fen).includes(assessment.moveUci), 'Assessment has wrong frame/context or illegal move');
        requireCondition(assessment.observationIds.every(id => Boolean(revision.evidence.observations[id] || revision.evidence.exact[id])), 'Missing assessment evidence');
        const reference = revision.assessments.find(a => a.id === frame.referenceAssessmentId)!;
        let evidence = revision.evidence;
        if (frame.status === 'SUPERSEDED') {
            // Historic claims stay auditable using exactly their cited observations.
            const ids = new Set([...assessment.observationIds, ...reference.observationIds]);
            evidence = { ...evidence, observations: Object.fromEntries(Object.entries(evidence.observations).filter(([id]) => ids.has(id))), exact: Object.fromEntries(Object.entries(evidence.exact).filter(([id]) => ids.has(id))) };
        }
        const evaluate = frame.status === 'CURRENT' ? evaluateCurrent : createAssessmentEvaluator(evidence, positions.facts);
        const derived = evaluate({ ...frame, status: 'CURRENT', supersededById: null }, { id: assessment.id, moveUci: assessment.moveUci, trainingSide: context.trainingSide, referenceMoveUci: reference.moveUci, originalMoveUci: revision.source.contextId === assessment.contextId ? revision.source.originalMoveUci : reference.moveUci }, revision.policySnapshot);
        equal(assessment, derived, `Assessment ${assessment.id} is not implied by its evidence and policy`);
    }
}
function revisionContexts(revision: Pick<PracticeMomentRevision, 'source' | 'continuation'>, positions: RevisionPositionValidation): Map<string, {fen: string; positionHistory: string[]; trainingSide: Side}> {
    const contexts = new Map<string, {fen: string; positionHistory: string[]; trainingSide: Side}>();
    for (const item of [revision.source, ...revision.continuation.nodes]) {
        requireCondition(item.contextId === positions.contextId(item.fen, item.positionHistory, item.trainingSide), 'Context ID does not include canonical position/history/side');
        const value = { fen: item.fen, positionHistory: item.positionHistory, trainingSide: item.trainingSide };
        const existing = contexts.get(item.contextId); if (existing) equal(existing, value, 'Context collision');
        contexts.set(item.contextId, value);
    }
    return contexts;
}
function validateRevisionSemantics(revision: PracticeMomentRevision, options: { minimumConfirmationNodes?: number }): void {
    requireCondition(revision.executionProfileId === revision.executionProfileSnapshot.id, 'Execution profile ID differs from snapshot');
    requireCondition(/^[0-9a-f]{64}$/.test(revision.semanticHash), 'Semantic hash must be SHA-256');
    if (options.minimumConfirmationNodes !== undefined) requireCondition(options.minimumConfirmationNodes === revision.executionProfileSnapshot.minimumConfirmationNodes, 'Execution profile differs from authoritative confirmation budget');
    requireCondition(revision.policyId === revision.policySnapshot.id, 'Policy ID and snapshot disagree'); validatePolicy(revision.policySnapshot);
    const positions = new RevisionPositionValidation();
    const contexts = revisionContexts(revision, positions);
    positions.history(revision.source.fen, revision.source.positionHistory);
    requireCondition((new Chess(revision.source.fen).turn() === 'w' ? 'WHITE' : 'BLACK') === revision.source.trainingSide, 'Source decision must belong to training side');
    requireCondition(positions.legal(revision.source.fen).includes(revision.source.originalMoveUci), 'Original move is illegal');
    validateEvidence(revision.evidence, contexts, positions); validateAssessments(revision, contexts, positions); uniqueIds(revision.coverageGroups, 'coverage group');
    const assessCurrentCoverage = revision.coverageGroups.length ? createAssessmentEvaluator(revision.evidence, positions.facts) : null;
    for (const group of revision.coverageGroups) {
        requireCondition(group.movesUci.length && group.evidenceIds.length && group.evidenceIds.every(id => evidenceHas(revision.evidence, id)), 'Coverage needs nonempty scope and resolvable evidence');
        requireCondition(group.basis !== 'CP_SCOPE_UPPER_BOUND', 'CP scope certificates have no validated producer in v4');
        const frame = revision.frames.find(f => f.id === group.frameId); const context = contexts.get(group.contextId);
        requireCondition(frame?.status === 'CURRENT' && context && frame.contextId === group.contextId, 'Coverage frame/context is not current');
        const reference = revision.assessments.find(a => a.id === frame.referenceAssessmentId)!;
        const groupEvidence: EvidenceStore = { searches: revision.evidence.searches, observations: Object.fromEntries(Object.entries(revision.evidence.observations).filter(([id]) => group.evidenceIds.includes(id))), exact: Object.fromEntries(Object.entries(revision.evidence.exact).filter(([id]) => group.evidenceIds.includes(id))) };
        const assessGroup = createAssessmentEvaluator(groupEvidence, positions.facts);
        for (const move of group.movesUci) {
            requireCondition(positions.legal(context.fen).includes(move), 'Coverage contains illegal move');
            const result = assessGroup(frame, { id: 'coverage-check', moveUci: move, trainingSide: context.trainingSide, referenceMoveUci: reference.moveUci, originalMoveUci: revision.source.originalMoveUci }, revision.policySnapshot);
            requireCondition(result.quality === 'BELOW_STANDARD' && result.qualitySupport === 'SUPPORTED', 'Group conclusion lacks move-scoped supporting evidence');
            const current = assessCurrentCoverage!(frame, { id: 'current-coverage-check', moveUci: move, trainingSide: context.trainingSide, referenceMoveUci: reference.moveUci, originalMoveUci: revision.source.originalMoveUci }, revision.policySnapshot);
            requireCondition(current.quality === 'BELOW_STANDARD' && current.qualitySupport === 'SUPPORTED', 'Group conclusion is contradicted by current evidence');
            if (group.basis === 'EXACT_OUTCOME') requireCondition(result.source === 'RULE' || result.source === 'TABLEBASE', 'Exact group lacks exact evidence');
        }
    }
    const checkIndex = (index: AnswerIndex, contextId: string) => {
        const context = contexts.get(contextId); requireCondition(context && index.contextId === contextId, 'Answer index context mismatch');
        const frame = revision.frames.find(f => f.id === index.frameId); requireCondition(frame?.status === 'CURRENT' && frame.contextId === contextId, 'Answer index frame is not current');
        const expected = deriveAnswerIndex({ contextId, frameId: index.frameId, legalMovesUci: positions.legal(context.fen), preferredMoveUci: index.preferredMoveUci, assessments: revision.assessments, coverageGroups: revision.coverageGroups });
        equal(index, expected, 'Answer index is not the exact projection of supported conclusions');
        const preferred = revision.assessments.find(a => a.id === frame.referenceAssessmentId);
        requireCondition(preferred?.moveUci === index.preferredMoveUci, 'Preferred move differs from reference');
    };
    checkIndex(revision.rootAnswerIndex, revision.source.contextId);
    uniqueIds(revision.continuation.nodes, 'continuation node');
    const nodes = new Map(revision.continuation.nodes.map(n => [n.id, n]));
    for (const node of nodes.values()) {
        positions.history(node.fen, node.positionHistory);
        if (node.answerIndex) checkIndex(node.answerIndex, node.contextId);
        if (revision.continuation.mode === 'VERIFIED_BRANCHES' && node.role === 'USER') requireCondition(node.answerIndex, 'Playable USER node requires its own answer index');
    }
    for (const line of revision.continuation.explanationLines) {
        const context = contexts.get(line.startContextId); requireCondition(context, 'Explanation starts at missing context');
        const board = new Chess(context.fen);
        for (const move of line.movesUci) board.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] });
    }
    for (const edge of revision.continuation.edges) {
        const from = nodes.get(edge.from); const to = nodes.get(edge.to); requireCondition(from && to, 'Continuation edge references missing node');
        const board = new Chess(from.fen); board.move({ from: edge.moveUci.slice(0, 2), to: edge.moveUci.slice(2, 4), promotion: edge.moveUci[4] });
        requireCondition(board.fen() === to.fen, 'Continuation edge does not reach its target');
        equal([...from.positionHistory, from.fen], to.positionHistory, 'Continuation edge loses rule history');
        if (revision.continuation.mode === 'VERIFIED_BRANCHES' && from.role === 'OPPONENT') {
            const choices = orderedObservations(revision.evidence).filter(o => o.contextId === from.contextId && o.bundleComplete && o.rootScopeUci.length === positions.legal(from.fen).length);
            const latest = choices.at(-1);
            const prior = latest && choices.slice(0, -1).findLast(o => {
                if (o.engineFingerprint !== latest.engineFingerprint || latest.depth - o.depth < revision.policySnapshot.minimumDepthGap) return false;
                const first = o.lines[0]; const last = latest.lines[0];
                const stableMate = first?.score.kind === 'MATE' && last?.score.kind === 'MATE' && first.score.winner === last.score.winner;
                return stableMate || o.nodes >= revision.policySnapshot.minimumSupportNodes
                    && revision.evidence.searches[o.searchId].reportedNodes >= revision.policySnapshot.minimumSupportNodes
                    && latest.nodes >= revision.policySnapshot.latestSupportNodes
                    && revision.evidence.searches[latest.searchId].reportedNodes >= revision.policySnapshot.latestSupportNodes;
            });
            requireCondition(latest && prior && choices.filter(o => o.engineFingerprint === latest.engineFingerprint && (revision.evidence.searches[o.searchId].sequence > revision.evidence.searches[prior.searchId].sequence || (o.searchId === prior.searchId && o.snapshotIndex >= prior.snapshotIndex))).every(o => o.lines[0]?.moveUci === edge.moveUci && o.lines[0]?.bound === 'UNBOUNDED'), 'Opponent transition lacks stable complete root evidence');
            requireCondition(practiceRootBoundsCompatible({ evidence: revision.evidence, contextId: from.contextId, engineFingerprint: latest.engineFingerprint, moveUci: edge.moveUci, trainingSide: from.trainingSide, policy: revision.policySnapshot }, positions.facts), 'Opponent transition has contradictory current bounds');
            const opponentFrame: ComparisonFrame = { id: `opponent-reference-${from.id}`, contextId: from.contextId,
                policyId: revision.policyId, engineFingerprint: latest.engineFingerprint,
                model: latest.lines[0].wdl ? 'MATCHED_WDL' : 'CP_ONLY', referenceAssessmentId: '', status: 'CURRENT', supersededById: null };
            requireCondition(assessPracticeReferenceReadiness({ evidence: revision.evidence, frame: opponentFrame,
                trainingSide: from.trainingSide, referenceMoveUci: edge.moveUci, policy: revision.policySnapshot }, positions.facts).status === 'READY',
            'Opponent transition lacks a verified current reference');
        }
        if (from.role === 'USER') {
            requireCondition(from.answerIndex, 'Unprepared USER node is not playable');
            const found = lookupAnswer(from.answerIndex, edge.moveUci, revision.assessments, revision.coverageGroups);
            requireCondition(found.quality === 'GOOD', 'Playable USER edge lacks supported GOOD');
        }
    }
    const original = revision.assessments.find(a => a.id === revision.decision.originalAssessmentId); const reference = revision.assessments.find(a => a.id === revision.decision.referenceAssessmentId);
    const rootFrame = revision.frames.find(f => f.id === revision.rootAnswerIndex.frameId)!;
    requireCondition(original?.moveUci === revision.source.originalMoveUci && original.frameId === rootFrame.id && reference?.id === rootFrame.referenceAssessmentId, 'Decision does not reference root original/reference');
    requireCondition(revision.decision.evidenceIds.every(id => evidenceHas(revision.evidence, id)), 'Decision has unresolved evidence');
    const expectedDecision = deriveDecisionAssessment({ original, reference, frame: rootFrame, evidence: revision.evidence, minimumConfirmationNodes: revision.executionProfileSnapshot.minimumConfirmationNodes, policy: revision.policySnapshot });
    equal(revision.decision, expectedDecision, 'Decision is not implied by its supported assessments');
    if (revision.decision.selection === 'INCLUDED') requireCondition(positions.legal(revision.source.fen).length > 1, 'Forced single move is not a Practice prompt');
}
/** Strict shape + chess/evidence/policy validation. Publication supplies the profile budget. */
export function parsePracticeMomentRevision(input: unknown, options: { minimumConfirmationNodes?: number } = {}): PracticeMomentRevision {
    const revision = revisionSchema.read(input, 'revision'); validateRevisionSemantics(revision, options); return revision;
}
export function validatePracticeMomentRevision(input: unknown, options: { minimumConfirmationNodes?: number } = {}): ValidationResult<PracticeMomentRevision> {
    try { return { success: true, value: parsePracticeMomentRevision(input, options) }; } catch (error) { return { success: false, issues: [error instanceof Error ? error.message : String(error)] }; }
}
/** Validate a personal evaluation without changing the immutable canonical revision. */
export function validatePracticeEvaluationPatch(revision: PracticeMomentRevision, input: unknown): ValidationResult<PracticeEvaluationPatch> {
    try {
        const patch = patchSchema.read(input, 'patch');
        for (const [id, exact] of Object.entries(patch.evidence.exact)) requireCondition(exact.source === 'RULE' || (revision.evidence.exact[id] && canonicalJson(revision.evidence.exact[id]) === canonicalJson(exact)), 'Client patch cannot introduce a new tablebase provider certificate');
        const playableContext = patch.frame.contextId === revision.source.contextId || revision.continuation.mode === 'VERIFIED_BRANCHES'
            && revision.continuation.nodes.some(node => node.contextId === patch.frame.contextId && node.role === 'USER' && node.answerIndex !== null);
        requireCondition(patch.frame.status === 'CURRENT' && playableContext && patch.frame.policyId === revision.policyId, 'Patch frame must target this revision root or a prepared USER context and policy');
        requireCondition(!revision.frames.some(f => f.id === patch.frame.id && canonicalJson(f) !== canonicalJson(patch.frame)), 'Patch cannot rewrite an existing frame');
        const merge = <T>(base: Record<string, T>, additions: Record<string, T>) => {
            for (const [id, item] of Object.entries(additions)) if (Object.hasOwn(base, id)) equal(base[id], item, 'Patch cannot overwrite existing evidence');
            return { ...base, ...additions };
        };
        const evidence: EvidenceStore = { searches: merge(revision.evidence.searches, patch.evidence.searches), observations: merge(revision.evidence.observations, patch.evidence.observations), exact: merge(revision.evidence.exact, patch.evidence.exact) };
        const positions = new RevisionPositionValidation();
        const contexts = revisionContexts(revision, positions); validateEvidence(evidence, contexts, positions);
        requireCondition(patch.assessments.length > 0 && patch.assessments.every(a => a.frameId === patch.frame.id && a.contextId === patch.frame.contextId), 'Patch assessments must belong to the patch frame');
        for (const item of patch.assessments) requireCondition(!revision.assessments.some(a => a.id === item.id && canonicalJson(a) !== canonicalJson(item)), 'Patch cannot overwrite a canonical assessment');
        validateAssessments({ ...revision, frames: [patch.frame], assessments: patch.assessments, evidence }, contexts, positions);
        return { success: true, value: patch };
    } catch (error) { return { success: false, issues: [error instanceof Error ? error.message : String(error)] }; }
}

const isoTimestampSchema = scalar<string>({ type: 'string', format: 'date-time' }, value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
const attemptMoveSchema = object<AttemptMove>({ clientAttemptId: textSchema, stepIndex: countSchema, momentRevisionId: textSchema, contextId: textSchema, moveUci: uciSchema, playedAt: isoTimestampSchema, initialAssessmentId: nullable(textSchema), initialCoverageGroupId: nullable(textSchema), resolution: enumeration('PENDING', 'RESOLVED', 'UNAVAILABLE') });
const attemptAssessmentSchema = object<AttemptAssessment>({ eventId: textSchema, clientAttemptId: textSchema, stepIndex: countSchema, sequence: positiveCount, supersedesEventId: nullable(textSchema), frameId: textSchema, assessment: assessmentSchema, evidence: evidenceSchema });
const receiptSchema = object<AnalysisReceipt>({ sourcePgnHash: textSchema, mode: enumeration('FULL_GAME', 'FIRST_PUZZLE'), executionProfileId: textSchema, decisions: array(object<AnalysisReceipt['decisions'][number]>({ decisionPly: countSchema, scan: enumeration('CANDIDATE', 'NOT_SELECTED', 'FAILED'), confirmation: nullable(enumeration('CONFIRMED_MISTAKE', 'NOT_A_MISTAKE', 'UNRESOLVED')), selection: enumeration('INCLUDED', 'OMITTED'), reason: textSchema })), stopReason: textSchema, failureReasons: array(textSchema), completeness: enumeration('COMPLETE', 'PARTIAL', 'FAILED'), cost: object<AnalysisReceipt['cost']>({ physicalSearches: countSchema, requestedNodes: countSchema, reportedNodes: countSchema, reportedTimeMs: nonnegativeNumber }) });
export const ATTEMPT_MOVE_JSON_SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...attemptMoveSchema.json };
export const ATTEMPT_ASSESSMENT_JSON_SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...attemptAssessmentSchema.json };
export const ANALYSIS_RECEIPT_JSON_SCHEMA = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...receiptSchema.json };
export function parseAttemptMove(input: unknown): AttemptMove {
    const move = attemptMoveSchema.read(input, 'attemptMove');
    requireCondition(!(move.initialAssessmentId && move.initialCoverageGroupId), 'Initial support must identify an assessment or a group, never both');
    if (move.resolution === 'RESOLVED') requireCondition(move.initialAssessmentId || move.initialCoverageGroupId, 'Initially resolved move requires a supporting assessment or coverage group');
    else requireCondition(move.initialAssessmentId === null && move.initialCoverageGroupId === null, 'Unresolved move cannot claim initial supported evidence');
    return move;
}
/** Shape validation only; use validatePracticeEvaluationPatch to verify the declared assessment. */
export function parseAttemptAssessment(input: unknown): AttemptAssessment {
    const event = attemptAssessmentSchema.read(input, 'attemptAssessment');
    requireCondition(event.frameId === event.assessment.frameId, 'Attempt assessment frame mismatch');
    requireCondition(event.supersedesEventId !== event.eventId, 'Assessment event cannot supersede itself');
    return event;
}
export function parseAnalysisReceipt(input: unknown): AnalysisReceipt {
    const receipt = receiptSchema.read(input, 'receipt');
    requireCondition(receipt.mode !== 'FIRST_PUZZLE' || receipt.completeness !== 'COMPLETE', 'FIRST_PUZZLE cannot claim full-game completion');
    requireCondition(new Set(receipt.decisions.map(d => d.decisionPly)).size === receipt.decisions.length, 'Receipt duplicates a source decision');
    return receipt;
}
