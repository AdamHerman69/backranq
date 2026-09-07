import { describe, expect, it, vi } from 'vitest';
import { Chess } from 'chess.js';
import * as stockfishProtocol from '@/lib/analysis/stockfishClient';
import { createAnalysisSnapshot, createBoundAnalysisSnapshot, createSearchEvidence, resolveEngineSearchContext, type AnalysisSnapshot, type EngineIdentity, type StockfishEngine } from '@/lib/analysis/stockfishClient';
import { assessMove } from '@/lib/training/assessmentPolicy';
import { practiceContextId, DEFAULT_ASSESSMENT_POLICY, type ComparisonFrame } from '@/lib/training/practiceContract';
import { mergePracticeEvidence, practiceEngineFingerprint, practiceEvidenceFromSnapshots } from '@/lib/analysis/practiceEvidence';
import { analysisEngineFingerprint, PositionAnalysisPool } from '@/lib/analysis/positionAnalysisPool';
import { AnalysisWorkPlanner, type AnalysisWorkSpec } from '@/lib/analysis/analysisWorkPlanner';

const fen = new Chess().fen();
const engine: EngineIdentity = { artifactId: 'fixture-artifact', name: 'Stockfish', source: 'test', version: '18', options: { Threads: 1, Hash: 64 } };
const context = resolveEngineSearchContext({ fen });
function snapshot(search: string, index: number, moves = ['e2e4', 'd2d4']) {
    return createAnalysisSnapshot(search, index, engine, context, { nodes: 10_000, multiPv: moves.length },
        moves.map((move, i) => ({ multipv: i + 1, pvUci: [move], depth: 4 + index * 2,
            nodes: 100 * (index + 1), score: { type: 'cp', value: 30 - i * 10 } })))!;
}
function matureSnapshot(search: string, index: number, moves = ['e2e4', 'd2d4']) {
    const value = snapshot(search, index, moves);
    value.searchEvidence.request.limits.nodes = 200_000;
    value.searchEvidence.reported.nodes = 100_000 + index * 1000;
    value.lines.forEach(line => { line.nodes = value.searchEvidence.reported.nodes; });
    return value;
}
function corroboratedEvidence(items: AnalysisSnapshot[], moves = ['e2e4', 'd2d4']) {
    // A distinct completed synthetic search corroborates the transported group.
    // The group under test must still independently retain mature point support.
    const prior = [0, 1, 2].map(index => matureSnapshot('prior-completed', index, moves));
    const probeContext = resolveEngineSearchContext({ fen, rootMoves: ['e2e4'] });
    const probe = [0, 1, 2].map(index => createAnalysisSnapshot('completed-reference-probe', index, engine, probeContext,
        { nodes: 400_000, multiPv: 1 }, [{ multipv: 1, pvUci: ['e2e4'], depth: 4 + index * 2,
            nodes: [100_000, 200_000, 400_000][index], score: { type: 'cp', value: 30 } }])!);
    return practiceEvidenceFromSnapshots([...probe, ...prior, ...items], 'WHITE',
        [probe.at(-1)!.searchEvidence, prior.at(-1)!.searchEvidence, items.at(-1)!.searchEvidence]);
}
const work = (id: string, overrides: Partial<AnalysisWorkSpec> = {}): AnalysisWorkSpec => ({
    id, contextId: 'ctx', frameId: null, attemptId: null, generation: 0,
    reason: 'MISSING_MOVE', evidenceDependencies: ['missing:move:e2e4'], priority: 'SUBMITTED_QUALITY', nodes: 100, ...overrides,
});

