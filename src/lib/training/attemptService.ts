import { createHash } from 'node:crypto';
import { acquireTransactionAdvisoryLock } from '@/lib/db/advisoryLock';
import { Prisma, type PrismaClient, type TrainingAttempt, type TrainingAttemptStep } from '@prisma/client';
import type { TrainingApiErrorCode } from './api';
import type { EnrichTrainingAttemptRequest, EnrichTrainingAttemptResponse, RecordTrainingAttemptRequest, RecordTrainingAttemptResponse, TrainingAttemptWriteRequest } from './attemptApi';
import { canonicalJson, parsePracticeMomentRevision, validatePracticeEvaluationPatch, type MoveAssessment, type PracticeMomentRevision, type PracticeEvaluationPatch } from './practiceContract';
import { parseEnrichTrainingAttemptRequest, parseRecordTrainingAttemptRequest } from './apiValidation';

type TrainingWriteDb = Pick<PrismaClient, '$transaction'>;
export type TrainingAttemptDependencies = { db: TrainingWriteDb; now?: () => Date };
export class TrainingAttemptError extends Error {
    constructor(message: string, public readonly code: TrainingApiErrorCode, public readonly status: number) { super(message); }
}
function invalid(message: string): never { throw new TrainingAttemptError(message, 'INVALID_REQUEST', 400); }
function conflict(message: string): never { throw new TrainingAttemptError(message, 'IDEMPOTENCY_CONFLICT', 409); }
function missing(message: string): never { throw new TrainingAttemptError(message, 'NOT_FOUND', 425); }
function digest(value: unknown) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
export function trainingAttemptPayloadHash(args: { userId: string; momentId: string; request: TrainingAttemptWriteRequest }): string { return digest({ userId: args.userId, momentId: args.momentId, request: args.request }); }
const neutral = { quality: 'UNKNOWN' as const, tier: null, originalRelation: 'UNKNOWN' as const };
function projection(assessment: MoveAssessment | null) {
    if (!assessment) return neutral;
    if (assessment.qualitySupport !== 'SUPPORTED' || assessment.quality === 'UNKNOWN') invalid('Resolution requires supported move quality');
    return { quality: assessment.quality, tier: assessment.tierSupport === 'SUPPORTED' ? assessment.tier : null, originalRelation: assessment.originalRelation };
}
function response(attempt: TrainingAttempt, idempotentReplay = false): RecordTrainingAttemptResponse {
    return { attemptId: attempt.id, status: attempt.status, quality: attempt.quality, tier: attempt.tier, originalRelation: attempt.originalRelation, idempotentReplay };
}

async function ownedStream(tx: Prisma.TransactionClient, args: { userId: string; momentId: string; request: { momentRevisionId: string; clientAttemptId: string } }) {
    const attemptKey = `practice-attempt:${args.userId}:${args.request.clientAttemptId}`;
    await acquireTransactionAdvisoryLock(tx, attemptKey);
    const key = `practice-review:${args.userId}:${args.momentId}`;
    await acquireTransactionAdvisoryLock(tx, key);
    const moment = await tx.trainingMoment.findFirst({ where: { id: args.momentId, userId: args.userId }, include: { game: { select: { provider: true, timeClass: true } } } });
    if (!moment) throw new TrainingAttemptError('Training moment not found', 'NOT_FOUND', 404);
    const revision = await tx.solutionRevision.findFirst({ where: { id: args.request.momentRevisionId, momentId: moment.id } });
    if (!revision) throw new TrainingAttemptError('Training revision not found', 'STALE_REVISION', 409);
    let manifest: PracticeMomentRevision;
    try { manifest = parsePracticeMomentRevision(revision.manifest); } catch { invalid('Invalid stored Practice revision'); }
    if (manifest.momentId !== moment.id || manifest.revisionId !== revision.id || manifest.semanticHash !== revision.solutionHash ||
        manifest.source.gameId !== moment.gameId || manifest.source.contextId !== manifest.rootAnswerIndex.contextId ||
        !revision.trainable || manifest.decision.selection !== 'INCLUDED') invalid('Revision is not a trainable owned moment');
    return { moment, revision, manifest };
}

