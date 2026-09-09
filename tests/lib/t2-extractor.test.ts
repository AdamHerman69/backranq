import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { extractTrainingMomentsFromGames, resolveTrainingMomentExtractionOptions } from '@/lib/analysis/extractTrainingMoments';
import { parseExtractionCheckpoint } from '@/lib/analysis/extractionCheckpoint';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { replayT2Game, runT2Game } from '@/lib/analysis/t2Strategy';
import { T2_SELECTION_POLICY_ID, CORROBORATED_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { validateTrainingMomentCandidates } from '@/lib/training/candidateValidation';
import { lookupAnswer } from '@/lib/training/answerIndex';
import { runStrategy } from '../../scripts/extractor-study/strategies';
import type { StudyGame } from '../../scripts/extractor-study/types';
import { ScriptedExtractionEngine, afterFixtureMove } from '../helpers/extraction-engine';
const START = new Chess().fen();
function source(pgn = '1. e4 *', side: 'white' | 'black' = 'white'): StudyGame {
    return { account: 'adam', rating: 1400, bucket: 1, split: 'development', sourceHash: 'test', game: {
        id: 'fixture', provider: 'chesscom', playedAt: '2026-08-01T00:00:00.000Z', timeClass: 'blitz', pgn,
        white: { name: side === 'white' ? 'adam' : 'opponent' }, black: { name: side === 'black' ? 'adam' : 'opponent' },
        provenance: { username: 'adam', userSide: side } } };
}
function mock(original = -200) {
    return new ScriptedExtractionEngine().set(START, [{ move: 'd2d4', cp: 100 }, { move: 'e2e4', cp: original }])
        .set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -original }]);
}
function extract(engine = mock(), extra: Partial<Parameters<typeof extractTrainingMomentsFromGames>[0]> = {}) {
    return extractTrainingMomentsFromGames({ engine, games: [source().game], selectedGameIds: new Set(['fixture']), options: { returnAnalysis: true }, ...extra });
}
const frozenProfile = { id: 'T2', mode: 'POINT' as const, scanNodes: 100_000, rootMultiPv: 3,
    additional: 'TARGETED_PRIORITY' as const, rounds: [200_000], postScanGameNodes: 2_000_000, postScanCandidateNodes: 400_000 };
