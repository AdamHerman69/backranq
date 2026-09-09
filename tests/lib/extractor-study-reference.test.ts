import { describe, expect, it } from 'vitest';
import { sampleReferencePlies } from '../../scripts/extractor-study/reference';

describe('research reference sampling', () => {
    const input = {
        seed: 'frozen', gameId: 'g', positionsPerGame: 6,
        playerPlies: [0, 2, 4, 6, 8, 10, 12, 14, 16],
        admittedPlies: [0, 2, 4], candidatePlies: [2, 4, 6, 8, 10],
    };
    it('samples disjoint strata with correct inclusion probabilities', () => {
        const result = sampleReferencePlies(input);
        expect(result).toHaveLength(6);
        expect(new Set(result.map(r => r.ply)).size).toBe(6);
        for (const stratum of ['ADMITTED', 'CANDIDATE', 'OTHER']) {
            const samples = result.filter(r => r.stratum === stratum);
            expect(samples).toHaveLength(2);
            expect(samples.every(r => r.population === 3 && r.inclusionProbability === 2 / 3)).toBe(true);
        }
    });
    it('is independent of input ordering and duplicate candidates or plies', () => {
        expect(sampleReferencePlies({ ...input, playerPlies: [...input.playerPlies].reverse().concat(2),
            admittedPlies: [4, 2, 0, 0], candidatePlies: [10, 8, 6, 4, 2, 2] })).toEqual(sampleReferencePlies(input));
    });
    it('caps at stratum population without reallocating empty quota', () => {
        expect(sampleReferencePlies({ ...input, playerPlies: [0, 2], admittedPlies: [0, 2] })).toEqual([
            { ply: 0, stratum: 'ADMITTED', population: 2, inclusionProbability: 1 },
            { ply: 2, stratum: 'ADMITTED', population: 2, inclusionProbability: 1 },
        ]);
    });
    it('rejects an invalid allocation rather than changing the sampling design', () => {
        expect(() => sampleReferencePlies({ ...input, positionsPerGame: 4 })).toThrow('multiple of three');
    });
});

import { Chess } from 'chess.js';
import { auditReferencePositions, runReference } from '../../scripts/extractor-study/reference';
import type { StockfishEngine, SearchEvidence } from '@/lib/analysis/stockfishClient';
import type { StudyConfig, StudyGame } from '../../scripts/extractor-study/types';

const game = (side: 'white' | 'black' = 'white'): StudyGame => ({
    account: 'fixture', rating: 1500, bucket: 1, split: 'development', sourceHash: 'fixture',
    game: { id: 'fixture', provider: 'manual_pgn', playedAt: '2026-08-01', timeClass: 'blitz',
        white: { name: side === 'white' ? 'fixture' : 'other' }, black: { name: side === 'black' ? 'fixture' : 'other' },
        pgn: '1. e4 e5 2. Nf3 Nc6 *', provenance: { username: 'fixture', userSide: side } },
});
const config = { seed: 'fixture', reference: { enabled: true, scanNodes: 1000,
    rootNodes: 4000, moveNodes: 4000, positionsPerGame: 6 } } as StudyConfig;