/** USER steps follow an actual verified path, including its intervening opponent edges. */
function assertStepContext(manifest: PracticeMomentRevision, previous: TrainingAttemptStep[], contextId: string, stepIndex: number): string {
    if (stepIndex !== previous.length) missing('Earlier played move must be recorded first');
    if (stepIndex === 0) {
        if (contextId !== manifest.source.contextId) invalid('First move must use the source decision');
        return manifest.source.fen;
    }
    if (manifest.continuation.mode !== 'VERIFIED_BRANCHES') invalid('This revision has one user decision');
    const last = previous[previous.length - 1];
    if (last.resolution !== 'RESOLVED' || last.quality !== 'GOOD') invalid('Continuation requires a resolved good preceding decision');
    const { nodes, edges } = manifest.continuation;
    const from = nodes.find(n => n.contextId === last.contextId && n.role === 'USER');
    const target = nodes.find(n => n.contextId === contextId && n.role === 'USER');
    if (!from || !target) invalid('Unknown user continuation context');
    const pending = edges.filter(e => e.from === from.id && e.moveUci === last.moveUci).map(e => e.to);
    const visited = new Set<string>();
    while (pending.length) {
        const id = pending.pop()!;
        if (id === target.id) return target.fen;
        if (visited.has(id)) continue;
        visited.add(id);
        if (nodes.find(n => n.id === id)?.role === 'OPPONENT') pending.push(...edges.filter(e => e.from === id).map(e => e.to));
    }
    invalid('Played move does not reach this user decision');
}

function indexedAssessment(manifest: PracticeMomentRevision, contextId: string, moveUci: string, assessmentId: string | null, coverageGroupId: string | null) {
    const index = contextId === manifest.source.contextId ? manifest.rootAnswerIndex : manifest.continuation.nodes.find(n => n.contextId === contextId && n.role === 'USER')?.answerIndex;
    if (!index?.legalMovesUci.includes(moveUci)) throw new TrainingAttemptError('Move is not legal in the recorded context', 'ILLEGAL_MOVE', 400);
    if (coverageGroupId) {
        const group = manifest.coverageGroups.find(g => g.id === coverageGroupId && g.contextId === contextId && g.frameId === index.frameId && g.movesUci.includes(moveUci));
        if (!group || !index.coverageGroupIds.includes(group.id)) invalid('Coverage group is not in the served answer index');
        return { quality: 'BELOW_STANDARD' as const, tier: null, originalRelation: contextId === manifest.source.contextId && moveUci === manifest.source.originalMoveUci ? 'SAME_MOVE' as const : 'UNKNOWN' as const };
    }
    if (!assessmentId) return neutral;
    const assessment = manifest.assessments.find(a => a.id === assessmentId && a.contextId === contextId && a.moveUci === moveUci && a.frameId === index.frameId);
    if (!assessment || !index.assessmentIds.includes(assessment.id)) invalid('Initial assessment is not in the served answer index');
    projection(assessment);
    return projection(assessment);
}

/** Absolute replay makes corrections and late offline delivery count each attempt once. */
async function rebuildReviewState(tx: Prisma.TransactionClient, attempt: TrainingAttempt) {
    const stream = { userId: attempt.userId, trainingMomentId: attempt.trainingMomentId, contextSolutionHash: attempt.contextSolutionHash, contextConfigHash: attempt.contextConfigHash };
    const attempts = await tx.trainingAttempt.findMany({ where: { ...stream, status: 'RESOLVED', quality: { in: ['GOOD', 'BELOW_STANDARD'] } }, orderBy: [{ attemptedAt: 'asc' }, { id: 'asc' }] });
    const stateKey = { userId: attempt.userId, trainingMomentId: attempt.trainingMomentId, solutionHash: attempt.contextSolutionHash, configHash: attempt.contextConfigHash };
    if (!attempts.length) { await tx.practiceReviewState.deleteMany({ where: stateKey }); return; }
    let successes = 0, lapses = 0, interval = 0;
    const events = attempts.map(item => {
        const before = interval;
        if (item.quality === 'GOOD') { successes++; interval = interval === 0 ? 1 : interval === 1 ? 3 : Math.min(60, interval * 2); }
        else { lapses++; interval = 1; }
        const nextDueAt = new Date(item.attemptedAt.getTime() + interval * 86400000);
        return { item, before, interval, nextDueAt };
    });
    const last = events[events.length - 1];
    const data = { nextDueAt: last.nextDueAt, intervalDays: interval, successes, lapses, lastReviewedAt: last.item.attemptedAt, algorithmVersion: 'backranq-review-v4' };
    const state = await tx.practiceReviewState.upsert({ where: { userId_trainingMomentId_solutionHash_configHash: stateKey }, create: { ...stateKey, ...data }, update: data });
    await tx.practiceReviewEvent.deleteMany({ where: { stateId: state.id } });
    await tx.practiceReviewEvent.createMany({ data: events.map(({ item, before, interval, nextDueAt }) => ({ stateId: state.id, attemptId: item.id, userId: item.userId, eventKey: `attempt:${item.id}`, outcome: item.quality === 'GOOD' ? 'SUCCESS' : 'LAPSE', quality: item.quality, tier: item.tier, occurredAt: item.attemptedAt, intervalBeforeDays: before, intervalAfterDays: interval, nextDueAt, algorithmVersion: 'backranq-review-v4' })) });
}

