import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { practiceV4Fixture, practiceV4PatchFixture } from '../helpers/practice-v4';
import { recordTrainingAttempt, enrichTrainingAttempt } from '@/lib/training/attemptService';
import type { RecordPlayedMoveRequest, EnrichTrainingAttemptRequest } from '@/lib/training/attemptApi';
import type { PracticeMomentRevision } from '@/lib/training/practiceContract';
import { assessMove } from '@/lib/training/assessmentPolicy';

const integration = describe.runIf(process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true');
const db = new PrismaClient();
let userId: string;
let manifest: PracticeMomentRevision;
const json = (value: unknown) => value as Prisma.InputJsonValue;

integration('Practice v4 transactional event storage', () => {
    beforeAll(async () => {
        userId = (await db.user.create({ data: {} })).id;
        const game = await db.analyzedGame.create({ data: { userId, provider: 'MANUAL_PGN', externalId: randomUUID(), pgn: '1. a3 *', plyCount: 1, sourcePgnHash: 'pgn-hash', sourceUsername: 'Fixture', userSide: 'WHITE', playedAt: new Date(), timeClass: 'RAPID', whiteName: 'Fixture', blackName: 'Other', analysis: {} } });
        const run = await db.analysisRun.create({ data: { userId, gameId: game.id, executionMode: 'LOCAL_BROWSER', analysisQuality: 'STANDARD', creditCost: 0, inputPgnHash: 'pgn-hash', configHash: 'fixture-policy' } });
        const fixture = practiceV4Fixture();
        const moment = await db.trainingMoment.create({ data: { userId, gameId: game.id, momentKey: randomUUID(), sourcePgnHash: 'pgn-hash', decisionPly: 0, fen: fixture.source.fen, positionHistory: [], sideToMove: 'w', originalMoveUci: 'a2a3', scoreBefore: json(fixture.assessments[0].score), scoreAfter: json(fixture.assessments[2].score) } });
        const revisionId = randomUUID();
        manifest = { ...fixture, momentId: moment.id, revisionId, source: { ...fixture.source, gameId: game.id } };
        // Source identity is part of semantics; recompute after assigning the canonical database source.
        const { createHash } = await import('node:crypto');
        const { canonicalJson, canonicalPracticeSemantics } = await import('@/lib/training/practiceContract');
        manifest.semanticHash = createHash('sha256').update(canonicalJson(canonicalPracticeSemantics(manifest))).digest('hex');
        await db.solutionRevision.create({ data: { id: revisionId, momentId: moment.id, analysisRunId: run.id, revision: 1, solutionHash: manifest.semanticHash, configHash: 'fixture-policy', generatorVersion: 'fixture-v4', trainable: true, manifest: json(manifest) } });
        await db.trainingMoment.update({ where: { id: moment.id }, data: { currentSolutionRevisionId: revisionId } });
    });
    afterAll(async () => { if (userId) await db.user.delete({ where: { id: userId } }); await db.$disconnect(); });

    it('serializes concurrent RECORD and ENRICH retries, then corrects one scheduler contribution', async () => {
        const clientAttemptId = randomUUID();
        const request: RecordPlayedMoveRequest = { kind: 'RECORD', clientAttemptId, momentRevisionId: manifest.revisionId, contextId: manifest.source.contextId, stepIndex: 0, moveUci: 'e2e4', playedAt: new Date().toISOString(), timeSpentMs: 100, initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING' };
        const args = { userId, momentId: manifest.momentId, dependencies: { db } };
        const writes = await Promise.all([recordTrainingAttempt({ ...args, request }), recordTrainingAttempt({ ...args, request })]);
        expect(new Set(writes.map(r => r.attemptId)).size).toBe(1);
        expect(writes.filter(r => r.idempotentReplay)).toHaveLength(1);
        expect(await db.practiceReviewState.count({ where: { userId } })).toBe(0);
        const event: EnrichTrainingAttemptRequest = { kind: 'ENRICH', clientAttemptId, momentRevisionId: manifest.revisionId, stepIndex: 0, eventId: randomUUID(), sequence: 1, supersedesEventId: null, evaluatedAt: new Date().toISOString(), resolution: 'RESOLVED', assessmentId: 'local-e2e4', evaluation: practiceV4PatchFixture(manifest) };
        const refinements = await Promise.all([enrichTrainingAttempt({ ...args, request: event }), enrichTrainingAttempt({ ...args, request: event })]);
        expect(refinements.filter(r => r.applied)).toHaveLength(1);
        expect(await db.practiceReviewState.findFirst({ where: { userId } })).toMatchObject({ successes: 1, lapses: 0 });
        const patch = practiceV4PatchFixture(manifest);
        patch.frame.id = 'corrected-frame';
        patch.frame.referenceAssessmentId = 'corrected-d2d4';
        patch.evidence.searches = Object.fromEntries(Object.values(patch.evidence.searches).map(search => { search.id = `corrected-${search.id}`; search.observationIds = search.observationIds.map(id => `corrected-${id}`); return [search.id, search]; }));
        patch.evidence.observations = Object.fromEntries(Object.values(patch.evidence.observations).map(observation => { observation.id = `corrected-${observation.id}`; observation.searchId = `corrected-${observation.searchId}`; return [observation.id, observation]; }));
        for (const observation of Object.values(patch.evidence.observations)) observation.lines.find(l => l.moveUci === 'e2e4')!.score = { kind: 'CP', cp: -400, pov: 'WHITE' };
        // A changed best move needs its own completed focused reference witness.
        const probe = structuredClone(Object.values(patch.evidence.searches).find(search => search.reason === 'VERIFY_REFERENCE')!);
        probe.id = 'corrected-d4-reference-probe';
        probe.sequence = Math.max(...Object.values(patch.evidence.searches).map(search => search.sequence)) + 1;
        probe.request.rootScopeUci = ['d2d4'];
        probe.observationIds = probe.observationIds.map(id => {
            const point = structuredClone(patch.evidence.observations[id]);
            point.id = `d4-${id}`; point.searchId = probe.id; point.rootScopeUci = ['d2d4'];
            point.lines = [{ moveUci: 'd2d4', score: { kind: 'CP', cp: 20, pov: 'WHITE' }, bound: 'UNBOUNDED', wdl: null, pvUci: ['d2d4'] }];
            patch.evidence.observations[point.id] = point;
            return point.id;
        });
        patch.evidence.searches[probe.id] = probe;
        patch.assessments = ['d2d4', 'e2e4', 'a2a3'].map(moveUci => assessMove(patch.frame, { id: `corrected-${moveUci}`, moveUci, trainingSide: 'WHITE', referenceMoveUci: 'd2d4', originalMoveUci: 'a2a3', evidence: patch.evidence }));
        expect(patch.assessments.find(assessment => assessment.moveUci === 'd2d4')).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        expect(patch.assessments.find(assessment => assessment.moveUci === 'e2e4')).toMatchObject({ quality: 'BELOW_STANDARD', qualitySupport: 'SUPPORTED' });
        await enrichTrainingAttempt({ ...args, request: { ...event, eventId: randomUUID(), sequence: 2, supersedesEventId: event.eventId, assessmentId: 'corrected-e2e4', evaluation: patch } });
        expect(await db.trainingAttempt.count({ where: { userId } })).toBe(1);
        expect(await db.trainingAttemptAssessmentRevision.count({ where: { attemptId: writes[0].attemptId } })).toBe(2);
        expect(await db.practiceReviewState.findFirst({ where: { userId } })).toMatchObject({ successes: 0, lapses: 1 });
        expect(await db.practiceReviewEvent.count({ where: { userId } })).toBe(1);
    });
    it('allows multiple pending moves and never applies older unavailable events over newer evidence', async () => {
        const args = { userId, momentId: manifest.momentId, dependencies: { db } };
        const request: RecordPlayedMoveRequest = { kind: 'RECORD', clientAttemptId: randomUUID(), momentRevisionId: manifest.revisionId, contextId: manifest.source.contextId, stepIndex: 0, moveUci: 'e2e4', playedAt: new Date().toISOString(), timeSpentMs: null, initialAssessmentId: null, initialCoverageGroupId: null, resolution: 'PENDING' };
        const olderId = randomUUID();
        const event: EnrichTrainingAttemptRequest = { kind: 'ENRICH', clientAttemptId: request.clientAttemptId, momentRevisionId: manifest.revisionId, stepIndex: 0, eventId: randomUUID(), sequence: 2, supersedesEventId: olderId, evaluatedAt: new Date().toISOString(), resolution: 'RESOLVED', assessmentId: 'local-e2e4', evaluation: practiceV4PatchFixture(manifest) };
        await expect(enrichTrainingAttempt({ ...args, request: event })).rejects.toMatchObject({ status: 425 });
        const [played] = await Promise.all([recordTrainingAttempt({ ...args, request }), recordTrainingAttempt({ ...args, request: { ...request, clientAttemptId: randomUUID() } })]);
        expect(await db.trainingAttempt.count({ where: { userId, status: 'PENDING' } })).toBe(2);
        await enrichTrainingAttempt({ ...args, request: event });
        await expect(enrichTrainingAttempt({ ...args, request: { ...event, eventId: olderId, sequence: 1, supersedesEventId: null, resolution: 'UNAVAILABLE', assessmentId: null, evaluation: null } })).resolves.toMatchObject({ applied: false, quality: 'GOOD' });
        expect(await db.trainingAttemptStep.findFirst({ where: { attemptId: played.attemptId } })).toMatchObject({ latestSequence: 2, quality: 'GOOD' });
        expect(await db.trainingAttemptAssessmentRevision.count({ where: { attemptId: played.attemptId } })).toBe(2);
    });

});