function fixtureEngine(source: StudyGame, options: { originalPreferred?: boolean; incomplete?: boolean; contradiction?: boolean } = {}) {
    const board = new Chess(); board.loadPgn(source.game.pgn);
    const originals = new Map(board.history({ verbose: true }).map(m => [m.before, `${m.from}${m.to}${m.promotion ?? ''}`]));
    const requests: Array<Parameters<StockfishEngine['evalPosition']>[0]> = [];
    const preferred = (fen: string) => {
        const legal = new Chess(fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
        return options.originalPreferred ? originals.get(fen) ?? legal[0] : legal.find(m => m !== originals.get(fen))!;
    };
    let searchId = 0;
    const evidence = (request: Parameters<StockfishEngine['evalPosition']>[0], multiPv = 1): SearchEvidence => ({
        id: `fixture-search-${++searchId}`, sessionId: 'fixture-session', source: 'ENGINE',
        engine: { artifactId: 'fixture', name: 'Fixture', source: 'server', options: {} },
        request: { fen: request.fen, previousFens: [...request.previousFens ?? []],
            rootMoves: [...request.rootMoves ?? new Chess(request.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`)],
            multiPv, purpose: request.purpose ?? 'SCAN', historyMode: request.previousFens?.length ? 'REPLAY' : 'FEN_ONLY', limits: { nodes: request.nodes } },
        reported: { nodes: request.nodes ?? 0, timeMs: 1 }, reused: false,
    });
    const engine: StockfishEngine = {
        async evalPosition(request) {
            requests.push(request);
            const move = request.rootMoves?.[0] ?? preferred(request.fen);
            const score = options.contradiction && request.purpose === 'VERIFY_REFERENCE' ? 700 : 300;
            return { fen: request.fen, bestMoveUci: move, pvUci: [move],
                score: { type: 'cp', value: score }, depth: 12, nodes: request.nodes, searchEvidence: evidence(request) };
        },
        async analyzeMultiPv(request) {
            requests.push(request);
            const move = preferred(request.fen);
            const legal = new Chess(request.fen).moves({ verbose: true }).map(m => `${m.from}${m.to}${m.promotion ?? ''}`);
            return { fen: request.fen, bestMoveUci: move, alternativesComplete: !options.incomplete,
                searchEvidence: evidence(request, request.multiPv),
                lines: [move, ...legal.filter(m => m !== move)].slice(0, request.multiPv).map((m, i) => ({
                    multipv: i + 1, pvUci: [m], score: { type: 'cp' as const, value: 300 }, depth: 12 })) };
        },
    };
    return { engine, requests };
}

describe('bounded finite reference audit', () => {
    it('uses fresh same-root restricted evaluations and deduplicates original equal to preferred', async () => {
        const source = game(), mock = fixtureEngine(source, { originalPreferred: true });
        const result = await runReference({ game: source, config, engine: mock.engine, admittedPlies: [0], candidatePlies: [] });
        expect(result.samples).toHaveLength(2);
        const searches = mock.requests.filter(r => r.purpose !== 'SCAN');
        expect(searches).toHaveLength(4); // root + shared preferred/original for each sample
        expect(searches.filter(r => r.rootMoves).every(r => r.rootMoves?.length === 1)).toBe(true);
        expect(mock.requests.every(r => r.reuse === 'FRESH_REQUIRED')).toBe(true);
        expect(searches.at(-1)?.previousFens).toHaveLength(2);
        expect(result.samples.every(s => s.decision.estimate === 'GOOD' && s.strictQuality === 'UNKNOWN')).toBe(true);
        // No manufactured snapshot/evidence may turn these plain fake point values into strict support.
        expect(result.samples.every(s => s.decision.evidenceIds.length === 2)).toBe(true);
    });
    it('discovers black-side candidates by inverting the child side-to-move score', async () => {
        const source = game('black'), mock = fixtureEngine(source);
        const result = await runReference({ game: source, config, engine: mock.engine, admittedPlies: [], candidatePlies: [] });
        expect(result.scanCandidates).toEqual([1, 3]);
        expect(result.samples.every(s => s.stratum === 'CANDIDATE')).toBe(true);
        expect(mock.requests.filter(r => r.purpose !== 'SCAN')).toHaveLength(6);
    });
    it('does not grade unattributable engine results as reference evidence', async () => {
        const source = game(), mock = fixtureEngine(source);
        const originalEval = mock.engine.evalPosition;
        mock.engine.evalPosition = async request => {
            const result = await originalEval(request);
            if (request.purpose === 'MISSING_MOVE') delete result.searchEvidence;
            return result;
        };
        const result = await runReference({ game: source, config, engine: mock.engine, admittedPlies: [0], candidatePlies: [] });
        expect(result.samples.every(s => s.decision.estimate === 'UNKNOWN')).toBe(true);
    });
    it('keeps incomplete stronger bundles unresolved', async () => {
        const source = game(), mock = fixtureEngine(source, { incomplete: true });
        const result = await runReference({ game: source, config, engine: mock.engine, admittedPlies: [0], candidatePlies: [] });
        expect(result.samples.every(s => s.decision.estimate === 'UNKNOWN' && !s.decision.admitted)).toBe(true);
    });
    it('keeps opposing root/probe quality judgments UNKNOWN without requiring numerical score stability', async () => {
        const source = game(), mock = fixtureEngine(source, { contradiction: true });
        const result = await runReference({ game: source, config, engine: mock.engine, admittedPlies: [0], candidatePlies: [] });
        expect(result.samples.every(s => s.decision.reason === 'REFERENCE_QUALITY_CONTRADICTION')).toBe(true);
    });
    it('uses rule-terminal evaluation before spending engine work on the final position', async () => {
        const source = game('black'); source.game.pgn = '1. f3 e5 2. g4 Qh4# 0-1';
        const mock = fixtureEngine(source, { originalPreferred: true });
        await runReference({ game: source, config, engine: mock.engine, admittedPlies: [], candidatePlies: [] });
        expect(mock.requests.filter(r => r.purpose === 'SCAN')).toHaveLength(4);
        expect(mock.requests.every(r => !new Chess(r.fen).isCheckmate())).toBe(true);
    });
    it('stops before engine work when already cancelled', async () => {
        const source = game(), mock = fixtureEngine(source), controller = new AbortController();
        controller.abort();
        await expect(runReference({ game: source, config, engine: mock.engine, admittedPlies: [], candidatePlies: [], signal: controller.signal })).rejects.toThrow();
        expect(mock.requests).toHaveLength(0);
    });
});


describe('targeted finite reference audit', () => {
    it('deduplicates selected positions and audits only them without a scan', async () => {
        const source = game(), mock = fixtureEngine(source);
        const samples = await auditReferencePositions({ game: source, config, engine: mock.engine, plies: [2, 0, 2] });
        expect(samples.map(s => s.ply)).toEqual([0, 2]);
        expect(samples.every(s => s.population === 2 && s.inclusionProbability === 1 && s.stratum === 'ADMITTED')).toBe(true);
        expect(mock.requests).toHaveLength(6);
        expect(mock.requests.some(r => r.purpose === 'SCAN')).toBe(false);
        expect(mock.requests.every(r => r.reuse === 'FRESH_REQUIRED')).toBe(true);
        expect(mock.requests.at(-1)?.previousFens).toHaveLength(2);
    });
    it.each([[-1], [4], [0.5], [1], [Number.NaN], [0, 3]])('rejects invalid or opposite-side plies before work: %j', async (...plies) => {
        const source = game(), mock = fixtureEngine(source);
        await expect(auditReferencePositions({ game: source, config, engine: mock.engine, plies })).rejects.toThrow('Invalid targeted reference player ply');
        expect(mock.requests).toHaveLength(0);
    });
    it('accepts only black player decisions for a black-side source', async () => {
        const source = game('black'), mock = fixtureEngine(source, { originalPreferred: true });
        const samples = await auditReferencePositions({ game: source, config, engine: mock.engine, plies: [3, 1] });
        expect(samples.map(s => s.ply)).toEqual([1, 3]);
        expect(mock.requests).toHaveLength(4); // root + deduplicated original/reference per ply
        expect(samples.every(s => s.decision.estimate === 'GOOD')).toBe(true);
    });
    it.each([{}, { incomplete: true }, { contradiction: true }, { originalPreferred: true }])('preserves the existing strong point comparison: %j', async options => {
        const source = game(), fullEngine = fixtureEngine(source, options), targetedEngine = fixtureEngine(source, options);
        const full = await runReference({ game: source, config, engine: fullEngine.engine, admittedPlies: [0, 2], candidatePlies: [] });
        const targeted = await auditReferencePositions({ game: source, config, engine: targetedEngine.engine, plies: [0, 2] });
        const stripIds = (samples: typeof targeted) => samples.map(s => ({ ...s, decision: { ...s.decision, evidenceIds: [] } }));
        expect(stripIds(targeted)).toEqual(stripIds(full.samples));
        expect(JSON.stringify(targetedEngine.requests)).toBe(JSON.stringify(fullEngine.requests.filter(r => r.purpose !== 'SCAN')));
    });
    it('performs no work for an empty targeted set', async () => {
        const source = game(), mock = fixtureEngine(source);
        expect(await auditReferencePositions({ game: source, config, engine: mock.engine, plies: [] })).toEqual([]);
        expect(mock.requests).toHaveLength(0);
    });
});
