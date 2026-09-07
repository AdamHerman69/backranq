import { describe, expect, it, vi } from 'vitest';
import { experimentResidualCoverage } from '@/lib/analysis/residualCoverage';
import { createSearchEvidence, resolveEngineSearchContext, type MultiPvResult, type StockfishEngine } from '@/lib/analysis/stockfishClient';

const fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const legal = resolveEngineSearchContext({ fen }).legalRootMoves;
function engine(options: { bound?: 'UPPER' | 'LOWER'; drift?: boolean; corruptScope?: boolean; reuse?: boolean; near?: boolean } = {}) {
    let sequence = 0;
    const analyzeMultiPv = vi.fn<StockfishEngine['analyzeMultiPv']>(async request => {
        const context = resolveEngineSearchContext(request);
        const restricted = !!request.rootMoves;
        const score = restricted ? options.near ? 80 : -100 : options.drift && sequence > 1 ? 240 : 100;
        const evidence = createSearchEvidence(`physical-${++sequence}`, { artifactId: 'fixture-artifact', name: 'test', source: 'TEST', options: { Threads: 1 } }, context, request);
        if (options.corruptScope && restricted) evidence.request.rootMoves = evidence.request.rootMoves.slice(0, 1);
        if (options.reuse) evidence.reused = true;
        const root = request.rootMoves?.[0] ?? 'e2e4';
        const result: MultiPvResult = { fen, bestMoveUci: root, lines: [{ multipv: 1, pvUci: [root], score: { type: 'cp', value: score } }], searchEvidence: evidence };
        if (restricted && options.bound) {
            result.lines = [];
            result.boundLines = [{ moveUci: root, score: { type: 'cp', value: score }, bound: options.bound }];
        }
        return result;
    });
    return { analyzeMultiPv, evalPosition: vi.fn() } satisfies StockfishEngine;
}
const args = { fen, seed: { id: 'frozen-reference', knownMovesUci: ['e2e4'] }, policyVersion: 3, maxAcceptedCpLoss: 100, budgets: [100_000, 200_000] };

describe('optional fixed-seed residual coverage experiment', () => {
    it('records fresh paired evidence for the entire residual without assigning WDL or grades', async () => {
        const runtime = engine();
        const result = await experimentResidualCoverage({ ...args, engine: runtime });
        expect(result.status).toBe('CP_BOUNDARY_SUPPORTED');
        expect(result.coveredMovesUci).toEqual(legal.filter(move => move !== 'e2e4'));
        expect(runtime.analyzeMultiPv).toHaveBeenCalledTimes(4);
        expect(runtime.analyzeMultiPv.mock.calls[1][0]).toMatchObject({ rootMoves: result.residualMovesUci, reuse: 'FRESH_REQUIRED', nodes: 100_000 });
        expect(result.passes).toHaveLength(2);
        expect(result).not.toHaveProperty('wdl');
        expect(result).not.toHaveProperty('grade');
    });
    it('does no engine work for empty residuals', async () => {
        const runtime = engine();
        const result = await experimentResidualCoverage({ ...args, seed: { id: 'all-known', knownMovesUci: legal }, engine: runtime });
        expect(result.status).toBe('EMPTY_RESIDUAL');
        expect(runtime.analyzeMultiPv).not.toHaveBeenCalled();
    });
    it('keeps lower bounds and multi-root per-move upper bounds partial', async () => {
        for (const bound of ['LOWER', 'UPPER'] as const) {
            expect((await experimentResidualCoverage({ ...args, engine: engine({ bound }) })).status).toBe('PARTIAL');
        }
        const singleton = { ...args, seed: { id: 'one-remaining', knownMovesUci: legal.slice(1) } };
        expect((await experimentResidualCoverage({ ...singleton, engine: engine({ bound: 'UPPER' }) })).status).toBe('CP_BOUNDARY_SUPPORTED');
        expect((await experimentResidualCoverage({ ...singleton, engine: engine({ bound: 'LOWER' }) })).status).toBe('PARTIAL');
    });
    it('does not certify a narrow gap, unstable reference, truncated scope, or reused search', async () => {
        for (const options of [{ near: true }, { drift: true }, { corruptScope: true }, { reuse: true }]) {
            const result = await experimentResidualCoverage({ ...args, engine: engine(options) });
            expect(result.status).toBe('PARTIAL');
            expect(result.coveredMovesUci).toEqual([]);
        }
    });
    it('rejects illegal seeds and propagates cancellation', async () => {
        const runtime = engine();
        await expect(experimentResidualCoverage({ ...args, engine: runtime, seed: { id: 'bad', knownMovesUci: ['e2e5'] } })).rejects.toThrow(/Invalid/);
        const controller = new AbortController(); controller.abort();
        await expect(experimentResidualCoverage({ ...args, engine: runtime, signal: controller.signal })).rejects.toThrow(/aborted/);
        expect(runtime.analyzeMultiPv).not.toHaveBeenCalled();
    });
});
