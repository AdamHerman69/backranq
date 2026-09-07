import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { analysisDefaultsToExtractOptions } from '@/lib/preferences';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import { getTrainingMomentPrompt } from '@/lib/training/readService';
import { lookupAnswer } from '@/lib/training/answerIndex';
import { recordTrainingAttempt } from '@/lib/training/attemptService';
import type { NormalizedGame } from '@/lib/types/game';
import { Chess } from 'chess.js';
import { ScriptedExtractionEngine, afterFixtureMove } from '../helpers/extraction-engine';
import { loadPracticeReassessmentTargets } from '@/lib/training/reassessmentTargets.server';

const integration = describe.runIf(process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true');
const db = new PrismaClient();
const engine = new ServerStockfishClient();
let ownerId: string;

integration('real engine → analysis API → PostgreSQL → Practice → attempt', () => {
    beforeAll(async () => {
        ownerId = (await db.user.create({ data: {} })).id;
        vi.doMock('@/lib/prisma', () => ({ prisma: db }));
        vi.doMock('@/lib/auth', () => ({ auth: async () => ({ user: { id: ownerId } }) }));
        vi.doMock('@/lib/notifications/delivery', () => ({ dispatchPendingNotificationDeliveries: async () => {} }));
    });
    afterAll(async () => {
        engine.terminate();
        if (ownerId) await db.user.deleteMany({ where: { id: ownerId } });
        await db.$disconnect();
    });

    it('reconfirms an existing decision below the new scan gate and archives it through the real producer/API path', async () => {
        const externalId = randomUUID(); const start = new Chess().fen();
        const game: NormalizedGame = { id: `manual_pgn:${externalId}`, provider: 'manual_pgn',
            playedAt: '2026-09-05T00:00:00.000Z', timeClass: 'rapid', white: { name: 'Fixture' }, black: { name: 'Opponent' },
            provenance: { username: 'Fixture', userSide: 'white' }, pgn: '[White "Fixture"]\n[Black "Opponent"]\n\n1. e4 *' };
        const stored = await db.analyzedGame.create({ data: { userId: ownerId, provider: 'MANUAL_PGN', externalId,
            pgn: game.pgn, plyCount: 1, sourcePgnHash: hashSourcePgn(game.pgn), sourceUsername: 'Fixture', userSide: 'WHITE',
            playedAt: new Date(game.playedAt), timeClass: 'RAPID', whiteName: 'Fixture', blackName: 'Opponent', analysis: {} } });
        const options = analysisDefaultsToExtractOptions({ analysisQuality: 'STANDARD', trainingCoveragePreset: 'ALL_CONFIRMED',
            trainingGradingTolerance: 'PRACTICAL' }, { returnAnalysis: true });
        const produce = (scripted: ScriptedExtractionEngine, decisionPlies: number[]) => extractTrainingMomentsFromGames({
            games: [game], selectedGameIds: new Set([game.id]), engine: scripted, tablebase: { probe: async () => null },
            canonicalSourceGameIdByGameId: { [game.id]: stored.id }, reassessDecisionPliesByGameId: { [game.id]: decisionPlies }, options,
        });
        const route = await import('@/app/api/games/[id]/analysis/route');
        const persist = async (output: Awaited<ReturnType<typeof produce>>) => {
            const response = await route.PUT(new Request(`http://localhost/api/games/${stored.id}/analysis`, {
                method: 'PUT', headers: { 'content-type': 'application/json', [EXPECTED_OWNER_HEADER]: ownerId },
                body: JSON.stringify({ analysis: output.analysis!.get(game.id), trainingMoments: output.moments,
                    extractionManifest: output.manifests[0], analysisQuality: 'STANDARD', configSnapshot: output.configSnapshot, configHash: output.configHash }),
            }), { params: Promise.resolve({ id: stored.id }) });
            const body = await response.json(); expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
            expect(response.status).toBe(200); return body;
        };
        const initialEngine = new ScriptedExtractionEngine().set(start, [{ move: 'e2e3', cp: 100 }, { move: 'd2d3', cp: 95 }, { move: 'e2e4', cp: -200 }])
            .set(afterFixtureMove(start, 'e2e4'), [{ move: 'e7e5', cp: 200 }]);
        const initial = await produce(initialEngine, []);
        expect(initial.moments).toHaveLength(1);
        expect((await persist(initial)).trainingMoments.upserted).toBe(1);
        const moment = await db.trainingMoment.findFirstOrThrow({ where: { gameId: stored.id } });
        const revisionId = moment.currentSolutionRevisionId!;
        const prompt = (await getTrainingMomentPrompt({ db, userId: ownerId, momentId: moment.id }))!.moment;
        const best = prompt.grading.assessments.find(a => a.contextId === prompt.grading.source.contextId && a.moveUci === prompt.grading.rootAnswerIndex.preferredMoveUci)!;
        const result = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id, dependencies: { db }, request: {
            kind: 'RECORD', clientAttemptId: randomUUID(), momentRevisionId: revisionId, stepIndex: 0, contextId: best.contextId,
            moveUci: best.moveUci, playedAt: new Date().toISOString(), timeSpentMs: 100,
            resolution: 'RESOLVED', initialAssessmentId: best.id, initialCoverageGroupId: null,
        } });
        const historicalAttempt = await db.trainingAttempt.findUniqueOrThrow({ where: { id: result.attemptId } });
        const targets = await loadPracticeReassessmentTargets({ db, userId: ownerId, gameId: stored.id, pgn: game.pgn });
        expect(targets.decisionPlies).toEqual([0]);
        const freshEngine = new ScriptedExtractionEngine().set(start, [{ move: 'e2e4', cp: 100 }, { move: 'e2e3', cp: 95 }, { move: 'd2d3', cp: 90 }])
            .set(afterFixtureMove(start, 'e2e4'), [{ move: 'e7e5', cp: -100 }]);
        const reassessed = await produce(freshEngine, targets.decisionPlies);
        expect(reassessed.analysis!.get(game.id)!.moves[0].cpLoss).toBe(0);
        expect(freshEngine.requests.some(request => request.purpose === 'MISSING_REFERENCE')).toBe(true);
        expect(reassessed.moments).toHaveLength(1);
        expect(reassessed.moments[0].solution.manifest.decision.status).toBe('NOT_A_MISTAKE');
        expect((await persist(reassessed)).trainingMoments).toMatchObject({ upserted: 0, staleArchived: 1 });
        const retired = await db.trainingMoment.findUniqueOrThrow({ where: { id: moment.id } });
        expect(retired.status).toBe('ARCHIVED'); expect(retired.archivedAt).not.toBeNull();
        expect(retired.currentSolutionRevisionId).not.toBe(revisionId);
        expect(await db.trainingMoment.count({ where: { gameId: stored.id } })).toBe(1);
        expect(await db.solutionRevision.count({ where: { momentId: moment.id } })).toBe(2);
        expect(await db.trainingAttempt.findUniqueOrThrow({ where: { id: result.attemptId } })).toEqual(historicalAttempt);
        expect(await getTrainingMomentPrompt({ db, userId: ownerId, momentId: moment.id })).toBeNull();
        expect((await loadPracticeReassessmentTargets({ db, userId: ownerId, gameId: stored.id, pgn: game.pgn })).decisionPlies).toEqual([]);
    }, 30_000);

    it('keeps a missed mate ending in stalemate, serves its evidence, and records the same attempt once', async () => {
        const externalId = randomUUID();
        const game: NormalizedGame = {
            id: `manual_pgn:${externalId}`, provider: 'manual_pgn',
            playedAt: '2026-09-05T00:00:00.000Z', timeClass: 'rapid',
            white: { name: 'Fixture' }, black: { name: 'Opponent' },
            provenance: { username: 'Fixture', userSide: 'white' },
            pgn: '[White "Fixture"]\n[Black "Opponent"]\n[SetUp "1"]\n[FEN "7k/5Q2/6K1/8/8/8/8/8 w - - 0 1"]\n\n1. Qe6 1/2-1/2',
        };
        const stored = await db.analyzedGame.create({ data: {
            userId: ownerId, provider: 'MANUAL_PGN', externalId, pgn: game.pgn,
            plyCount: 1, sourcePgnHash: hashSourcePgn(game.pgn), sourceUsername: 'Fixture',
            userSide: 'WHITE', playedAt: new Date(game.playedAt), timeClass: 'RAPID',
            whiteName: 'Fixture', blackName: 'Opponent', analysis: {},
        } });
        const output = await extractTrainingMomentsFromGames({
            games: [game], selectedGameIds: new Set([game.id]), engine,
            tablebase: { probe: async () => null },
            canonicalSourceGameIdByGameId: new Map([[game.id, stored.id]]),
            options: analysisDefaultsToExtractOptions({ analysisQuality: 'STANDARD',
                trainingCoveragePreset: 'ALL_CONFIRMED', trainingGradingTolerance: 'PRACTICAL' }, { returnAnalysis: true }),
        });
        expect(output.manifests[0]?.complete).toBe(true);
        expect(output.moments).toHaveLength(1);
        expect(output.moments[0]?.solution.manifest.decision.status).toBe('CONFIRMED_MISTAKE');
        const route = await import('@/app/api/games/[id]/analysis/route');
        const response = await route.PUT(new Request(`http://localhost/api/games/${stored.id}/analysis`, {
            method: 'PUT', headers: { 'content-type': 'application/json', [EXPECTED_OWNER_HEADER]: ownerId },
            body: JSON.stringify({ analysis: output.analysis!.get(game.id), trainingMoments: output.moments,
                extractionManifest: output.manifests[0], analysisQuality: 'STANDARD',
                configSnapshot: output.configSnapshot, configHash: output.configHash }),
        }), { params: Promise.resolve({ id: stored.id }) });
        const body = await response.json();
        expect(body, JSON.stringify(body)).toMatchObject({ ok: true });
        expect(response.status).toBe(200);
        const moment = await db.trainingMoment.findFirstOrThrow({ where: { gameId: stored.id } });
        const prompt = (await getTrainingMomentPrompt({ db, userId: ownerId, momentId: moment.id }))!.moment;
        const moveUci = prompt.grading.rootAnswerIndex.preferredMoveUci;
        const evaluated = lookupAnswer(prompt.grading.rootAnswerIndex, moveUci, prompt.grading.assessments, prompt.grading.coverageGroups);
        expect(evaluated.quality).toBe('GOOD');
        const assessment = prompt.grading.assessments.find(a => a.contextId === prompt.grading.source.contextId && a.moveUci === moveUci)!;
        const request = { kind: 'RECORD' as const, clientAttemptId: randomUUID(), momentRevisionId: prompt.solutionRevisionId, stepIndex: 0, contextId: prompt.grading.source.contextId, moveUci, playedAt: new Date().toISOString(), timeSpentMs: 500, initialAssessmentId: assessment.id, initialCoverageGroupId: null, resolution: 'RESOLVED' as const };
        const first = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id, request, dependencies: { db } });
        const retry = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id, request, dependencies: { db } });
        expect(retry.attemptId).toBe(first.attemptId);
        expect(first.quality).toBe('GOOD');
        expect(await db.trainingAttempt.count({ where: { userId: ownerId, trainingMomentId: moment.id } })).toBe(1);
        expect(await db.trainingMomentObservation.count({ where: { momentId: moment.id } })).toBe(1);
        const neutral = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id, request: { kind: 'REVEAL', clientAttemptId: randomUUID(), momentRevisionId: prompt.solutionRevisionId, revealedAt: new Date().toISOString() }, dependencies: { db } });
        expect(await db.trainingAttempt.findUnique({ where: { id: neutral.attemptId } })).toMatchObject({ status: 'REVEALED', userMoveUci: null, quality: 'UNKNOWN', tier: null });
        expect(await db.trainingAttemptStep.count({ where: { attemptId: neutral.attemptId } })).toBe(0);

    }, 90_000);
});