describe('PositionAnalysisPool', () => {
    it('skips context replay only while empty and retains populated validation and counterevidence', () => {
        const pool = new PositionAnalysisPool();
        const point = matureSnapshot('first-local-search', 0);
        const counter = createBoundAnalysisSnapshot('first-local-search', 1, engine, context,
            { nodes: 200_000, multiPv: 2 }, [{ multipv: 2, pvUci: ['d2d4'], depth: 9,
                nodes: 110_000, score: { type: 'cp', value: -200 }, bound: 'UPPER' }])!;
        const replay = vi.spyOn(stockfishProtocol, 'resolveEngineSearchContext');
        try {
            const before = pool.serialize();
            expect(pool.find({ fen, previousFens: [] })).toEqual([]);
            expect(replay).not.toHaveBeenCalled();
            expect(pool.serialize()).toEqual(before);

            pool.recordSnapshot(point);
            pool.recordSnapshot(counter);
            replay.mockClear();
            expect(() => pool.find({ fen, previousFens: ['invalid history FEN'] })).toThrow();
            expect(replay).toHaveBeenCalledOnce();
            const matches = pool.find({ fen, previousFens: [], moveUci: 'd2d4' });
            expect(matches).toHaveLength(1);
            expect(matches[0].snapshots).toEqual([point, counter]);
        } finally { replay.mockRestore(); }
    });
    it('retains the focused verification reason and its actual singleton scope in canonical telemetry', () => {
        const limits = { nodes: 400_000, multiPv: 1, rootMoves: ['e2e4'], purpose: 'VERIFY_REFERENCE' };
        const probeContext = resolveEngineSearchContext({ fen, ...limits });
        const point = createAnalysisSnapshot('reference-probe', 0, engine, probeContext, limits,
            [{ multipv: 1, pvUci: ['e2e4'], depth: 12, nodes: 400_001, score: { type: 'cp', value: 30 } }])!;
        const record = practiceEvidenceFromSnapshots([point], 'WHITE', [point.searchEvidence]).searches['reference-probe'];
        expect(record.reason).toBe('VERIFY_REFERENCE');
        expect(record.request.rootScopeUci).toEqual(['e2e4']);
        expect(record.reportedNodes).toBe(400_001);
    });
    it('preserves immutable chronology across JSON object ordering and appends new searches in declared order', () => {
        const evidence = (id: string, sequence: number) => {
            const store = practiceEvidenceFromSnapshots([snapshot(id, 0)], 'WHITE');
            store.searches[id].sequence = sequence; return store;
        };
        const first = evidence('first', 4); const second = evidence('second', 8);
        const base = { searches: { ...second.searches, ...first.searches }, observations: { ...second.observations, ...first.observations }, exact: {} };
        const baseCopy = structuredClone(base);
        const third = evidence('third', 0); const fourth = evidence('fourth', 1);
        const additions = { searches: { ...fourth.searches, ...third.searches }, observations: { ...fourth.observations, ...third.observations }, exact: {} };
        const merged = mergePracticeEvidence(base, additions);
        expect(merged.searches.first).toEqual(base.searches.first);
        expect(merged.searches.second).toEqual(base.searches.second);
        expect(merged.searches.third.sequence).toBe(9);
        expect(merged.searches.fourth.sequence).toBe(10);
        expect(base).toEqual(baseCopy);
        expect(mergePracticeEvidence(merged, additions)).toEqual(merged);
    });
    it('reuses identical compute artifacts across runtimes without changing physical provenance', () => {
        const pool = new PositionAnalysisPool(); const original = snapshot('server-search', 0);
        original.searchEvidence.engine.source = 'fixture/server'; pool.recordSnapshot(original);
        const browser = { ...engine, source: 'fixture/browser' };
        expect(analysisEngineFingerprint(browser)).toBe(analysisEngineFingerprint(original.searchEvidence.engine));
        const reused = pool.find({ fen, engine: browser });
        expect(reused).toHaveLength(1);
        expect(reused[0].evidence.engine.source).toBe('fixture/server');
        expect(reused[0].snapshots[0].id).toBe(original.id);
        const changedProvenance = structuredClone(original); changedProvenance.searchEvidence.engine.source = browser.source;
        expect(() => pool.recordSnapshot(changedProvenance)).toThrow('Physical search ID reused');
        for (const incompatible of [{ ...browser, artifactId: 'other-build' }, { ...browser, evalFile: 'other.nnue' }, { ...browser, options: { ...browser.options, Hash: 128 } }, { ...browser, options: { ...browser.options, UCI_ShowWDL: false } }]) {
            expect(pool.find({ fen, engine: incompatible })).toHaveLength(0);
        }
        expect(() => analysisEngineFingerprint({ ...browser, artifactId: '' })).toThrow('artifact identity');
    });
    it('keys cached chess facts by input content and still rejects a changed physical request', () => {
        const pool = new PositionAnalysisPool();
        const original = snapshot('same-id', 0);
        pool.recordSnapshot(original);
        expect(pool.find({ fen })).toHaveLength(1);
        const poisoned = structuredClone(original);
        poisoned.fen = 'invalid FEN';
        poisoned.searchEvidence.request.fen = poisoned.fen;
        expect(() => pool.recordSnapshot(poisoned)).toThrow();
        const scoped = structuredClone(original);
        scoped.searchEvidence.request.rootMoves = ['e2e4', 'd2d4'];
        expect(() => pool.recordSnapshot(scoped)).toThrow('Physical search ID reused');
        const detached = pool.find({ fen })[0];
        detached.evidence.request.fen = 'mutated external copy';
        expect(pool.find({ fen })[0].evidence.request.fen).toBe(fen);
        expect(pool.serialize().searches).toHaveLength(1);
    });
    it('bounds active directional counters separately from the three point observations and round-trips their veto', () => {
        const pool = new PositionAnalysisPool();
        for (let i = 0; i < 3; i++) pool.recordSnapshot(matureSnapshot('search', i));
        for (let i = 3; i < 30; i++) {
            const counter = createBoundAnalysisSnapshot('search', i, engine, context, { nodes: 200_000, multiPv: 2 },
                [{ multipv: 2, pvUci: ['d2d4'], depth: 9, nodes: 103_000 + i, score: { type: 'cp', value: -200 + i }, bound: 'UPPER' }])!;
            pool.recordSnapshot(counter);
        }
        expect(pool.find({ fen })[0].snapshots.map(item => item.snapshotIndex)).toEqual([0, 1, 2, 3]);
        const hydrated = PositionAnalysisPool.hydrate(JSON.parse(JSON.stringify(pool.serialize())));
        expect(hydrated.serialize()).toEqual(pool.serialize());
        const frame: ComparisonFrame = { id: 'frame', contextId: practiceContextId(fen, [], 'WHITE'),
            policyId: DEFAULT_ASSESSMENT_POLICY.id, engineFingerprint: practiceEngineFingerprint(engine), model: 'CP_ONLY',
            referenceAssessmentId: 'reference', status: 'CURRENT', supersededById: null };
        const assess = () => assessMove(frame, { id: 'alternative', moveUci: 'd2d4', trainingSide: 'WHITE',
            referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: corroboratedEvidence(hydrated.find({ fen })[0].snapshots) });
        expect(assess().quality).toBe('UNKNOWN');
        hydrated.recordSnapshot(matureSnapshot('search', 30));
        expect(hydrated.find({ fen })[0].snapshots.map(item => item.snapshotIndex)).toEqual([1, 2, 30]);
        expect(assess()).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
    });
    it('retains only last three complete snapshots plus evidence of alternatives that leave top-K', () => {
        const pool = new PositionAnalysisPool();
        pool.recordSnapshot(snapshot('search', 0, ['g1f3', 'd2d4']));
        for (let i = 1; i <= 6; i++) pool.recordSnapshot(snapshot('search', i));
        expect(pool.find({ fen })[0].snapshots.map((item) => item.snapshotIndex)).toEqual([0, 4, 5, 6]);
        expect(pool.find({ fen, moveUci: 'g1f3' })).toHaveLength(1);
        expect(pool.recordSnapshot(snapshot('search', 6))).toBe(false);
        expect(() => pool.recordSnapshot({ ...snapshot('search', 6), lines: snapshot('search', 5).lines })).toThrow();
        const serialized = JSON.parse(JSON.stringify(pool.serialize()));
        const restored = PositionAnalysisPool.hydrate(serialized);
        expect(restored.serialize()).toEqual(serialized);
    });

    it('retains disappeared alternative evidence but requires current mature membership to restore support', () => {
        const pool = new PositionAnalysisPool();
        for (let i = 0; i < 3; i++) pool.recordSnapshot(matureSnapshot('search', i, ['e2e4', 'g1f3']));
        for (let i = 3; i <= 6; i++) pool.recordSnapshot(matureSnapshot('search', i));
        expect(pool.find({ fen })[0].snapshots.map(item => item.snapshotIndex)).toEqual([0, 1, 2, 4, 5, 6]);
        const frame: ComparisonFrame = { id: 'frame', contextId: practiceContextId(fen, [], 'WHITE'),
            policyId: DEFAULT_ASSESSMENT_POLICY.id, engineFingerprint: practiceEngineFingerprint(engine), model: 'CP_ONLY',
            referenceAssessmentId: 'reference', status: 'CURRENT', supersededById: null };
        const assess = () => assessMove(frame, { id: 'alternative', moveUci: 'g1f3', trainingSide: 'WHITE',
            referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3',
            evidence: corroboratedEvidence(pool.find({ fen })[0].snapshots, ['e2e4', 'g1f3']) });
        expect(assess()).toMatchObject({ quality: 'UNKNOWN' });
        pool.recordSnapshot(matureSnapshot('search', 7, ['e2e4', 'g1f3']));
        expect(assess()).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        const contradictory = matureSnapshot('search', 8, ['e2e4', 'g1f3']);
        contradictory.lines[1].score = { type: 'cp', value: -200 };
        pool.recordSnapshot(contradictory);
        expect(assess()).toMatchObject({ quality: 'UNKNOWN' });
    });

    it('retains referenced observations, history/engine scope separation and no invented complete result snapshot', () => {
        const pool = new PositionAnalysisPool();
        pool.recordSnapshot(snapshot('search', 0));
        pool.retainSnapshot('search:snapshot:0');
        for (let i = 1; i < 6; i++) pool.recordSnapshot(snapshot('search', i));
        expect(pool.find({ fen })[0].snapshots.map((item) => item.snapshotIndex)).toEqual([0, 3, 4, 5]);
        expect(pool.find({ fen, engine: { ...engine, evalFile: 'different-net.nnue' } })).toEqual([]);
        expect(pool.find({ fen, rootMoves: ['e2e4'] })).toEqual([]);
        const chess = new Chess(); const history: string[] = [];
        for (const move of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) { history.push(chess.fen()); chess.move(move); }
        pool.recordResult({ fen: chess.fen(), bestMoveUci: 'e2e4', lines: [{ multipv: 1, pvUci: ['e2e4'], score: { type: 'cp', value: 30 } }],
            searchEvidence: createSearchEvidence('history-search', engine, resolveEngineSearchContext({ fen: chess.fen(), previousFens: history }), { nodes: 1000, multiPv: 1 }) });
        expect(pool.find({ fen: chess.fen() })).toEqual([]);
        expect(pool.find({ fen: chess.fen(), previousFens: history })[0].snapshots).toEqual([]);
        expect(PositionAnalysisPool.hydrate(pool.serialize()).serialize()).toEqual(pool.serialize());
    });

    it('retains cumulative physical cost after eviction and checkpoint hydration', () => {
        const pool = new PositionAnalysisPool({ maxContexts: 1 });
        for (let i = 0; i < 4; i++) pool.recordSnapshot(snapshot('old-position', i));
        const board = new Chess(); board.move('e4');
        pool.recordResult({ fen: board.fen(), bestMoveUci: 'e7e5', lines: [{ multipv: 1, pvUci: ['e7e5'], score: { type: 'cp', value: 0 } }],
            searchEvidence: createSearchEvidence('new-position', engine, resolveEngineSearchContext({ fen: board.fen() }), { nodes: 1000, purpose: 'SCAN' }, { nodes: 900, timeMs: 12 }) });
        expect(pool.find({ fen })).toHaveLength(0);
        expect(pool.report()).toMatchObject({ physicalSearches: 2, requestedNodes: 11_000, reportedNodes: 1300, reportedTimeMs: 12 });
        const restored = PositionAnalysisPool.hydrate(pool.serialize(), { maxContexts: 1 });
        expect(restored.report()).toEqual(pool.report());
        expect(restored.report().byReason.SCAN).toMatchObject({ physicalSearches: 1, requestedNodes: 1000, reportedNodes: 900 });
        const bounded = new PositionAnalysisPool({ maxCostSearches: 1 });
        bounded.recordSnapshot(snapshot('one', 0));
        expect(() => bounded.recordSnapshot(snapshot('two', 0))).toThrow('cost ledger capacity');
    });

    it('counts wrapped queries once, deduplicates physical snapshots/finals/cache and exposes unattributed failures', async () => {
        const pool = new PositionAnalysisPool();
        let calls = 0;
        const snapshots = [0, 1, 2].map(i => snapshot('physical-query', i));
        const source: StockfishEngine = { evalPosition: vi.fn(), analyzeMultiPv: async options => {
            calls++;
            if (calls === 3) throw new Error('Startup failed before engine evidence');
            if (calls === 1) snapshots.forEach(item => options.onSnapshot?.(item));
            return { fen, bestMoveUci: 'e2e4', lines: snapshots[2].lines, snapshots,
                searchEvidence: { ...snapshots[2].searchEvidence, reused: calls > 1 } };
        } };
        const wrapped = pool.wrap(source);
        await wrapped.analyzeMultiPv({ fen, nodes: 10_000, multiPv: 2 });
        await wrapped.analyzeMultiPv({ fen, nodes: 10_000, multiPv: 2 });
        await expect(wrapped.analyzeMultiPv({ fen, nodes: 500, purpose: 'CONTINUATION' })).rejects.toThrow('Startup');
        expect(pool.report()).toMatchObject({ queries: 3, reusedQueries: 1, failedQueries: 1, physicalSearches: 1,
            requestedNodes: 10_000, reportedNodes: 300, unattributedFailedQueries: 1, unattributedFailedRequestedNodes: 500 });
        expect(pool.report().byReason.CONTINUATION).toMatchObject({ queries: 1, failedQueries: 1, physicalSearches: 0 });
        expect(PositionAnalysisPool.hydrate(pool.serialize()).report()).toEqual(pool.report());
        const imported = new PositionAnalysisPool();
        imported.recordResult({ fen, bestMoveUci: 'e2e4', lines: snapshots[2].lines, snapshots,
            searchEvidence: { ...snapshots[2].searchEvidence, reused: true } });
        expect(imported.report().physicalSearches).toBe(0);
        expect(PositionAnalysisPool.hydrate(imported.serialize()).report().physicalSearches).toBe(0);
    });

    it('bounds contexts without deleting the sole known alternative inside the retained context', () => {
        const pool = new PositionAnalysisPool({ maxContexts: 1, maxSearches: 10 });
        pool.recordSnapshot(snapshot('search', 0));
        const chess = new Chess(); chess.move('e4');
        pool.recordResult({ fen: chess.fen(), bestMoveUci: 'e7e5', lines: [{ multipv: 1, pvUci: ['e7e5'], score: { type: 'cp', value: 0 } }],
            searchEvidence: createSearchEvidence('other', engine, resolveEngineSearchContext({ fen: chess.fen() }), { nodes: 1000 }) });
        expect(pool.find({ fen })).toHaveLength(0);
        expect(pool.find({ fen: chess.fen() })).toHaveLength(1);
    });
});

