import { CORROBORATED_SELECTION_POLICY_ID } from '@/lib/analysis/t2Policy';
import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { extractTrainingMomentsFromGames } from '@/lib/analysis/extractTrainingMoments';
import { parseExtractionCheckpoint } from '@/lib/analysis/extractionCheckpoint';
import { PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { isTrainingExtractionReceipt } from '@/lib/analysis/extractionReceipt';
import type { NormalizedGame } from '@/lib/types/game';
import type { AnalysisLimit, EvalResult, MultiPvResult, SearchEvidence } from '@/lib/analysis/stockfishClient';
import { ScriptedExtractionEngine, afterFixtureMove } from '../helpers/extraction-engine';

const fen = new Chess().fen();
const source: NormalizedGame = { id: 'fixture', provider: 'lichess', playedAt: '2026-01-01T00:00:00.000Z', timeClass: 'rapid',
    white: { name: 'adam' }, black: { name: 'opponent' }, pgn: '1. e4 *', provenance: { username: 'adam', userSide: 'white' } };
function engineFixture() {
    return new ScriptedExtractionEngine().set(fen, [{ move: 'e2e3', cp: 100 }, { move: 'd2d3', cp: 95 }, { move: 'e2e4', cp: -200 }])
        .set(afterFixtureMove(fen, 'e2e4'), [{ move: 'e7e5', cp: 200 }]);
}
function run(engine: ScriptedExtractionEngine, extra: Partial<Parameters<typeof extractTrainingMomentsFromGames>[0]> = {}) {
    return extractTrainingMomentsFromGames({ engine, games: [source], selectedGameIds: new Set([source.id]), strategy: 'FIRST_PUZZLE',
        options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000, multiPv: 3, returnAnalysis: true }, ...extra });
}
function work(engine: ScriptedExtractionEngine) { return engine.requests.filter(request => request.purpose !== 'GAME_SCAN' && request.purpose !== 'OPTIONAL_COVERAGE'); }