function awaitsContinuation(manifest: PracticeMomentRevision, steps: TrainingAttemptStep[]): boolean {
    if (manifest.continuation.mode !== 'VERIFIED_BRANCHES' || !steps.length || steps.some(s => s.quality !== 'GOOD')) return false;
    const last = steps[steps.length - 1];
    const { nodes, edges } = manifest.continuation;
    const node = nodes.find(n => n.contextId === last.contextId && n.role === 'USER');
    if (!node) return false;
    const pending = edges.filter(e => e.from === node.id && e.moveUci === last.moveUci).map(e => e.to);
    const visited = new Set<string>();
    while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const target = nodes.find(n => n.id === id);
        if (target?.role === 'USER') return true;
        if (target?.role === 'OPPONENT') pending.push(...edges.filter(e => e.from === id).map(e => e.to));
    }
    return false;
}

async function updateAggregate(tx: Prisma.TransactionClient, attempt: TrainingAttempt, eventKey: string, at: Date, manifest: PracticeMomentRevision) {
    const steps = await tx.trainingAttemptStep.findMany({ where: { attemptId: attempt.id }, orderBy: { stepIndex: 'asc' } });
    const status = attempt.revealedAt ? 'REVEALED' as const : steps.some(s => s.resolution === 'PENDING') || !steps.length || awaitsContinuation(manifest, steps) ? 'PENDING' as const : steps.some(s => s.resolution === 'UNAVAILABLE') ? 'UNAVAILABLE' as const : 'RESOLVED' as const;
    const quality = status === 'RESOLVED' ? steps.some(s => s.quality === 'BELOW_STANDARD') ? 'BELOW_STANDARD' as const : 'GOOD' as const : 'UNKNOWN' as const;
    const tierOrder = ['SUBPAR', 'GOOD', 'STRONG', 'BEST'] as const;
    const tier = status === 'RESOLVED' && steps.every(s => s.tier !== null) ? [...steps].sort((a, b) => tierOrder.indexOf(a.tier!) - tierOrder.indexOf(b.tier!))[0].tier : null;
    const updated = await tx.trainingAttempt.update({ where: { id: attempt.id }, data: { status, quality, tier, originalRelation: steps[0]?.originalRelation ?? 'UNKNOWN', completedAt: status === 'PENDING' ? null : attempt.revealedAt ?? steps.at(-1)?.playedAt ?? attempt.attemptedAt } });
    await tx.trainingAttemptStatusEvent.create({ data: { attemptId: attempt.id, userId: attempt.userId, eventKey, status, quality, tier, reason: eventKey.startsWith('enrich:') ? 'CORRECTED' : status === 'RESOLVED' ? 'RESOLVED' : status === 'REVEALED' ? 'REVEALED' : status === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'SUBMITTED', occurredAt: at } });
    await rebuildReviewState(tx, updated);
    // Late offline events never move the position's last-practiced timestamp backwards.
    await tx.trainingMoment.updateMany({ where: { id: attempt.trainingMomentId, userId: attempt.userId, OR: [{ lastTrainedAt: null }, { lastTrainedAt: { lt: attempt.attemptedAt } }] }, data: { lastTrainedAt: attempt.attemptedAt } });
    return updated;
}

