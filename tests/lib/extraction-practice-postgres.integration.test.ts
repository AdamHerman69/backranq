import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { analysisDefaultsToExtractOptions } from '@/lib/preferences';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { EXPECTED_OWNER_HEADER } from '@/lib/auth/ownerContract';
import { getTrainingMomentPrompt } from '@/lib/training/readService';
import { gradeKnownLocalMove } from '@/lib/training/localGrading';
import { recordTrainingAttempt } from '@/lib/training/attemptService';
import type { NormalizedGame } from '@/lib/types/game';

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
        expect(output.moments[0]?.solution.decision.status).toBe('CONFIRMED_MISTAKE');
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
        const moveUci = prompt.grading.review.bestMoveUci;
        const evaluated = gradeKnownLocalMove({ manifest: prompt.grading, node: prompt.grading.solutionTree, moveUci });
        expect(evaluated?.result).toMatchObject({ status: 'GRADED', grade: 'BEST', accepted: true });
        const request = {
            kind: 'RECORD' as const, clientAttemptId: randomUUID(), solutionRevisionId: prompt.solutionRevisionId,
            completedAt: new Date().toISOString(), status: 'GRADED' as const, grade: 'BEST' as const,
            gradingSource: evaluated!.source, comparison: evaluated!.comparison,
            steps: [{ stepIndex: 0, actor: 'USER' as const, fenBefore: prompt.fen, moveUci,
                grade: 'BEST' as const, source: evaluated!.source, timeSpentMs: 500 }],
        };
        const first = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id, request, dependencies: { db } });
        const retry = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id, request, dependencies: { db } });
        expect(retry.attemptId).toBe(first.attemptId);
        expect(await db.trainingAttempt.count({ where: { userId: ownerId } })).toBe(1);
        expect(await db.trainingMomentObservation.count({ where: { momentId: moment.id } })).toBe(1);
        const neutral = await recordTrainingAttempt({ userId: ownerId, momentId: moment.id,
            request: { kind: 'RECORD', clientAttemptId: randomUUID(), solutionRevisionId: prompt.solutionRevisionId,
                completedAt: new Date().toISOString(), status: 'REVEALED',
                steps: [{stepIndex:0,actor:'USER',fenBefore:prompt.fen,moveUci,timeSpentMs:500}] },
            dependencies: { db } });
        expect(await db.trainingAttempt.findUnique({where:{id:neutral.attemptId}})).toMatchObject({
            status: 'REVEALED', userMoveUci: moveUci, grade: null, gradingSource: null,
        });

    }, 90_000);
});
