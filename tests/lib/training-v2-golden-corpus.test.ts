import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import corpus from '../fixtures/training-v4/golden-corpus.v4.json';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { solutionSemanticsHash, trainingMomentKey } from '@/lib/training/contractHashes.server';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { ScriptedExtractionEngine, afterFixtureMove } from '../helpers/extraction-engine';
import type { NormalizedGame } from '@/lib/types/game';

function engineFor(id: string): ScriptedExtractionEngine {
    const engine = new ScriptedExtractionEngine(); const start = new Chess().fen();
    if (id === 'golden-quiet') return engine.set(start, [{ move: 'e2e3', cp: 100 }, { move: 'd2d3', cp: 95 }, { move: 'e2e4', cp: -200 }]).set(afterFixtureMove(start, 'e2e4'), [{ move: 'e7e5', cp: 200 }]);
    if (id === 'golden-mate') return engine.set('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1', [{ move: 'f7f8', mate: 1 }]);
    if (id === 'golden-repetition') {
        const fen = 'rnbqkb1r/pppppppp/5n2/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 7 4';
        return engine.set(fen, [{ move: 'e7e5', cp: -300 }, { move: 'e7e6', cp: -400 }]).set(afterFixtureMove(fen, 'e7e6'), [{ move: 'g1f3', cp: 400 }]);
    }
    if (id === 'golden-en-passant') {
        const fen = 'rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3';
        return engine.set(fen, [{ move: 'e5d6', cp: 200, pv: ['e5d6', 'c7d6'] }, { move: 'g1f3', cp: -200 }]).set(afterFixtureMove(fen, 'g1f3'), [{ move: 'c7c5', cp: 200 }]);
    }
    return engine;
}
async function runCorpus() {
    const snapshots: unknown[] = []; const cost = { evalCalls: 0, multiPvCalls: 0, requestedNodes: 0 };
    for (const fixture of corpus.extractionCases) {
        const engine = engineFor(fixture.id);
        const source: NormalizedGame = { id: fixture.id, provider: 'lichess', playedAt: '2026-01-01T00:00:00.000Z', timeClass: 'rapid', pgn: fixture.pgn,
            white: { name: fixture.usernameColor === 'white' ? 'adam' : 'opponent' }, black: { name: fixture.usernameColor === 'black' ? 'adam' : 'opponent' },
            provenance: { username: 'adam', userSide: fixture.usernameColor as 'white' | 'black' } };
        const output = await extractTrainingMomentsFromGames({ games: [source], selectedGameIds: new Set([source.id]), engine,
            options: { nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000, multiPv: 3 } });
        expect(output.manifests).toMatchObject([{ complete: true, errors: [] }]);
        expect(output.moments.map(moment => ({ decisionPly: moment.decisionPly, bestMoveUci: moment.solution.manifest.rootAnswerIndex.preferredMoveUci })), fixture.id).toEqual(fixture.expectedMoments);
        for (const moment of output.moments) {
            const manifest = parsePracticeMomentRevision(moment.solution.manifest);
            expect(manifest.semanticHash).toBe(solutionSemanticsHash(moment.solution));
            expect(moment.sourcePgnHash).toBe(hashSourcePgn(fixture.pgn));
            snapshots.push({ id: fixture.id, sourcePgnHash: moment.sourcePgnHash, decisionPly: moment.decisionPly,
                trainingMomentKey: trainingMomentKey({ gameId: moment.sourceGameId, sourcePgnHash: moment.sourcePgnHash, decisionPly: moment.decisionPly }),
                semanticHash: manifest.semanticHash, bestMoveUci: manifest.rootAnswerIndex.preferredMoveUci, readiness: manifest.rootAnswerIndex.readiness });
        }
        cost.evalCalls += engine.requests.filter(r => r.method === 'eval').length;
        cost.multiPvCalls += engine.requests.filter(r => r.method === 'multi').length;
        cost.requestedNodes += engine.requests.reduce((sum, request) => sum + (request.nodes ?? 0), 0);
    }
    return { snapshots, cost };
}
describe('versioned Practice v4 golden corpus', () => {
    it('keeps linked regressions executable and the canonical PGNs within a deterministic search budget', async () => {
        expect(corpus.version).toBe(4);
        for (const link of corpus.linkedAssertions) expect(readFileSync(resolve(process.cwd(), link.file), 'utf8'), link.coverage).toContain(link.testName);
        const first = await runCorpus(); const second = await runCorpus();
        expect(first.snapshots).toHaveLength(3); expect(second).toEqual(first);
        expect(first.cost.evalCalls).toBeLessThanOrEqual(corpus.costBudget.maxEvalCallsPerRun);
        expect(first.cost.multiPvCalls).toBeLessThanOrEqual(corpus.costBudget.maxMultiPvCallsPerRun);
        expect(first.cost.requestedNodes).toBeLessThanOrEqual(corpus.costBudget.maxRequestedNodesPerRun);
    }, 20_000);
});