export async function recordTrainingAttempt(args: { userId: string; momentId: string; request: RecordTrainingAttemptRequest; dependencies: TrainingAttemptDependencies }): Promise<RecordTrainingAttemptResponse> {
    const request = parseRecordTrainingAttemptRequest(args.request, args.dependencies.now?.() ?? new Date());
    if (!request) invalid('Invalid played event');
    const hash = trainingAttemptPayloadHash({ ...args, request });
    return args.dependencies.db.$transaction(async tx => {
        const { moment, revision, manifest } = await ownedStream(tx, { ...args, request });
        let attempt = await tx.trainingAttempt.findUnique({ where: { userId_clientAttemptId: { userId: args.userId, clientAttemptId: request.clientAttemptId } } });
        if (attempt && (attempt.trainingMomentId !== moment.id || attempt.solutionRevisionId !== revision.id)) conflict('Attempt identity belongs to another moment or revision');
        if (attempt && request.kind === 'REVEAL' && attempt.revealPayloadHash) {
            if (attempt.revealPayloadHash !== hash) conflict('Reveal payload conflict');
            return response(attempt, true);
        }
        const previous = attempt ? await tx.trainingAttemptStep.findMany({ where: { attemptId: attempt.id }, orderBy: { stepIndex: 'asc' } }) : [];
        if (request.kind === 'RECORD') {
            const existing = previous.find(s => s.stepIndex === request.stepIndex);
            if (existing) { if (existing.payloadHash !== hash) conflict('Played move payload conflict'); return response(attempt!, true); }
            if (attempt?.revealedAt) invalid('Cannot play another move after reveal');
        }
        const fen = request.kind === 'RECORD' ? assertStepContext(manifest, previous, request.contextId, request.stepIndex) : null;
        const assessment = request.kind === 'RECORD' ? indexedAssessment(manifest, request.contextId, request.moveUci, request.initialAssessmentId, request.initialCoverageGroupId) : neutral;
        const at = new Date(request.kind === 'RECORD' ? request.playedAt : request.revealedAt);
        if (previous.length && at < previous[previous.length - 1].playedAt) invalid('Played events must have chronological timestamps');
        const originalMetrics = manifest.assessments.find(item => item.id === manifest.decision.originalAssessmentId)?.metrics;
        if (!attempt) attempt = await tx.trainingAttempt.create({ data: { userId: args.userId, trainingMomentId: moment.id, solutionRevisionId: revision.id, clientAttemptId: request.clientAttemptId, clientPayloadHash: hash, attemptedAt: at, userMoveUci: request.kind === 'RECORD' ? request.moveUci : null, timeSpentMs: request.kind === 'RECORD' ? request.timeSpentMs : null, contextPhase: moment.phase, contextCpLoss: originalMetrics?.lossCp == null ? null : Math.max(0, originalMetrics.lossCp), contextWinChanceLoss: originalMetrics?.lossExpectedScore == null ? null : Math.max(0, originalMetrics.lossExpectedScore), contextSourceKinds: moment.sourceKinds, contextLessonKinds: moment.lessonKinds, contextThemes: moment.themes, contextProvider: moment.game.provider, contextTimeClass: moment.game.timeClass, contextConfigHash: revision.configHash, contextSolutionHash: revision.solutionHash } });
        if (request.kind === 'REVEAL') attempt = await tx.trainingAttempt.update({ where: { id: attempt.id }, data: { revealedAt: at, revealPayloadHash: hash } });
        else await tx.trainingAttemptStep.create({ data: { attemptId: attempt.id, stepIndex: request.stepIndex, contextId: request.contextId, fenBefore: fen!, moveUci: request.moveUci, playedAt: at, timeSpentMs: request.timeSpentMs, initialAssessmentId: request.initialAssessmentId, initialCoverageGroupId: request.initialCoverageGroupId, initialResolution: request.resolution, payloadHash: hash, resolution: request.resolution, ...assessment } });
        return response(await updateAggregate(tx, attempt, request.kind === 'REVEAL' ? 'reveal' : `record:${request.stepIndex}`, at, manifest));
    }).catch(rethrowWriteConflict);
}

