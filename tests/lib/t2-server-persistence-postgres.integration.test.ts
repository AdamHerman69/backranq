import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import source from '../fixtures/t2-server-persistence-game.json';
import { ScriptedExtractionEngine } from '../helpers/extraction-engine';
import { ServerStockfishClient } from '@/lib/analysis/serverStockfishClient';
import type { StockfishEngine, AnalysisLimit } from '@/lib/analysis/stockfishClient';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { serverAnalysisConfigFromPreferences, serverAnalysisConfigFromSnapshot } from '@/lib/services/analysisJobs';
import { createAnalysisRunInTransaction, completeAnalysisRunWithGameAnalysisInTransaction } from '@/lib/services/analysisRuns';
import { dbGameToNormalized, jsonToGameAnalysis } from '@/lib/api/games';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { getTrainingMomentPrompt } from '@/lib/training/readService';

const integration = describe.runIf(process.env.BACKRANQ_POSTGRES_INTEGRATION === 'true');
integration('nonempty T2 server producer through actual PostgreSQL persistence', () => {
    it('commits moments, immutable revisions, observations, notification and a readable Practice prompt', async () => {
        const target = new URL(process.env.DATABASE_URL!);
        if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !/(?:_test|_e2e|_ci)$/.test(target.pathname)) {
            throw new Error('This regression requires an isolated local test database');
        }
        const realEngine = process.env.BACKRANQ_T2_LIVE_ENGINE === 'true';
        const db = new PrismaClient();
        const raw = realEngine ? new ServerStockfishClient() : null;
        const controller = new AbortController();
        const timer = setTimeout(() => { controller.abort(); raw?.cancelAll(); }, 90_000);
        let requestedNodes = 0;
        const begin = performance.now();
        let userId: string | undefined;
        try {
            const board = new Chess(); board.loadPgn(source.pgn);
            const history = board.history({ verbose: true });
            expect(history).toHaveLength(110);
            const scripted = new ScriptedExtractionEngine();
            const first = history[1];
            const legal = new Chess(first.before).moves({ verbose: true });
            const alternative = legal.find(move => move.lan !== first.lan)!;
            scripted.set(first.before, [{ move: alternative.lan, cp: 100 }, { move: first.lan, cp: -200 }]);
            const reply = new Chess(first.after).moves({ verbose: true })[0];
            scripted.set(first.after, [{ move: reply.lan, cp: 200 }]);
            const implementation = raw ?? scripted;
            const guard = (opts: AnalysisLimit) => {
                if (!Number.isSafeInteger(opts.nodes) || requestedNodes + opts.nodes! > 14_000_000) throw new Error('Test engine node cap exceeded');
                requestedNodes += opts.nodes!;
            };
            const engine: StockfishEngine = {
                evalPosition: opts => { guard(opts); return implementation.evalPosition(opts); },
                analyzeMultiPv: opts => { guard(opts); return implementation.analyzeMultiPv(opts); },
                ...(raw ? { getIdentity: () => raw.getIdentity() } : {}),
            };
            const user = await db.user.create({ data: { name: 'Isolated T2 persistence regression' } }); userId = user.id;
            const game = await db.analyzedGame.create({ data: {
                userId, provider: 'CHESSCOM', externalId: randomUUID(), pgn: source.pgn,
                sourcePgnHash: hashSourcePgn(source.pgn), plyCount: history.length,
                sourceUsername: source.blackName, userSide: 'BLACK', whiteName: source.whiteName, blackName: source.blackName,
                playedAt: new Date('2026-09-09T00:00:00.000Z'), timeClass: 'BLITZ', analysis: {}, currentAnalysisValid: false,
            } });
            const canonical = serverAnalysisConfigFromPreferences({ analysisQuality: 'T2' }).config;
            const run = await db.$transaction(tx => createAnalysisRunInTransaction({ tx, userId: user.id, gameId: game.id,
                executionMode: 'SERVER_QUEUE', analysisQuality: 'T2', status: 'RUNNING', startedAt: new Date(),
                configSnapshot: canonical.snapshot, configHash: canonical.hash }));
            const restored = serverAnalysisConfigFromSnapshot({ snapshot: run.configSnapshot, hash: run.configHash });
            expect(restored).not.toBeNull();
            const normalized = dbGameToNormalized(game);
            const output = await extractTrainingMomentsFromGames({ games: [normalized], selectedGameIds: new Set([normalized.id]),
                canonicalSourceGameIdByGameId: { [normalized.id]: game.id }, analysisConfigHash: run.configHash,
                options: restored!.options, engine, signal: controller.signal });
            expect(output.moments.length).toBeGreaterThan(0);
            expect(output.manifests[0].complete).toBe(true);
            if (process.env.BACKRANQ_T2_SAVE_EVIDENCE === 'true') writeFileSync('artifacts/practice-t2-release/profile-fix-produced.json', JSON.stringify({ output: { ...output, analysis: [...output.analysis!] }, config: canonical }));
            const complete = await db.$transaction(tx => completeAnalysisRunWithGameAnalysisInTransaction({ tx, runId: run.id,
                userId: user.id, gameId: game.id, analysis: output.analysis!.get(normalized.id)!, trainingMoments: output.moments,
                extractionManifest: output.manifests[0] }), { timeout: 30_000 });
            expect(complete.run.status).toBe('SUCCEEDED');
            expect(complete.trainingMoments.upserted).toBe(output.moments.length);
            const savedGame = await db.analyzedGame.findUniqueOrThrow({ where: { id: game.id } });
            expect(savedGame.currentAnalysisValid).toBe(true);
            const savedMoves = jsonToGameAnalysis(savedGame.analysis)!.moves;
            const producedMoves = output.analysis!.get(normalized.id)!.moves;
            expect(savedMoves.map(({ ply, uci }) => ({ ply, uci }))).toEqual(producedMoves.map(({ ply, uci }) => ({ ply, uci })));
            for (const [index, move] of savedMoves.entries()) {
                expect(move.cpLoss).toBeCloseTo(producedMoves[index].cpLoss, 10);
                if (move.accuracy !== undefined) expect(move.accuracy).toBeCloseTo(producedMoves[index].accuracy!, 10);
            }
            const moments = await db.trainingMoment.findMany({ where: { gameId: game.id }, include: { currentSolutionRevision: true } });
            expect(moments).toHaveLength(output.moments.length);
            for (const moment of moments) {
                expect(moment.status).toBe('ACTIVE');
                expect(moment.currentSolutionRevision?.trainable).toBe(true);
                expect(parsePracticeMomentRevision(moment.currentSolutionRevision!.manifest).selection.status).toBe('INCLUDED');
                expect(await getTrainingMomentPrompt({ db, userId: user.id, momentId: moment.id })).not.toBeNull();
            }
            expect(await db.trainingMomentObservation.count({ where: { analysisRunId: run.id } })).toBe(output.moments.length);
            expect(await db.notification.count({ where: { userId, type: 'PRACTICE_READY' } })).toBe(1);
            const result = { mode: realEngine ? 'REAL_STOCKFISH' : 'SCRIPTED_ENGINE', sourcePlies: history.length,
                analyzedMoves: output.analysis!.get(normalized.id)!.moves.length, moments: moments.length, requestedNodes,
                wallMs: performance.now() - begin, configHash: canonical.hash, persisted: true, allPromptsReadable: true };
            if (process.env.BACKRANQ_T2_SAVE_EVIDENCE === 'true') writeFileSync('artifacts/practice-t2-release/profile-fix-postgres-result.json', JSON.stringify(result, null, 2));
        } finally {
            clearTimeout(timer); raw?.terminate();
            if (userId) await db.user.delete({ where: { id: userId } });
            await db.$disconnect();
        }
    }, 120_000);
});
