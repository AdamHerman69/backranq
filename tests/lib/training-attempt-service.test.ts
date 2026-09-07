import { practiceV4Fixture, practiceV4PatchFixture } from '../helpers/practice-v4';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordTrainingAttempt, enrichTrainingAttempt, type TrainingAttemptDependencies } from '@/lib/training/attemptService';
import type { EnrichTrainingAttemptRequest, RecordPlayedMoveRequest } from '@/lib/training/attemptApi';
import type { PracticeMomentRevision, MoveAssessment } from '@/lib/training/practiceContract';

// Evidence correctness is independently tested by the canonical contract suite.
// Here the persistence boundary receives the validated value and is exercised with a transactional store.
vi.mock('@/lib/training/practiceContract', async importOriginal => {
    const original = await importOriginal<typeof import('@/lib/training/practiceContract')>();
    return { ...original, parsePracticeMomentRevision: (value: unknown) => (value as { contractVersion?: number }).contractVersion === 4 ? original.parsePracticeMomentRevision(value) : value,
        validatePracticeEvaluationPatch: (revision: PracticeMomentRevision, patch: Parameters<typeof original.validatePracticeEvaluationPatch>[1]) => revision.contractVersion === 4 ? original.validatePracticeEvaluationPatch(revision, patch) : ({ success: true, value: patch }) };
});
const userId = '11111111-1111-4111-8111-111111111111';
const momentId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const clientAttemptId = '44444444-4444-4444-8444-444444444444';
const eventId = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`;
const at = '2026-09-01T10:00:00.000Z';
const good = { id: 'good', contextId: 'root', moveUci: 'e2e4', frameId: 'frame', quality: 'GOOD', qualitySupport: 'SUPPORTED', tier: null, tierSupport: 'NONE', originalRelation: 'BETTER', pending: ['TIER'] } as MoveAssessment;
const bad = { ...good, id: 'bad', moveUci: 'a2a3', quality: 'BELOW_STANDARD', originalRelation: 'SAME_MOVE' } as MoveAssessment;
let manifest: PracticeMomentRevision;
function record(overrides: Partial<RecordPlayedMoveRequest> = {}): RecordPlayedMoveRequest {
    return { kind: 'RECORD', clientAttemptId, momentRevisionId: revisionId, stepIndex: 0, contextId: 'root', moveUci: 'e2e4', playedAt: at, timeSpentMs: 100, initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING', ...overrides };
}
function enrich(sequence = 1, assessment: MoveAssessment | null = good): EnrichTrainingAttemptRequest {
    return { kind: 'ENRICH', clientAttemptId, momentRevisionId: revisionId, stepIndex: 0, eventId: eventId(sequence), sequence, supersedesEventId: sequence === 1 ? null : eventId(sequence - 1), evaluatedAt: '2026-09-01T10:00:01.000Z', resolution: assessment ? 'RESOLVED' : 'UNAVAILABLE', assessmentId: assessment ? `${assessment.id}-${sequence}` : null, evaluation: assessment ? { frame: { id: `frame-${sequence}` } as never, assessments: [{ ...assessment, id: `${assessment.id}-${sequence}` }], evidence: { searches: {}, observations: {}, exact: {} } } : null };
}
type Row = Record<string, unknown>;
function matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === 'OR') return (value as Row[]).some(v => matches(row, v));
        if (key.includes('_')) return matches(row, value as Row);
        if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
            if ('in' in value) return (value.in as unknown[]).includes(row[key]);
            if ('lt' in value) return (row[key] as Date) < (value.lt as Date);
        }
        return row[key] === value;
    });
}
function harness() {
    const tables: Record<string, Row[]> = {
        trainingMoment: [{ id: momentId, userId, gameId: 'game', phase: null, cpLoss: 200, winChanceLoss: null, sourceKinds: [], lessonKinds: [], themes: [], game: { provider: 'LICHESS', timeClass: 'RAPID' }, lastTrainedAt: null }],
        solutionRevision: [{ id: revisionId, momentId, manifest, trainable: true, solutionHash: manifest.semanticHash, configHash: 'policy' }],
        trainingAttempt: [], trainingAttemptStep: [], trainingAttemptAssessmentRevision: [], trainingAttemptStatusEvent: [], practiceReviewState: [], practiceReviewEvent: [],
    };
    const tx: Record<string, unknown> = { $queryRaw: vi.fn().mockResolvedValue([{ acquired: true }]) };
    for (const name of Object.keys(tables)) {
        const find = (where: Row) => tables[name].find(r => matches(r, where));
        const create = (data: Row) => { const row = { id: `${name}-${tables[name].length}`, status: 'PENDING', quality: 'UNKNOWN', tier: null, originalRelation: 'UNKNOWN', revealedAt: null, latestSequence: 0, latestEventId: null, ...data }; tables[name].push(row); return row; };
        tx[name] = {
            findFirst: async ({ where }: { where: Row }) => find(where) ?? null,
            findUnique: async ({ where }: { where: Row }) => find(where) ?? null,
            findMany: async ({ where }: { where: Row }) => tables[name].filter(r => matches(r, where)).sort((a, b) => Number(a.stepIndex ?? a.attemptedAt ?? 0) - Number(b.stepIndex ?? b.attemptedAt ?? 0)),
            create: async ({ data }: { data: Row }) => create(data),
            createMany: async ({ data }: { data: Row[] }) => { data.forEach(create); return { count: data.length }; },
            update: async ({ where, data }: { where: Row; data: Row }) => Object.assign(find(where)!, data),
            updateMany: async ({ where, data }: { where: Row; data: Row }) => { tables[name].filter(r => matches(r, where)).forEach(r => Object.assign(r, data)); return {}; },
            deleteMany: async ({ where }: { where: Row }) => { tables[name] = tables[name].filter(r => !matches(r, where)); return {}; },
            upsert: async ({ where, create: input, update }: { where: Row; create: Row; update: Row }) => find(where) ? Object.assign(find(where)!, update) : create(input),
        };
    }
    const dependencies = { now: () => new Date('2026-09-06T12:00:00Z'), db: { $transaction: async (fn: (t: unknown) => unknown) => { const saved = structuredClone(tables); try { return await fn(tx); } catch (error) { Object.assign(tables, saved); throw error; } } } } as unknown as TrainingAttemptDependencies;
    return { tables, write: (request = record()) => recordTrainingAttempt({ userId, momentId, request, dependencies }), refine: (request = enrich()) => enrichTrainingAttempt({ userId, momentId, request, dependencies }), dependencies };
}
beforeEach(() => {
    manifest = { momentId, revisionId, semanticHash: 'semantic', source: { gameId: 'game', contextId: 'root', fen: 'root-fen' }, rootAnswerIndex: { contextId: 'root', frameId: 'frame', legalMovesUci: ['e2e4', 'a2a3'], assessmentIds: ['good', 'bad'] }, decision: { selection: 'INCLUDED' }, assessments: [good, bad], continuation: { mode: 'SINGLE_DECISION', nodes: [], edges: [] } } as unknown as PracticeMomentRevision;
});
describe('Practice v4 attempt events', () => {
    it('persists an unresolved played move once without a mastery penalty', async () => {
        const h = harness();
        expect(await h.write()).toMatchObject({ status: 'PENDING', quality: 'UNKNOWN' });
        expect(await h.write()).toMatchObject({ idempotentReplay: true });
        expect(h.tables.trainingAttempt).toHaveLength(1);
        expect(h.tables.trainingAttemptStep).toHaveLength(1);
        expect(h.tables.practiceReviewState).toHaveLength(0);
    });
    it('resolves quality without requiring a tier and counts one success', async () => {
        const h = harness(); await h.write();
        expect(await h.refine()).toMatchObject({ status: 'RESOLVED', quality: 'GOOD', tier: null, applied: true });
        expect(await h.refine()).toMatchObject({ idempotentReplay: true, applied: false });
        expect(h.tables.practiceReviewState[0]).toMatchObject({ successes: 1, lapses: 0 });
        expect(h.tables.practiceReviewEvent).toHaveLength(1);
    });
    it('rebuilds counters after a supported correction instead of adding another attempt', async () => {
        const h = harness(); await h.write(); await h.refine();
        await h.refine(enrich(2, { ...bad, moveUci: 'e2e4' }));
        expect(h.tables.practiceReviewState[0]).toMatchObject({ successes: 0, lapses: 1, intervalDays: 1 });
        expect(h.tables.trainingAttempt).toHaveLength(1);
        expect(h.tables.trainingAttemptAssessmentRevision).toHaveLength(2);
        expect(h.tables.practiceReviewEvent).toHaveLength(1);
    });
    it('keeps the play date stable when a later evaluation changes its projection', async () => {
        const h = harness(); await h.write();
        await h.refine({ ...enrich(), evaluatedAt: '2026-09-03T10:00:00.000Z' });
        await h.refine({ ...enrich(2, { ...bad, moveUci: 'e2e4' }), evaluatedAt: '2026-09-05T10:00:00.000Z' });
        expect(h.tables.trainingAttempt[0]).toMatchObject({ attemptedAt: new Date(at), completedAt: new Date(at) });
        expect(h.tables.trainingAttemptAssessmentRevision[1]).toMatchObject({ evaluatedAt: new Date('2026-09-05T10:00:00.000Z') });
    });
    it('accepts older late audit evidence without replacing the latest projection', async () => {
        const h = harness(); await h.write(); await h.refine(enrich(2, { ...bad, moveUci: 'e2e4' }));
        expect(await h.refine(enrich(1))).toMatchObject({ quality: 'BELOW_STANDARD', applied: false });
        expect(h.tables.trainingAttemptStep[0]).toMatchObject({ latestSequence: 2 });
        expect(h.tables.trainingAttemptAssessmentRevision).toHaveLength(2);
    });
    it('makes enrichment before RECORD retryable, then accepts its retry', async () => {
        const h = harness(); await expect(h.refine()).rejects.toMatchObject({ status: 425 });
        await h.write(); await expect(h.refine()).resolves.toMatchObject({ applied: true });
    });
    it('rejects changed played payload, sequence conflict, wrong context and unsupported claims', async () => {
        const h = harness(); await h.write();
        await expect(h.write(record({ moveUci: 'a2a3' }))).rejects.toMatchObject({ status: 409 });
        await expect(h.refine(enrich(1, { ...good, contextId: 'other' }))).rejects.toMatchObject({ status: 400 });
        await expect(h.refine(enrich(1, { ...good, qualitySupport: 'PROVISIONAL' }))).rejects.toMatchObject({ status: 400 });
        await h.refine();
        await expect(h.refine({ ...enrich(), eventId: eventId(9) })).rejects.toMatchObject({ status: 409 });
    });
    it('keeps engine unavailability neutral and a reveal separate from the played move', async () => {
        const h = harness(); await h.write();
        expect(await h.refine(enrich(1, null))).toMatchObject({ status: 'UNAVAILABLE', quality: 'UNKNOWN' });
        expect(h.tables.practiceReviewState).toHaveLength(0);
        await recordTrainingAttempt({ userId, momentId, dependencies: h.dependencies, request: { kind: 'REVEAL', clientAttemptId, momentRevisionId: revisionId, revealedAt: '2026-09-01T10:01:00.000Z' } });
        expect(h.tables.trainingAttempt).toHaveLength(1);
        expect(h.tables.trainingAttemptStep).toHaveLength(1);
        await h.refine(enrich(2));
        expect(h.tables.trainingAttempt[0]).toMatchObject({ status: 'REVEALED', quality: 'UNKNOWN' });
        expect(h.tables.practiceReviewState).toHaveLength(0);
    });
    it('uses the served supported initial assessment without client grading claims', async () => {
        const h = harness(); expect(await h.write(record({ resolution: 'RESOLVED', initialAssessmentId: 'good' }))).toMatchObject({ status: 'RESOLVED', quality: 'GOOD', tier: null });
        expect(h.tables.practiceReviewState[0]).toMatchObject({ successes: 1 });
    });
});


it('validates real engine evidence at the persistence boundary and rejects a forged quality correction', async () => {
    manifest = { ...practiceV4Fixture(), momentId, revisionId };
    const h = harness();
    const patch = practiceV4PatchFixture(manifest);
    await h.write(record({ contextId: manifest.source.contextId }));
    const request = { ...enrich(), evaluation: patch, assessmentId: 'local-e2e4' };
    expect(await h.refine(request)).toMatchObject({ quality: 'GOOD', applied: true });
    const forged = structuredClone(request);
    forged.eventId = eventId(2); forged.sequence = 2; forged.supersedesEventId = eventId(1);
    forged.evaluation.assessments[0].quality = 'BELOW_STANDARD';
    await expect(h.refine(forged)).rejects.toMatchObject({ status: 400 });
    expect(h.tables.practiceReviewState[0]).toMatchObject({ successes: 1, lapses: 0 });
    expect(h.tables.trainingAttemptAssessmentRevision).toHaveLength(1);
});


it('rejects an out-of-order predecessor whose ID breaks the already stored successor chain', async () => {
    const h = harness(); await h.write(); await h.refine(enrich(2));
    await expect(h.refine({ ...enrich(1), eventId: eventId(9) })).rejects.toMatchObject({ status: 409 });
    expect(h.tables.trainingAttemptAssessmentRevision).toHaveLength(1);
});


it('records a validated coverage-group verdict without inventing a tier or score', async () => {
    manifest.coverageGroups = [{ id: 'bad-group', contextId: 'root', frameId: 'frame', movesUci: ['a2a3'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED', evidenceIds: [] }];
    manifest.rootAnswerIndex.coverageGroupIds = ['bad-group'];
    const h = harness();
    expect(await h.write(record({ moveUci: 'a2a3', resolution: 'RESOLVED', initialCoverageGroupId: 'bad-group' }))).toMatchObject({ quality: 'BELOW_STANDARD', tier: null });
    expect(h.tables.trainingAttemptStep[0]).toMatchObject({ initialAssessmentId: null, initialCoverageGroupId: 'bad-group' });
});


it('pins a delayed offline attempt to revision A metrics after revision B changes the moment', async () => {
    manifest = { ...practiceV4Fixture(), momentId, revisionId };
    const original = manifest.assessments.find(item => item.id === manifest.decision.originalAssessmentId)!;
    const h = harness();
    const newRevisionId = '66666666-6666-4666-8666-666666666666';
    h.tables.solutionRevision.push({ ...h.tables.solutionRevision[0], id: newRevisionId, solutionHash: 'new-semantic' });
    Object.assign(h.tables.trainingMoment[0], { currentSolutionRevisionId: newRevisionId, cpLoss: 999, winChanceLoss: 0.95 });
    await h.write(record({ contextId: manifest.source.contextId }));
    expect(h.tables.trainingAttempt[0]).toMatchObject({ solutionRevisionId: revisionId, contextSolutionHash: manifest.semanticHash, contextCpLoss: Math.max(0, original.metrics.lossCp!), contextWinChanceLoss: original.metrics.lossExpectedScore == null ? null : Math.max(0, original.metrics.lossExpectedScore) });
    expect(h.tables.trainingAttempt[0].contextCpLoss).not.toBe(999);
    expect(h.tables.trainingAttempt[0].contextWinChanceLoss).not.toBe(0.95);
});


it('does not classify a later-context group move as repetition of the source decision', async () => {
    manifest.source.originalMoveUci = 'a2a3';
    manifest.coverageGroups = [{ id: 'later-group', contextId: 'later', frameId: 'later-frame', movesUci: ['a2a3'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED', evidenceIds: [] }];
    manifest.continuation = { mode: 'VERIFIED_BRANCHES', nodes: [
        { id: 'root-node', role: 'USER', contextId: 'root', fen: 'root-fen' },
        { id: 'opponent-node', role: 'OPPONENT', contextId: 'opponent', fen: 'opponent-fen' },
        { id: 'later-node', role: 'USER', contextId: 'later', fen: 'later-fen', answerIndex: { contextId: 'later', frameId: 'later-frame', legalMovesUci: ['a2a3'], assessmentIds: [], coverageGroupIds: ['later-group'] } },
    ], edges: [{ from: 'root-node', to: 'opponent-node', moveUci: 'e2e4' }, { from: 'opponent-node', to: 'later-node', moveUci: 'e7e5' }] } as unknown as PracticeMomentRevision['continuation'];
    const h = harness();
    await h.write(record({ resolution: 'RESOLVED', initialAssessmentId: 'good' }));
    await h.write(record({ stepIndex: 1, contextId: 'later', moveUci: 'a2a3', playedAt: '2026-09-01T10:01:00.000Z', resolution: 'RESOLVED', initialCoverageGroupId: 'later-group' }));
    expect(h.tables.trainingAttemptStep[1]).toMatchObject({ quality: 'BELOW_STANDARD', originalRelation: 'UNKNOWN' });
});