export async function enrichTrainingAttempt(args: { userId: string; momentId: string; request: EnrichTrainingAttemptRequest; dependencies: TrainingAttemptDependencies }): Promise<EnrichTrainingAttemptResponse> {
    const request = parseEnrichTrainingAttemptRequest(args.request, args.dependencies.now?.() ?? new Date());
    if (!request) invalid('Invalid assessment event');
    const hash = trainingAttemptPayloadHash({ ...args, request });
    return args.dependencies.db.$transaction(async tx => {
        const { manifest } = await ownedStream(tx, { ...args, request });
        const attempt = await tx.trainingAttempt.findUnique({ where: { userId_clientAttemptId: { userId: args.userId, clientAttemptId: request.clientAttemptId } } });
        if (!attempt) missing('Record the played move before its assessment');
        if (attempt.trainingMomentId !== args.momentId || attempt.solutionRevisionId !== request.momentRevisionId) conflict('Assessment attempt identity mismatch');
        const step = await tx.trainingAttemptStep.findUnique({ where: { attemptId_stepIndex: { attemptId: attempt.id, stepIndex: request.stepIndex } } });
        if (!step) missing('Record the played move before its assessment');
        const existing = await tx.trainingAttemptAssessmentRevision.findUnique({ where: { eventId: request.eventId } });
        if (existing) { if (existing.payloadHash !== hash) conflict('Assessment event payload conflict'); return { ...response(attempt, true), applied: false }; }
        const events = await tx.trainingAttemptAssessmentRevision.findMany({ where: { OR: [{ attemptId: attempt.id, stepIndex: request.stepIndex }, ...(request.supersedesEventId ? [{ eventId: request.supersedesEventId }] : []), { supersedesEventId: request.eventId }] } });
        if (events.some(e => e.attemptId === attempt.id && e.stepIndex === step.stepIndex && e.sequence === request.sequence)) conflict('Assessment sequence payload conflict');
        const adjacent = events.filter(e => e.attemptId === attempt.id && e.stepIndex === step.stepIndex);
        if (adjacent.some(e => e.sequence === request.sequence - 1 && e.eventId !== request.supersedesEventId) ||
            adjacent.some(e => e.sequence === request.sequence + 1 && e.supersedesEventId !== request.eventId)) conflict('Assessment sequence chain conflict');
        const predecessor = events.find(e => e.eventId === request.supersedesEventId);
        if (predecessor && (predecessor.attemptId !== attempt.id || predecessor.stepIndex !== step.stepIndex || predecessor.sequence !== request.sequence - 1)) conflict('Assessment predecessor is not the preceding event');
        if (events.some(e => e.supersedesEventId === request.eventId && (e.attemptId !== attempt.id || e.stepIndex !== step.stepIndex || e.sequence !== request.sequence + 1))) conflict('Assessment successor conflict');
        if (new Date(request.evaluatedAt) < step.playedAt) invalid('Assessment predates the played move');
        let assessment: MoveAssessment | null = null;
        if (request.evaluation) {
            for (const event of events) {
                if (event.attemptId !== attempt.id || event.stepIndex !== step.stepIndex || event.resolution !== 'RESOLVED' || !event.evaluation) continue;
                assertImmutableEvaluation(event.evaluation as unknown as PracticeEvaluationPatch, request.evaluation);
            }
            const checked = validatePracticeEvaluationPatch(manifest, request.evaluation);
            if (!checked.success) invalid(`Invalid assessment evidence: ${checked.issues.join('; ')}`);
            assessment = checked.value.assessments.find(a => a.id === request.assessmentId) ?? null;
            if (!assessment || assessment.contextId !== step.contextId || assessment.moveUci !== step.moveUci) invalid('Assessment is not for the recorded move');
        }
        const grading = projection(assessment);
        await tx.trainingAttemptAssessmentRevision.create({ data: { eventId: request.eventId, attemptId: attempt.id, stepIndex: step.stepIndex, sequence: request.sequence, supersedesEventId: request.supersedesEventId, payloadHash: hash, resolution: request.resolution, assessmentId: request.assessmentId, evaluation: request.evaluation ? request.evaluation as unknown as Prisma.InputJsonValue : Prisma.DbNull, ...grading, evaluatedAt: new Date(request.evaluatedAt) } });
        if (request.sequence <= step.latestSequence) return { ...response(attempt), applied: false };
        await tx.trainingAttemptStep.update({ where: { id: step.id }, data: { resolution: request.resolution, ...grading, latestSequence: request.sequence, latestEventId: request.eventId } });
        const updated = await updateAggregate(tx, attempt, `enrich:${request.eventId}`, new Date(request.evaluatedAt), manifest);
        return { ...response(updated), applied: true };
    }).catch(rethrowWriteConflict);
}

function rethrowWriteConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') conflict('Played event or assessment identity conflict');
    throw error;
}

function assertImmutableEvaluation(previous: PracticeEvaluationPatch, next: PracticeEvaluationPatch) {
    if (previous.frame.id === next.frame.id && canonicalJson(previous.frame) !== canonicalJson(next.frame)) invalid('Comparison frame identity cannot change');
    for (const assessment of next.assessments) {
        const old = previous.assessments.find(a => a.id === assessment.id);
        if (old && canonicalJson(old) !== canonicalJson(assessment)) invalid('Assessment identity cannot change');
    }
    for (const kind of ['searches', 'observations', 'exact'] as const) {
        for (const [id, item] of Object.entries(next.evidence[kind])) {
            const old = previous.evidence[kind][id];
            if (old && canonicalJson(old) !== canonicalJson(item)) invalid('Physical evidence identity cannot change');
        }
    }
}