describe('extractor reference dependency planning', () => {
    it('uses root200, probe400, original200 without gratuitous root escalation and records physical order', async () => {
        const engine = engineFixture(); const output = await run(engine, { strategy: 'FULL_GAME' });
        expect(output.moments).toHaveLength(1);
        expect(work(engine).map(request => [request.purpose, request.nodes])).toEqual([
            ['MISSING_REFERENCE', 200_000], ['VERIFY_REFERENCE', 400_000], ['MISSING_MOVE', 200_000],
        ]);
        const receipt = output.analysis!.get(source.id)!.trainingExtraction;
        expect(isTrainingExtractionReceipt(receipt)).toBe(true);
        expect(receipt.decisions[0].confirmation!.passes.map(pass => [pass.purpose, pass.nodes])).toEqual(work(engine).map(request => [request.purpose, request.nodes]));
        expect(new Set(receipt.decisions[0].confirmation!.passes.map(pass => pass.searchId)).size).toBe(3);
    });

    it('reuses matching root and probe paid before a checkpoint without rescan', async () => {
        const engine = engineFixture();
        const first = await run(engine, { strategy: 'FULL_GAME', shouldYield: () => true });
        const checkpoint = parseExtractionCheckpoint(JSON.parse(JSON.stringify(first.checkpoint)))!;
        const pool = PositionAnalysisPool.hydrate(checkpoint.analysisPool);
        const wrapped = pool.wrap(engine);
        await wrapped.analyzeMultiPv({ fen, nodes: 200_000, multiPv: 3, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED' });
        // Eligibility is physical, not dependent on the VERIFY_REFERENCE purpose label.
        await wrapped.evalPosition({ fen, nodes: 400_000, rootMoves: ['e2e3'], purpose: 'MISSING_MOVE', reuse: 'FRESH_REQUIRED' });
        checkpoint.analysisPool = pool.serialize();
        const start = engine.requests.length;
        const resumed = await run(engine, { strategy: 'FULL_GAME', checkpoint });
        expect(resumed.moments).toHaveLength(1);
        expect(engine.requests.slice(start).filter(request => request.purpose !== 'OPTIONAL_COVERAGE').map(request => [request.purpose, request.nodes])).toEqual([['MISSING_MOVE', 200_000]]);
    });

    it('omits finite confirmation when the profile cannot pay a qualifying probe', async () => {
        const engine = engineFixture(); const output = await run(engine, { options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 200_000, multiPv: 3, returnAnalysis: true } });
        expect(output.moments).toEqual([]);
        expect(work(engine).map(request => [request.purpose, request.nodes])).toEqual([['MISSING_REFERENCE', 200_000]]);
        expect(output.analysis!.get(source.id)!.trainingExtraction.decisions[0].status).toBe('UNRESOLVED');
    });

    it('does not let an unproved 800k terminal root result consume the usable root ladder after resume', async () => {
        const engine = engineFixture();
        const first = await run(engine, { strategy: 'FULL_GAME', shouldYield: () => true });
        const checkpoint = parseExtractionCheckpoint(JSON.parse(JSON.stringify(first.checkpoint)))!;
        const pool = PositionAnalysisPool.hydrate(checkpoint.analysisPool);
        engine.snapshotDepths = [];
        await pool.wrap(engine).analyzeMultiPv({ fen, nodes: 800_000, multiPv: 3, purpose: 'MISSING_REFERENCE', reuse: 'FRESH_REQUIRED' });
        engine.snapshotDepths = [10, 11, 12];
        checkpoint.analysisPool = pool.serialize();
        const start = engine.requests.length;
        const output = await run(engine, { strategy: 'FULL_GAME', checkpoint });
        expect(output.moments).toHaveLength(1);
        expect(engine.requests.slice(start).filter(request => request.purpose !== 'OPTIONAL_COVERAGE').map(request => [request.purpose, request.nodes])).toEqual([
            ['MISSING_REFERENCE', 200_000], ['VERIFY_REFERENCE', 400_000], ['MISSING_MOVE', 200_000],
        ]);
    });

    it('refreshes an incoherent root and reuses its now-coherent focused probe', async () => {
        const engine = engineFixture();
        engine.transformIteration = (request, lines) => request.purpose === 'VERIFY_REFERENCE' ? lines.map(line => ({ ...line, cp: -100 })) : lines;
        engine.onRequest = request => { if (request.purpose === 'REFERENCE_DRIFT') engine.set(fen, [{ move: 'e2e3', cp: -100 }, { move: 'd2d3', cp: -105 }, { move: 'e2e4', cp: -400 }]); };
        const output = await run(engine);
        expect(output.moments).toHaveLength(1);
        expect(work(engine).map(request => [request.purpose, request.nodes])).toEqual([
            ['MISSING_REFERENCE', 200_000], ['VERIFY_REFERENCE', 400_000], ['REFERENCE_DRIFT', 400_000], ['MISSING_MOVE', 200_000],
        ]);
    });

    it('verifies a changed preferred move and reuses already sufficient original groups', async () => {
        const engine = engineFixture();
        engine.transformIteration = (request, lines) => request.purpose === 'VERIFY_REFERENCE' && request.rootMoves?.[0] === 'e2e3'
            ? lines.map(line => ({ ...line, cp: -100 })) : lines;
        engine.onRequest = request => { if (request.purpose === 'REFERENCE_DRIFT') engine.set(fen, [{ move: 'd2d3', cp: 100 }, { move: 'e2e3', cp: -100 }, { move: 'e2e4', cp: -400 }]); };
        const output = await run(engine);
        expect(output.moments).toHaveLength(1);
        expect(work(engine).map(request => [request.purpose, request.nodes, request.rootMoves])).toEqual([
            ['MISSING_REFERENCE', 200_000, undefined], ['VERIFY_REFERENCE', 400_000, ['e2e3']],
            ['REFERENCE_DRIFT', 400_000, undefined], ['VERIFY_REFERENCE', 400_000, ['d2d3']],
        ]);
    });

    it('does no original work while focused reference evidence contradicts the root and stays under the old aggregate ceiling', async () => {
        const engine = engineFixture();
        engine.transformIteration = (request, lines) => request.purpose === 'VERIFY_REFERENCE' ? lines.map(line => ({ ...line, cp: -200 })) : lines;
        const output = await run(engine);
        expect(output.moments).toEqual([]);
        expect(work(engine).some(request => request.purpose === 'MISSING_MOVE')).toBe(false);
        expect(work(engine).filter(request => request.purpose === 'VERIFY_REFERENCE')).toHaveLength(3);
        expect(work(engine).filter(request => request.purpose === 'REFERENCE_DRIFT').map(request => request.nodes)).toEqual([400_000, 800_000]);
        expect(work(engine).reduce((sum, request) => sum + (request.nodes ?? 0), 0)).toBeLessThanOrEqual(2_800_000);
        expect(work(engine).every(request => request.nodes! <= 800_000)).toBe(true);
    });

    it('stops an unresolved original at the old 2.8M aggregate ceiling without enlarging its next reservation', async () => {
        const engine = engineFixture(); let refreshes = 0;
        engine.onRequest = request => {
            if (request.purpose === 'REFERENCE_DRIFT') {
                refreshes++;
                engine.set(fen, [{ move: 'e2e3', cp: 300 }, { move: 'd2d3', cp: 295 }, { move: 'e2e4', cp: -400 }]);
            }
        };
        engine.transformIteration = (request, lines) => request.purpose === 'VERIFY_REFERENCE' && refreshes < 2
            ? lines.map(line => ({ ...line, cp: -100 - 100 * refreshes })) : lines;
        const output = await run(engine, { options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, nodesPerPosition: 100_000, confirmNodes: 200_000, maxConfirmationNodes: 800_000, multiPv: 2, returnAnalysis: true } });
        expect(output.moments).toEqual([]);
        expect(work(engine).map(request => [request.purpose, request.nodes])).toEqual([
            ['MISSING_REFERENCE', 200_000], ['VERIFY_REFERENCE', 400_000], ['REFERENCE_DRIFT', 400_000],
            ['VERIFY_REFERENCE', 400_000], ['REFERENCE_DRIFT', 800_000], ['VERIFY_REFERENCE', 400_000], ['MISSING_MOVE', 200_000],
        ]);
        expect(work(engine).reduce((sum, request) => sum + (request.nodes ?? 0), 0)).toBe(2_800_000);
    });

    it('respects the derived candidate wall ceiling before scheduling any original work', async () => {
        const engine = engineFixture(); let clock = 0;
        const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
        engine.onRequest = request => { if (request.purpose === 'VERIFY_REFERENCE') clock += 180_001; };
        try {
            const output = await run(engine);
            expect(output.moments).toEqual([]);
            expect(work(engine).some(request => request.purpose === 'MISSING_MOVE')).toBe(false);
        } finally { now.mockRestore(); }
    });

    it('preserves cancellation between root verification and original work', async () => {
        const engine = engineFixture(); const controller = new AbortController();
        engine.onRequest = request => { if (request.purpose === 'VERIFY_REFERENCE') controller.abort(); };
        await expect(run(engine, { signal: controller.signal })).rejects.toThrow(/abort/i);
        expect(work(engine).some(request => request.purpose === 'MISSING_MOVE')).toBe(false);
    });

    it.each([{ maxDepth: 20 }, { movetimeMs: 200 }])('keeps an explicit non-node probe limit and the two-request ceiling: %j', async profile => {
        const engine = engineFixture();
        const rawEval = engine.evalPosition.bind(engine); const rawMulti = engine.analyzeMultiPv.bind(engine);
        // Script actual counters independently of the requested depth/time
        // budget; preserve those original limits in every physical record.
        const invoke = async <T extends EvalResult | MultiPvResult>(options: AnalysisLimit & { fen: string; multiPv?: number }, execute: (options: AnalysisLimit & { fen: string; multiPv?: number }) => Promise<T>): Promise<T> => {
            const restoreLimits = (evidence: SearchEvidence) => { evidence.request.limits = {
                ...(options.depth == null ? {} : { depth: options.depth }),
                ...(options.movetimeMs == null ? {} : { movetimeMs: options.movetimeMs }),
            }; };
            const result = await execute({ ...options, nodes: options.purpose === 'GAME_SCAN' ? 100_000 : 400_000,
                onSnapshot: snapshot => { restoreLimits(snapshot.searchEvidence); options.onSnapshot?.(snapshot); } });
            if (result.searchEvidence) restoreLimits(result.searchEvidence);
            return result;
        };
        const evalCalls = vi.spyOn(engine, 'evalPosition').mockImplementation(options => invoke(options, rawEval));
        vi.spyOn(engine, 'analyzeMultiPv').mockImplementation(options => invoke(options, rawMulti));
        const output = await run(engine, { options: { selectionPolicyId: CORROBORATED_SELECTION_POLICY_ID, nodesPerPosition: null, confirmNodes: null, maxConfirmationNodes: null, ...profile, multiPv: 3, returnAnalysis: true } });
        const confirmation = evalCalls.mock.calls.map(([options]) => options).filter(options => options.purpose !== 'GAME_SCAN');
        expect(confirmation.map(options => options.purpose)).toEqual(['VERIFY_REFERENCE', 'MISSING_MOVE']);
        for (const options of confirmation) {
            expect(options.nodes).toBeUndefined();
            if ('maxDepth' in profile) expect(options.depth).toBe(profile.maxDepth);
            else expect(options.movetimeMs).toBe(profile.movetimeMs);
        }
        // One original group is insufficient; the profile cannot buy a third
        // confirmation request merely to produce a verdict.
        expect(output.moments).toEqual([]);
    });
});