describe('production T2 selection and evidence transport', () => {
    it('defaults to frozen T2 allocation while retaining explicit corroborated mode', () => {
        expect(resolveTrainingMomentExtractionOptions()).toMatchObject({ selectionPolicyId: T2_SELECTION_POLICY_ID,
            nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 400_000, multiPv: 3 });
        expect(resolveTrainingMomentExtractionOptions({ selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID })).toMatchObject({ multiPv: 5, maxConfirmationNodes: 800_000 });
    });
    it('admits a scan mistake without verification and preserves honest pending original assessment', async () => {
        const engine = mock(); const result = await extract(engine);
        expect(engine.requests.map(r => r.purpose)).toEqual(['T2_SCAN', 'T2_SCAN']);
        expect(result.moments).toHaveLength(1);
        const revision = parsePracticeMomentRevision(result.moments[0].solution.manifest);
        expect(revision.selection).toMatchObject({ policyId: T2_SELECTION_POLICY_ID, status: 'INCLUDED' });
        expect(revision.decision.status).toBe('UNRESOLVED');
        expect(result.manifests[0].decisionOutcomes[0].status).toBe('UNRESOLVED');
        expect(lookupAnswer(revision.rootAnswerIndex, 'd2d4', revision.assessments, []).quality).toBe('GOOD');
        expect(lookupAnswer(revision.rootAnswerIndex, 'e2e4', revision.assessments, []).quality).toBe('UNKNOWN');
        expect(validateTrainingMomentCandidates(result.moments).ok).toBe(true);
        expect(result.analysis?.get('fixture')?.trainingExtraction.decisions[0]).toMatchObject({ status: 'SAVED', t2Decision: { admitted: true } });
    });
    it('shares the extractor for the homepage and stops with one ready candidate', async () => {
        const result = await extract(mock(), { strategy: 'FIRST_PUZZLE' });
        expect(result.moments).toHaveLength(1);
        expect(result.manifests[0]).toMatchObject({ scope: 'TARGETED_DECISION', complete: false });
    });
    it('resumes scan and priority work without paying again or losing snapshots', async () => {
        const engine = mock(); let output = await extract(engine, { shouldYield: () => true });
        let slices = 0;
        while (output.checkpoint) {
            const checkpoint = parseExtractionCheckpoint(JSON.parse(JSON.stringify(output.checkpoint)));
            output = await extract(engine, { checkpoint, shouldYield: () => true });
            if (++slices > 10) throw new Error('Checkpoint made no progress');
        }
        expect(engine.requests).toHaveLength(2);
        expect(output.moments).toHaveLength(1);
        expect(output.engineWork).toMatchObject({ reportedNodes: 200_000 });
    });
    it('matches the frozen T2 strategy on clear losses and targeted WDL reversals', async () => {
        for (const targeted of [false, true]) {
            const create = () => {
                const engine = mock(targeted ? 50 : -200);
                if (targeted) {
                    engine.set(START, [{ move: 'd2d4', cp: 100, wdl: { win: 800, draw: 0, loss: 200 } },
                        { move: 'e2e4', cp: 50, wdl: { win: 750, draw: 0, loss: 250 } }]);
                    engine.set(afterFixtureMove(START, 'e2e4'), [{ move: 'e7e5', cp: -50, wdl: { win: 500, draw: 0, loss: 500 } }]);
                }
                return engine;
            };
            const reference = await runStrategy({ game: source(), profile: frozenProfile, engine: create() });
            const pool = new PositionAnalysisPool();
            const output = await runT2Game({ replay: replayT2Game(source().game), engine: pool.wrap(create()), pool });
            expect(output.state.decisions).toEqual(reference.decisions);
        }
    });
    it('allocates the fixed game cap to the nearest admitted boundaries and preserves ply order', async () => {
        const game = source('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O 9. h3 Nb8 10. d4 Nbd7 11. c4 c6 12. Nc3 Qc7 *').game;
        const replay = replayT2Game(game); const engine = new ScriptedExtractionEngine();
        const wdl = (e: number) => ({ win: Math.round(e * 1000), draw: 0, loss: 1000 - Math.round(e * 1000) });
        const losses = [.3, .11, .12, .13, .14, .15, .16, .17, .18, .19, .2, .21];
        for (let index = 0; index < losses.length; index++) {
            const move = replay.moves[index * 2]; const original = `${move.from}${move.to}${move.promotion ?? ''}`;
            const preferred = new Chess(move.before).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`).find(m => m !== original)!;
            engine.set(move.before, [{ move: preferred, cp: 100, wdl: wdl(.8) }, { move: original, cp: 50, wdl: wdl(.8 - losses[index]) }]);
            const reply = new Chess(move.after).moves({ verbose: true })[0];
            engine.set(move.after, [{ move: `${reply.from}${reply.to}${reply.promotion ?? ''}`, cp: -50, wdl: wdl(.2 + losses[index]) }]);
        }
        const pool = new PositionAnalysisPool(); const output = await runT2Game({ replay, engine: pool.wrap(engine), pool });
        expect(output.state.postSpent).toBe(2_000_000);
        expect(engine.requests.filter(r => r.purpose === 'T2_TARGETED_ROOT').map(r => r.previousFens?.length)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
        expect(output.state.decisions.map(d => d.ply)).toEqual(losses.map((_, i) => i * 2));
        expect(output.state.decisions.filter(d => d.targetedVerification?.outcome === 'SKIPPED_BUDGET').map(d => d.ply)).toEqual([0, 22]);
    });
    it('keeps a rule-terminal child exact without paying for a child search', async () => {
        const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
        const game = source(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Qe6 *`).game;
        const engine = new ScriptedExtractionEngine().set(fen, [{ move: 'f7f8', cp: 500, wdl: { win: 1000, draw: 0, loss: 0 } }]);
        const result = await extract(engine, { games: [game] });
        expect(engine.requests).toHaveLength(1);
        const revision = parsePracticeMomentRevision(result.moments[0].solution.manifest);
        expect(revision.selection.comparison).toMatchObject({ originalScore: { kind: 'EXACT', outcome: 'DRAW' }, originalObservationId: null });
        expect(revision.selection.comparison?.originalExactId).toBeTruthy();
    });
    it('retains the snapshot disagreement trigger in the production port', async () => {
        const engine = mock();
        engine.transformIteration = (request, lines, index) => request.purpose === 'T2_SCAN' && request.fen === START && index === 1
            ? lines.map(line => ({ ...line, cp: -150 })) : lines;
        const result = await extract(engine);
        expect(engine.requests.filter(r => r.purpose === 'T2_TARGETED_ROOT')).toHaveLength(1);
        expect(result.analysis?.get('fixture')?.trainingExtraction.decisions[0].t2Decision?.targetedVerification).toMatchObject({
            triggers: ['SCAN_ACCEPTANCE_DISAGREEMENT'], outcome: 'VERIFIED', requestedNodes: 200_000 });
    });
    it('resumes a targeted confirmation with its paid game allowance and no repeated pair', async () => {
        const engine = mock();
        engine.transformIteration = (request, lines, index) => request.purpose === 'T2_SCAN' && request.fen === START && index === 1
            ? lines.map(line => ({ ...line, cp: -150 })) : lines;
        let output = await extract(engine, { shouldYield: () => true });
        const spent: number[] = [];
        for (let slices = 0; output.checkpoint && slices < 8; slices++) {
            spent.push(output.checkpoint.t2State!.postSpent);
            output = await extract(engine, { checkpoint: parseExtractionCheckpoint(JSON.parse(JSON.stringify(output.checkpoint))), shouldYield: () => true });
        }
        expect(spent).toContain(200_000);
        expect(engine.requests).toHaveLength(3); expect(output.checkpoint).toBeUndefined();
        expect(output.moments).toHaveLength(1);
    });
    it('omits unscanned opponent endpoints from move classifications without adding searches', async () => {
        const game = source('1. e4 e5 2. Nf3 *', 'black').game; const engine = new ScriptedExtractionEngine();
        const result = await extract(engine, { games: [game] });
        expect(engine.requests.map(r => r.previousFens?.length)).toEqual([1, 2]);
        expect(result.analysis?.get('fixture')?.moves.map(m => m.ply)).toEqual([1]);
    });
    it('rejects invalid account perspective before spending engine work', async () => {
        const engine = mock(); const game = source().game; game.provenance!.userSide = 'black';
        const result = await extract(engine, { games: [game] });
        expect(engine.requests).toHaveLength(0); expect(result.manifests[0].termination).toBe('USER_SIDE_UNRESOLVED');
    });
});