describe('AnalysisWorkPlanner', () => {
    it('prioritizes submitted work, reserves the total once and refuses work beyond the cumulative budget', async () => {
        const planner = new AnalysisWorkPlanner({ maxNodes: 200, maxWallMs: 1000 });
        const order: string[] = [];
        const optional = planner.enqueue(work('optional', { priority: 'OPTIONAL_COVERAGE', reason: 'OPTIONAL_COVERAGE' }), async () => { order.push('optional'); return {}; });
        const submitted = planner.enqueue(work('submitted'), async () => { order.push('submitted'); return {}; });
        await Promise.all([optional, submitted]);
        await expect(planner.enqueue(work('too-much'), async () => ({}))).rejects.toThrow('budget');
        expect(order).toEqual(['submitted', 'optional']);
        expect(planner.report().requestedNodes).toBe(200);
    });

    it('cancels optional work on a submitted move, preserves partial physical accounting, drops stale callbacks', async () => {
        const planner = new AnalysisWorkPlanner({ maxNodes: 300, maxWallMs: 1000 });
        const callback = vi.fn();
        let lateUpdate: (() => void) | undefined;
        const optional = planner.enqueue(work('optional', { priority: 'OPEN_WARMUP' }), async ({ signal, onSnapshot }) => {
            onSnapshot(snapshot('physical', 0));
            lateUpdate = () => onSnapshot(snapshot('physical', 1));
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            return {};
        }, callback);
        const expectedAbort = expect(optional).rejects.toThrow('aborted');
        await vi.waitFor(() => expect(lateUpdate).toBeTypeOf('function'));
        const submitted = planner.enqueue(work('submitted'), async () => ({}));
        await expectedAbort; await submitted;
        lateUpdate!();
        expect(callback).toHaveBeenCalledTimes(1);
        expect(planner.report().physicalSearches).toBe(1);
        expect(planner.report().requestedNodes).toBe(200);
    });

    it('does not count cache reuse or duplicate observations as new searches, keeps budget after generation changes', async () => {
        const planner = new AnalysisWorkPlanner({ maxNodes: 300, maxWallMs: 1000 });
        const evidence = snapshot('physical', 0).searchEvidence;
        await planner.enqueue(work('first'), async ({ onSnapshot }) => { onSnapshot(snapshot('physical', 0)); return { searchEvidence: evidence }; });
        await planner.enqueue(work('cached'), async () => ({ searchEvidence: { ...evidence, reused: true } }));
        expect(planner.report().physicalSearches).toBe(1);
        expect(planner.report().reportedNodes).toBe(100);
        planner.cancelGeneration();
        await expect(planner.enqueue(work('stale'), async () => ({}))).rejects.toThrow('Stale');
        expect(planner.remainingNodes).toBe(100);
    });

    it('includes queue/startup/retry time in the single deadline and cannot accept a new-phase reason', async () => {
        let now = 0;
        const planner = new AnalysisWorkPlanner({ maxNodes: 1000, maxWallMs: 100, now: () => now });
        const first = planner.enqueue(work('first'), async () => { now = 101; throw new Error('startup failed'); });
        await expect(first).rejects.toThrow('startup failed');
        await expect(planner.enqueue(work('retry'), async () => ({}))).rejects.toThrow('budget');
        await expect(planner.enqueue(work('phase', { reason: 'START_COVERAGE_PHASE' as AnalysisWorkSpec['reason'] }), async () => ({}))).rejects.toThrow('reason');
        expect(planner.report().requestedNodes).toBe(100);
    });
});
