import { describe, expect, it, vi } from 'vitest';
import { practicePositionFixture } from '../helpers/practice-position';
import { Chess } from 'chess.js';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { createLocalAnalysisSession, gradeKnownLocalMove, gradeUnknownLocalMove, localContinuationForMove, prewarmLocalReference } from '@/lib/training/localGrading';
import { createAnalysisSnapshot, createBoundAnalysisSnapshot, createSearchEvidence, resolveEngineSearchContext, type AnalysisLimit, type EngineIdentity, type StockfishEngine } from '@/lib/analysis/stockfishClient';
import { practiceEngineFingerprint } from '@/lib/analysis/practiceEvidence';
import { AnalysisWorkPlanner } from '@/lib/analysis/analysisWorkPlanner';
import { deriveAnswerIndex, deriveRootAnswerIndex } from '@/lib/training/answerIndex';
import { T2_ASSESSMENT_POLICY, validatePracticeEvaluationPatch } from '@/lib/training/practiceContract';
import type { TrainingSolutionTreeNodeDto } from '@/lib/training/api';
import { WARMUP_MANIFEST } from '@/lib/onboarding/warmupPuzzle';
import { STOCKFISH_ARTIFACT_ID } from '@/lib/analysis/stockfishMetadata';

const identity: EngineIdentity = { artifactId: 'fixture-artifact', name: 'Fixture Stockfish', version: '18', source: 'fixture/browser', options: { UCI_ShowWDL: false } };
function fixture(compatible = true, nativeIdentity = identity) {
    const manifest = practiceV4Fixture();
    if (compatible) {
        const fingerprint = practiceEngineFingerprint(nativeIdentity);
        manifest.frames.forEach(frame => { frame.engineFingerprint = fingerprint; });
        Object.values(manifest.evidence.observations).forEach(observation => { observation.engineFingerprint = fingerprint; });
        Object.values(manifest.evidence.searches).forEach(search => { search.engineIdentity = { fingerprint, artifactId: nativeIdentity.artifactId, name: nativeIdentity.name,
            build: nativeIdentity.version!, nnue: nativeIdentity.evalFile ?? 'bundled', options: nativeIdentity.options,
            wdlModel: nativeIdentity.options.UCI_ShowWDL === false ? null : nativeIdentity.version!, source: /browser/.test(nativeIdentity.source) ? 'CLIENT_ENGINE' : 'SERVER_ENGINE' }; });
        rebuildPracticeFixture(manifest);
    }
    const node: TrainingSolutionTreeNodeDto = { id: manifest.source.contextId, contextId: manifest.source.contextId,
        fen: manifest.source.fen, positionHistory: [], trainingSide: 'WHITE', role: 'USER', answerIndex: manifest.rootAnswerIndex, ply: 0 };
    manifest.continuation.nodes = [node];
    return { manifest, node };
}
function fakeEngine(score: number | (() => number) = 15, rootScore = 30, rootMove = 'e2e4', runtimeIdentity = identity) {
    const requests: Array<AnalysisLimit & { fen: string; multiPv?: number }> = [];
    let sequence = 0;
    const engine: StockfishEngine = {
        getIdentity: async () => runtimeIdentity,
        evalPosition: vi.fn(),
        analyzeMultiPv: vi.fn(async options => {
            requests.push(options);
            const context = resolveEngineSearchContext(options);
            const move = options.rootMoves?.[0] ?? rootMove;
            const id = `native-${++sequence}`;
            const lines = [10, 11, 12].map((depth, i) => [{ multipv: 1, pvUci: [move], score: { type: 'cp' as const, value: options.rootMoves ? (typeof score === 'function' ? score() : score) : rootScore }, depth, nodes: Math.floor(options.nodes! * [0.25, 0.5, 1][i]) }]);
            const snapshots = lines.map((bundle, i) => createAnalysisSnapshot(id, i, runtimeIdentity, context, { ...options, multiPv: 1 }, bundle)!);
            for (const snapshot of snapshots) {
                options.onSnapshot?.(snapshot);
                if (options.signal?.aborted) throw new Error('Analysis aborted');
            }
            return { fen: options.fen, bestMoveUci: move, lines: lines[2], snapshots,
                searchEvidence: createSearchEvidence(id, runtimeIdentity, context, { ...options, multiPv: 1 }, { nodes: options.nodes }) };
        }),
    };
    return { engine, requests };
}

describe('Practice v4 local grading', () => {
    it('point-first reuses paid recommendation and grades an unknown answer in one completed comparison', async () => {
        const args = fixture(); args.manifest.policyId = T2_ASSESSMENT_POLICY.id; args.manifest.policySnapshot = { ...T2_ASSESSMENT_POLICY };
        args.manifest.frames[0].policyId = T2_ASSESSMENT_POLICY.id; rebuildPracticeFixture(args.manifest); args.node.answerIndex = args.manifest.rootAnswerIndex;
        const { engine, requests } = fakeEngine();
        expect((await gradeUnknownLocalMove({ ...args, engine, moveUci: 'e2e4' })).result).toMatchObject({ quality: 'GOOD' });
        expect(requests).toHaveLength(0);
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3' });
        expect(result.result).toMatchObject({ quality: 'GOOD' });
        expect(requests.map(r => [r.rootMoves, r.nodes])).toEqual([[['g1f3'], 25_000]]);
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch).success).toBe(true);
    });
    it('point-first preserves credit for the immutable offered recommendation after a local counter', () => {
        const args = fixture(); args.manifest.policyId = T2_ASSESSMENT_POLICY.id; args.manifest.policySnapshot = { ...T2_ASSESSMENT_POLICY };
        args.manifest.frames[0].policyId = T2_ASSESSMENT_POLICY.id; rebuildPracticeFixture(args.manifest); args.node.answerIndex = args.manifest.rootAnswerIndex;
        const session = createLocalAnalysisSession();
        const context = resolveEngineSearchContext({ fen: args.node.fen, rootMoves: ['e2e4'] });
        session.pool.recordSnapshot(createBoundAnalysisSnapshot('offered-counter', 0, identity, context, { nodes: 100_000, multiPv: 1 },
            [{ multipv: 1, pvUci: ['e2e4'], depth: 14, nodes: 1000, score: { type: 'cp', value: -500 }, bound: 'UPPER' }])!);
        expect(gradeKnownLocalMove({ ...args, session, moveUci: 'e2e4' })?.result).toMatchObject({ quality: 'GOOD', accepted: true });
        expect(gradeKnownLocalMove({ ...args, session, moveUci: 'd2d4' })).toBeNull();
    });
    it('bounds optional reference preparation and does no work for ready, legacy or cancelled prompts', async () => {
        const args = fixture(); const session = createLocalAnalysisSession(); const { engine, requests } = fakeEngine();
        await prewarmLocalReference({ ...args, engine, session, signal: new AbortController().signal });
        expect(requests).toHaveLength(0);
        args.manifest.policySnapshot = { ...T2_ASSESSMENT_POLICY }; args.manifest.policyId = T2_ASSESSMENT_POLICY.id;
        args.manifest.frames[0].policyId = T2_ASSESSMENT_POLICY.id;
        await prewarmLocalReference({ ...args, engine, session, signal: new AbortController().signal });
        expect(requests).toHaveLength(0);
        args.manifest.assessments = [];
        await prewarmLocalReference({ ...args, engine, session, signal: AbortSignal.abort() });
        expect(requests).toHaveLength(0);
        await prewarmLocalReference({ ...args, engine, session, signal: new AbortController().signal });
        expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ nodes: 100_000, multiPv: 3 });
        expect(requests[0].timeoutMs).toBeLessThanOrEqual(2_000);
        expect(session.pool.find({ fen: args.node.fen, previousFens: [] }).length).toBe(1);
    });
    it('rejects a stale known answer after this session has learned a compatible reference counter', async () => {
        const args = fixture(); const session = createLocalAnalysisSession();
        const context = resolveEngineSearchContext({ fen: args.node.fen, rootMoves: ['e2e4'] });
        session.pool.recordSnapshot(createBoundAnalysisSnapshot('known-reference-counter', 0, identity, context,
            { nodes: 100_000, multiPv: 1 }, [{ multipv: 1, pvUci: ['e2e4'], depth: 14, nodes: 1000,
                score: { type: 'cp', value: -500 }, bound: 'UPPER' }])!);
        expect(gradeKnownLocalMove({ ...args, session, moveUci: 'e2e4' })).toBeNull();
        const engine: StockfishEngine = { getIdentity: vi.fn(async () => identity), evalPosition: vi.fn(),
            analyzeMultiPv: vi.fn().mockRejectedValue(new Error('Unavailable')) };
        const result = await gradeUnknownLocalMove({ ...args, session, engine, moveUci: 'e2e4' });
        expect(engine.analyzeMultiPv).toHaveBeenCalled();
        expect(result.result.status).toBe('UNRESOLVED');
        expect(result.invalidatedKnownQuality).toBe(true);
    });
    it.each(['coherent', 'coherent-point', 'other-artifact', 'other-context'] as const)('keeps the zero-engine known path with %s session data', async kind => {
        const args = fixture(); const session = createLocalAnalysisSession(); const board = new Chess(args.node.fen);
        if (kind === 'other-context') board.move('e4');
        const move = kind === 'other-context' ? 'e7e5' : 'e2e4';
        const context = resolveEngineSearchContext({ fen: board.fen(), rootMoves: [move] });
        const nativeIdentity = kind === 'other-artifact' ? { ...identity, artifactId: 'different-artifact' } : identity;
        session.pool.recordSnapshot(kind === 'coherent-point'
            ? createAnalysisSnapshot('coherent-young-point', 0, nativeIdentity, context,
                { nodes: 100_000, multiPv: 1 }, [{ multipv: 1, pvUci: [move], depth: 14, nodes: 1000, score: { type: 'cp', value: 30 } }])!
            : createBoundAnalysisSnapshot('irrelevant-or-coherent-counter', 0, nativeIdentity, context,
                { nodes: 100_000, multiPv: 1 }, [{ multipv: 1, pvUci: [move], depth: 14, nodes: 1000,
                    score: { type: 'cp', value: kind === 'coherent' ? 50 : -500 }, bound: 'UPPER' }])!);
        const engine = vi.fn(() => fakeEngine().engine);
        const result = await gradeUnknownLocalMove({ ...args, session, engine, moveUci: 'e2e4' });
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(result.source).toBe('PRECOMPUTED');
        expect(engine).not.toHaveBeenCalled();
    });

    it('uses the paid server reference for an unknown browser answer with the same verified artifact', async () => {
        const server: EngineIdentity = { artifactId: STOCKFISH_ARTIFACT_ID, name: 'Stockfish 18 Lite WASM', version: '18.0.8', flavor: 'lite-single-nnue-wasm',
            source: 'stockfish@18.0.8/server/stockfish-18-lite-single', evalFile: 'nn-9067e33176e8.nnue', options: { Threads: 1, Hash: 64, UCI_ShowWDL: true } };
        const browser = { ...server, source: 'stockfish@18.0.8/browser/stockfish-18-lite-single' };
        const args = fixture(true, server); rebuildPracticeFixture(args.manifest);
        const paidEvidence = structuredClone(args.manifest.evidence);
        const { engine, requests } = fakeEngine(15, 30, 'e2e4', browser);
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3' });
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(requests.map(request => ({ roots: request.rootMoves, reason: request.purpose }))).toEqual(Array.from({ length: 2 }, () => ({ roots: ['g1f3'], reason: 'MISSING_MOVE' })));
        expect(result.assessment?.source).toBe('CLIENT_ENGINE');
        expect(args.manifest.evidence).toEqual(paidEvidence);
        expect(Object.values(paidEvidence.searches).every(search => search.engineIdentity.source === 'SERVER_ENGINE')).toBe(true);
        expect(result.assessment!.observationIds.some(id => id in paidEvidence.observations)).toBe(true);
        expect(Object.values(result.patch!.evidence.searches).some(search => search.engineIdentity.source === 'CLIENT_ENGINE')).toBe(true);
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it.each(['artifact', 'nnue', 'options'] as const)('rebuilds the reference when the browser %s differs', async difference => {
        const args = fixture(true, { ...identity, source: 'fixture/server' }); rebuildPracticeFixture(args.manifest);
        const browser = { ...identity, ...(difference === 'artifact' ? { artifactId: 'different-artifact' } : difference === 'nnue' ? { evalFile: 'different.nnue' } : { options: { ...identity.options, Hash: 128 } }) };
        const { engine, requests } = fakeEngine(15, 30, 'e2e4', browser);
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3' });
        expect(requests.map(request => request.rootMoves)).toEqual([undefined, ['e2e4'], ['g1f3'], ['g1f3']]);
        expect(result.result.status).toBe('GRADED');
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it.each([false, true])('requests only usable geometric passes within the cumulative budget (detail=%s)', async refine => {
        const args = fixture(false); const requests: Array<AnalysisLimit & { fen: string; multiPv?: number }> = [];
        const engine: StockfishEngine = { getIdentity: async () => identity, evalPosition: vi.fn(), analyzeMultiPv: async options => {
            requests.push(options); const context = resolveEngineSearchContext(options); const id = `bounds-only-${requests.length}`;
            const moveUci = options.rootMoves?.[0] ?? 'e2e4';
            const snapshot = createBoundAnalysisSnapshot(id, 0, identity, context, { ...options, multiPv: 1 },
                [{ multipv: 1, pvUci: [moveUci], depth: 12, nodes: options.nodes, score: { type: 'cp', value: 30 }, bound: 'LOWER' }])!;
            options.onSnapshot?.(snapshot);
            return { fen: options.fen, bestMoveUci: '', lines: [], snapshots: [snapshot],
                searchEvidence: createSearchEvidence(id, identity, context, { ...options, multiPv: 1 }, { nodes: options.nodes }) };
        } };
        const planner = new AnalysisWorkPlanner({ maxNodes: refine ? 200_000 : 1_500_000, maxWallMs: refine ? 2_000 : 8_000 });
        const result = await gradeUnknownLocalMove({ ...args, engine, planner, moveUci: 'g1f3', refine });
        expect(result.result.status).toBe('UNRESOLVED');
        expect(requests.map(request => request.nodes)).toEqual(refine ? [100_000] : [100_000, 200_000, 400_000, 800_000]);
        expect(requests.every(request => !request.rootMoves)).toBe(true);
        expect(planner.report().requestedNodes).toBe(refine ? 100_000 : 1_500_000);
        expect(requests.every(request => (request.timeoutMs ?? Infinity) <= (refine ? 2_000 : 8_000))).toBe(true);
    });

    it('can stop a 100k request on cheap symbolic mate support without pretending those nodes were consumed', async () => {
        const manifest = structuredClone(WARMUP_MANIFEST); const node = { ...manifest.continuation.nodes[0], ply: 0 };
        const requests: Array<AnalysisLimit & { fen: string; multiPv?: number }> = [];
        const engine: StockfishEngine = { getIdentity: async () => identity, evalPosition: vi.fn(), analyzeMultiPv: async options => {
            requests.push(options); const context = resolveEngineSearchContext(options); const id = `cheap-mate-${requests.length}`;
            const pvUci = options.rootMoves ? ['f7e7', 'h8g8', 'e7g7'] : ['f7g7'];
            const snapshots = [10, 11, 12].map((depth, index) => createAnalysisSnapshot(id, index, identity, context,
                { ...options, multiPv: 1 }, [{ multipv: 1, pvUci, depth, nodes: 100 + index * 100,
                    score: { type: 'mate', value: options.rootMoves ? 2 : 1 } }])!);
            for (const snapshot of snapshots) {
                options.onSnapshot?.(snapshot);
                if (options.signal?.aborted) throw new Error('Stopped after supported mate');
            }
            return { fen: options.fen, bestMoveUci: pvUci[0], lines: snapshots.at(-1)!.lines, snapshots,
                searchEvidence: createSearchEvidence(id, identity, context, { ...options, multiPv: 1 }, { nodes: 300 }) };
        } };
        const planner = new AnalysisWorkPlanner({ maxNodes: 1_500_000, maxWallMs: 8_000 }); const updates = vi.fn();
        const result = await gradeUnknownLocalMove({ manifest, node, engine, planner, moveUci: 'f7e7', onUpdate: updates });
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(result.assessment?.source).toBe('CLIENT_ENGINE');
        expect(requests.map(request => request.nodes)).toEqual([100_000, 100_000]);
        expect(planner.report()).toMatchObject({ requestedNodes: 200_000, reportedNodes: 600 });
        expect(updates.mock.calls[0][0].kind).toBe('LIVE');
        expect(updates.mock.calls.at(-1)![0].kind).toBe('SUPPORTED');
        expect(validatePracticeEvaluationPatch(manifest, result.patch).success).toBe(true);
    });

    it('restores paid supported quality and stops optional work once new points are coherent', async () => {
        const args = fixture(); const updates = vi.fn(); const stopped = vi.fn();
        const engine: StockfishEngine = { getIdentity: async () => identity, evalPosition: vi.fn(), analyzeMultiPv: async options => {
            const context = resolveEngineSearchContext(options);
            const snapshots = [-200, 20, 20, 20].map((value, i) => createAnalysisSnapshot('recover-quality', i, identity, context,
                { ...options, multiPv: 1 }, [{ multipv: 1, pvUci: ['d2d4'], depth: 10 + i, nodes: [5000, 25_000, 50_000, 100_000][i], score: { type: 'cp', value } }])!);
            for (const snapshot of snapshots) {
                options.onSnapshot?.(snapshot);
                if (options.signal?.aborted) { stopped(); throw new Error('Stopped after restored paid quality'); }
            }
            return { fen: options.fen, bestMoveUci: 'd2d4', lines: snapshots.at(-1)!.lines, snapshots,
                searchEvidence: createSearchEvidence('recover-quality', identity, context, { ...options, multiPv: 1 }, { nodes: 100_000 }) };
        } };
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'd2d4', refine: true, onUpdate: updates,
            planner: new AnalysisWorkPlanner({ maxNodes: 100_000, maxWallMs: 5000 }) });
        // The two paid completed groups become usable again when the current
        // three-point tail is coherent; the stopped refinement supplies no new vote.
        expect(updates.mock.calls.filter(([update]) => update.kind !== 'LIVE').map(([update]) => update.kind)).toEqual(['INVALIDATED', 'SUPPORTED']);
        expect(stopped).toHaveBeenCalledOnce();
        expect(result.patch!.evidence.searches['recover-quality'].completion).toBe('STOPPED');
        for (const id of ['search', 'corroborating-search']) {
            expect(args.manifest.evidence.searches[id].completion).toBe('COMPLETED');
            expect(result.assessment!.observationIds.some(observationId => args.manifest.evidence.observations[observationId]?.searchId === id)).toBe(true);
        }
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD', tier: null });
        expect(result.assessment?.qualitySupport).toBe('SUPPORTED');
        expect(result.assessment?.tierSupport).toBe('NONE');
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it('stops optional passes when final search completion restores quality without a stable tier', async () => {
        const args = fixture(); const session = createLocalAnalysisSession(); const requests: number[] = []; const updates = vi.fn();
        const context = resolveEngineSearchContext({ fen: args.node.fen, rootMoves: ['d2d4'] });
        session.pool.recordSnapshot(createBoundAnalysisSnapshot('withdraw-known', 0, identity, context, { nodes: 100_000, multiPv: 1 },
            [{ multipv: 1, pvUci: ['d2d4'], depth: 12, nodes: 1000, score: { type: 'cp', value: -200 }, bound: 'UPPER' }])!);
        const engine: StockfishEngine = { getIdentity: async () => identity, evalPosition: vi.fn(), analyzeMultiPv: async options => {
            requests.push(options.nodes!); const id = `final-only-${requests.length}`;
            const snapshots = [25_000, 100_000].map((nodes, i) => createAnalysisSnapshot(id, i, identity, context, { ...options, multiPv: 1 },
                [{ multipv: 1, pvUci: ['d2d4'], depth: 10 + i * 2, nodes, score: { type: 'cp', value: 20 } }])!);
            snapshots.forEach(snapshot => options.onSnapshot?.(snapshot));
            expect(updates.mock.calls.some(([update]) => update.kind === 'SUPPORTED')).toBe(false);
            return { fen: args.node.fen, bestMoveUci: 'd2d4', lines: snapshots.at(-1)!.lines, snapshots,
                searchEvidence: createSearchEvidence(id, identity, context, { ...options, multiPv: 1 }, { nodes: options.nodes }) };
        } };
        const result = await gradeUnknownLocalMove({ ...args, session, engine, moveUci: 'd2d4', refine: true, onUpdate: updates });
        expect(requests).toEqual([100_000]);
        expect(updates.mock.calls.some(([update]) => update.kind === 'INVALIDATED')).toBe(true);
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD', tier: null });
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it.each([{ points: [10, 35, 601], supported: false }, { points: [10, 35, 25_000], supported: false },
        { points: [25_000, 50_000, 99_999], supported: false },
        { points: [25_000, 50_000, 100_000], supported: true }])('requires a mature pair and the latest policy floor for requested100k work ($points)', async ({ points, supported }) => {
        const actualNodes = points.at(-1)!;
        const args = fixture(); const updates = vi.fn(); const requested: number[] = []; const session = createLocalAnalysisSession();
        const priorContext = resolveEngineSearchContext({ fen: args.node.fen, rootMoves: ['g1f3'] });
        const priorSnapshots = [25_000, 50_000, 100_000].map((nodes, i) => createAnalysisSnapshot('prior-actual-work', i, identity, priorContext,
            { nodes: 100_000, multiPv: 1 }, [{ multipv: 1, pvUci: ['g1f3'], depth: 10 + i, nodes, score: { type: 'cp', value: 15 } }])!);
        session.pool.recordResult({ fen: args.node.fen, bestMoveUci: 'g1f3', lines: priorSnapshots.at(-1)!.lines, snapshots: priorSnapshots,
            searchEvidence: createSearchEvidence('prior-actual-work', identity, priorContext, { nodes: 100_000, multiPv: 1 }, { nodes: 100_000 }) });
        const engine: StockfishEngine = { getIdentity: async () => identity, evalPosition: vi.fn(), analyzeMultiPv: async options => {
            requested.push(options.nodes!); const context = resolveEngineSearchContext(options);
            const snapshots = points.map((nodes, i) => createAnalysisSnapshot('actual-work', i, identity, context,
                { ...options, multiPv: 1 }, [{ multipv: 1, pvUci: ['g1f3'], depth: 10 + i, nodes, score: { type: 'cp', value: 15 } }])!);
            for (const snapshot of snapshots) options.onSnapshot?.(snapshot);
            return { fen: args.node.fen, bestMoveUci: 'g1f3', lines: snapshots.at(-1)!.lines, snapshots,
                searchEvidence: createSearchEvidence('actual-work', identity, context, { ...options, multiPv: 1 }, { nodes: actualNodes }) };
        } };
        const result = await gradeUnknownLocalMove({ ...args, session, engine, moveUci: 'g1f3', onUpdate: updates,
            planner: new AnalysisWorkPlanner({ maxNodes: 100_000, maxWallMs: 5000 }) });
        expect(requested).toEqual([100_000]);
        expect(result.result.status).toBe(supported ? 'GRADED' : 'UNRESOLVED');
        expect(updates.mock.calls.some(([update]) => update.kind === 'SUPPORTED')).toBe(false);
    });
    it('proves an unknown immediate mate with RULE evidence without creating an engine', async () => {
        const manifest = structuredClone(WARMUP_MANIFEST);
        manifest.assessments = manifest.assessments.filter(a => a.moveUci !== 'f7h7');
        manifest.rootAnswerIndex = deriveRootAnswerIndex(manifest, manifest.frames[0], 'f7f8');
        manifest.continuation.nodes[0].answerIndex = manifest.rootAnswerIndex;
        const node = { ...manifest.continuation.nodes[0], ply: 0 };
        const engine = vi.fn(() => { throw new Error('Engine must not start'); });
        const onUpdate = vi.fn();
        const result = await gradeUnknownLocalMove({ manifest, node, moveUci: 'f7h7', engine, onUpdate });
        expect(engine).not.toHaveBeenCalled();
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(result.assessment).toMatchObject({ source: 'RULE', score: { kind: 'EXACT', outcome: 'WIN' } });
        expect(result.comparison).toMatchObject({ bestGapCp: null, bestGapWinChance: null });
        expect(onUpdate.mock.calls.map(([update]) => update.kind)).toEqual(['SUPPORTED']);
        expect(validatePracticeEvaluationPatch(manifest, result.patch)).toMatchObject({ success: true });
        expect(Object.keys(result.patch!.evidence.searches)).toHaveLength(0);
    });
    it('corrects covered bad mate from exact rules and classifies a draw only with an exact reference', async () => {
        const manifest = practicePositionFixture({ fen: WARMUP_MANIFEST.source.fen, originalMoveUci: 'f7e6', bestMoveUci: 'f7f8' });
        manifest.assessments = manifest.assessments.filter(a => a.moveUci !== 'f7h7');
        manifest.coverageGroups = [{ id: 'prior-bad', contextId: manifest.source.contextId, frameId: manifest.frames[0].id,
            movesUci: ['f7h7'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED', evidenceIds: Object.keys(manifest.evidence.observations) }];
        manifest.rootAnswerIndex = deriveRootAnswerIndex(manifest, manifest.frames[0], 'f7f8');
        const node = { id: 'root', ...manifest.source, role: 'USER' as const, answerIndex: manifest.rootAnswerIndex, ply: 0 };
        const engine = vi.fn(() => { throw new Error('Engine must not start'); });
        expect(gradeKnownLocalMove({ manifest, node, moveUci: 'f7h7' })?.result).toMatchObject({ quality: 'BELOW_STANDARD' });
        const corrected = await gradeUnknownLocalMove({ manifest, node, moveUci: 'f7h7', engine, refine: true });
        expect(corrected.result).toMatchObject({ quality: 'GOOD' });
        expect(validatePracticeEvaluationPatch(manifest, corrected.patch)).toMatchObject({ success: true });
        const exact = structuredClone(WARMUP_MANIFEST);
        exact.assessments = exact.assessments.filter(a => a.moveUci !== 'f7e6');
        exact.rootAnswerIndex = deriveRootAnswerIndex(exact, exact.frames[0], 'f7f8');
        const draw = await gradeUnknownLocalMove({ manifest: exact, node: { ...exact.continuation.nodes[0], answerIndex: exact.rootAnswerIndex, ply: 0 }, moveUci: 'f7e6', engine });
        expect(draw.result).toMatchObject({ quality: 'BELOW_STANDARD' });
        expect(draw.assessment).toMatchObject({ source: 'RULE', score: { kind: 'EXACT', outcome: 'DRAW' } });
        expect(validatePracticeEvaluationPatch(exact, draw.patch)).toMatchObject({ success: true });
        expect(engine).not.toHaveBeenCalled();
        // A terminal draw alone cannot prove whether the previous position was won.
        manifest.assessments = manifest.assessments.filter(a => a.moveUci !== 'f7e6');
        manifest.rootAnswerIndex = deriveRootAnswerIndex(manifest, manifest.frames[0], 'f7f8');
        const fallback = fakeEngine(15, 30, 'f7f8');
        const getEngine = vi.fn(() => fallback.engine);
        await gradeUnknownLocalMove({ manifest, node: { ...node, answerIndex: manifest.rootAnswerIndex }, moveUci: 'f7e6', engine: getEngine });
        expect(getEngine).toHaveBeenCalledOnce();
    });
    it('returns known quality synchronously and performs zero searches even with an uncertain tier', async () => {
        const args = fixture(); const { engine, requests } = fakeEngine();
        const known = args.manifest.assessments.find(item => item.moveUci === 'd2d4')!;
        known.tier = null; known.tierSupport = 'NONE'; known.pending.push('TIER');
        expect(gradeKnownLocalMove({ ...args, moveUci: 'd2d4' })?.result).toMatchObject({ status: 'GRADED', quality: 'GOOD', tier: null });
        await gradeUnknownLocalMove({ ...args, engine, moveUci: 'd2d4' });
        expect(requests).toHaveLength(0);
    });
    it('withdraws known quality only when compatible new evidence vetoes it, not on ordinary engine failure', async () => {
        const args = fixture();
        const failing = fakeEngine().engine;
        failing.analyzeMultiPv = vi.fn().mockRejectedValue(new Error('offline'));
        const unavailable = await gradeUnknownLocalMove({ ...args, engine: failing, moveUci: 'd2d4', refine: true });
        expect(unavailable.invalidatedKnownQuality).not.toBe(true);
        const refuting: StockfishEngine = { ...failing, analyzeMultiPv: vi.fn(async options => {
            const context = resolveEngineSearchContext(options);
            options.onSnapshot?.(createBoundAnalysisSnapshot('counter', 0, identity, context, { ...options, multiPv: 1 },
                [{ multipv: 1, pvUci: ['d2d4'], depth: 14, nodes: 1000, score: { type: 'cp', value: -200 }, bound: 'UPPER' }])!);
            throw new Error('budget exhausted after counterevidence');
        }) };
        const updates = vi.fn();
        const invalidated = await gradeUnknownLocalMove({ ...args, engine: refuting, moveUci: 'd2d4', refine: true, onUpdate: updates });
        expect(invalidated).toMatchObject({ result: { status: 'UNRESOLVED' }, invalidatedKnownQuality: true });
        expect(updates.mock.calls.filter(([update]) => update.kind === 'INVALIDATED')).toHaveLength(1);
        const incompatible = fixture(false);
        const separate = await gradeUnknownLocalMove({ ...incompatible, engine: refuting, moveUci: 'd2d4', refine: true });
        expect(separate.invalidatedKnownQuality).not.toBe(true);
    });
    it('does not infer bad quality from missing top-K and searches only the submitted move with a compatible reference', async () => {
        const args = fixture(); const { engine, requests } = fakeEngine(); const updates = vi.fn();
        expect(gradeKnownLocalMove({ ...args, moveUci: 'g1f3' })).toBeNull();
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3', onUpdate: updates });
        expect(requests.map(request => request.rootMoves)).toEqual([['g1f3'], ['g1f3']]);
        expect(requests.map(request => request.nodes)).toEqual([100_000, 200_000]);
        expect(updates.mock.calls[0][0].kind).toBe('LIVE');
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(updates.mock.calls.some(([update]) => update.kind === 'LIVE')).toBe(true);
        expect(updates.mock.calls.some(([update]) => update.kind === 'SUPPORTED')).toBe(false);
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
        expect(Object.keys(result.patch!.evidence.observations).some(id => Object.hasOwn(args.manifest.evidence.observations, id))).toBe(false);
    });
    it('refreshes a reference refuted by a singleton bound before returning the original bad verdict', async () => {
        const args = fixture(); const session = createLocalAnalysisSession();
        const context = resolveEngineSearchContext({ fen: args.node.fen, rootMoves: ['e2e4'] });
        session.pool.recordSnapshot(createBoundAnalysisSnapshot('reference-counter', 0, identity, context,
            { nodes: 25_000, multiPv: 1 }, [{ multipv: 1, pvUci: ['e2e4'], depth: 14, nodes: 1000,
                score: { type: 'cp', value: -500 }, bound: 'UPPER' }])!);
        const { engine, requests } = fakeEngine(-200); const updates = vi.fn();
        const result = await gradeUnknownLocalMove({ ...args, engine, session, moveUci: 'a2a3', refine: true, onUpdate: updates });
        expect(requests[0]).toMatchObject({ purpose: 'REFERENCE_DRIFT', nodes: 200_000 });
        expect(requests[0].rootMoves).toBeUndefined();
        expect(updates.mock.calls.find(([update]) => update.kind !== 'LIVE')?.[0].kind).toBe('INVALIDATED');
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'BELOW_STANDARD' });
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it('creates one local reference for an incompatible runtime and reuses it for another unknown move', async () => {
        const args = fixture(false); const { engine, requests } = fakeEngine(); const session = createLocalAnalysisSession();
        const first = await gradeUnknownLocalMove({ ...args, engine, session, moveUci: 'g1f3' });
        const second = await gradeUnknownLocalMove({ ...args, engine, session, moveUci: 'b1c3' });
        expect(first.result.status).toBe('GRADED'); expect(second.result.status).toBe('GRADED');
        expect(requests.map(request => request.rootMoves)).toEqual([undefined, ['e2e4'], ['g1f3'], ['g1f3'], ['b1c3'], ['b1c3']]);
        expect(requests.some(request => request.rootMoves?.includes('a2a3'))).toBe(false);
    });
    it('reports a genuinely weak unknown move as subpar after evidence, and keeps timeout neutral', async () => {
        const args = fixture(); const { engine } = fakeEngine(-200);
        expect((await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3' })).result).toMatchObject({ status: 'GRADED', quality: 'BELOW_STANDARD', tier: 'SUBPAR' });
        const failed = { ...engine, analyzeMultiPv: vi.fn().mockRejectedValue(new Error('unavailable')) };
        expect((await gradeUnknownLocalMove({ ...args, engine: failed, moveUci: 'b1c3' })).result.status).toBe('UNRESOLVED');
    });
    it('gives changed personal conclusions new immutable assessment/frame identities', async () => {
        const args = fixture(); const session = createLocalAnalysisSession();
        let score = 15; const { engine } = fakeEngine(() => score);
        const first = await gradeUnknownLocalMove({ ...args, engine, session, moveUci: 'g1f3' });
        score = 50;
        const later = await engine.analyzeMultiPv({ fen: args.node.fen, nodes: 100_000, multiPv: 1, rootMoves: ['g1f3'],
            onSnapshot: snapshot => session.pool.recordSnapshot(snapshot) });
        session.pool.recordResult(later);
        const refined = await gradeUnknownLocalMove({ ...args, engine, session, moveUci: 'g1f3' });
        expect(first.result).toMatchObject({ quality: 'GOOD', tier: null });
        expect(refined.result).toMatchObject({ quality: 'GOOD', tier: 'BEST' });
        expect(refined.assessment!.id).not.toBe(first.assessment!.id);
        expect(refined.patch!.frame.id).not.toBe(first.patch!.frame.id);
        for (const [id, evidence] of Object.entries(first.patch!.evidence.searches)) expect(refined.patch!.evidence.searches[id]).toEqual(evidence);
        expect(validatePracticeEvaluationPatch(args.manifest, first.patch)).toMatchObject({ success: true });
        expect(validatePracticeEvaluationPatch(args.manifest, refined.patch)).toMatchObject({ success: true });
    });

    it('does not call a repeated UCI in another context the original source move for a coverage group', () => {
        const manifest = practicePositionFixture({ fen: new Chess().fen(), originalMoveUci: 'a2a3', bestMoveUci: 'e2e4',
            continuation: { opponentMoveUci: 'e7e5', userMoveUci: 'g1f3' } });
        const child = manifest.continuation.nodes.find(node => node.role === 'USER' && node.contextId !== manifest.source.contextId)!;
        const node: TrainingSolutionTreeNodeDto = { ...child, ply: 2 };
        manifest.assessments = manifest.assessments.filter(a => a.contextId !== node.contextId || a.moveUci !== 'a2a3');
        manifest.coverageGroups = [{ id: 'child-group', contextId: node.contextId, frameId: child.answerIndex!.frameId,
            movesUci: ['a2a3'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED',
            evidenceIds: Object.values(manifest.evidence.observations).filter(o => o.contextId === node.contextId).map(o => o.id) }];
        node.answerIndex = deriveAnswerIndex({ contextId: node.contextId, frameId: child.answerIndex!.frameId,
            legalMovesUci: child.answerIndex!.legalMovesUci, preferredMoveUci: 'g1f3', assessments: manifest.assessments, coverageGroups: manifest.coverageGroups });
        expect(gradeKnownLocalMove({ manifest, node, moveUci: 'a2a3' })?.result).toMatchObject({ quality: 'BELOW_STANDARD', originalRelation: 'UNKNOWN' });
    });

    it('evaluates an unknown prepared continuation answer with that context’s original surrogate', async () => {
        const manifest = practicePositionFixture({ fen: new Chess().fen(), originalMoveUci: 'a2a3', bestMoveUci: 'e2e4',
            continuation: { opponentMoveUci: 'e7e5', userMoveUci: 'g1f3' } });
        const child = manifest.continuation.nodes.find(node => node.role === 'USER' && node.contextId !== manifest.source.contextId)!;
        const node: TrainingSolutionTreeNodeDto = { ...child, ply: 2 };
        manifest.assessments = manifest.assessments.filter(a => a.contextId !== node.contextId || a.moveUci !== 'b1c3');
        node.answerIndex = deriveAnswerIndex({ contextId: node.contextId, frameId: child.answerIndex!.frameId,
            legalMovesUci: child.answerIndex!.legalMovesUci, preferredMoveUci: 'g1f3', assessments: manifest.assessments, coverageGroups: [] });
        child.answerIndex = node.answerIndex;
        const { engine } = fakeEngine(15, 30, 'g1f3');
        const result = await gradeUnknownLocalMove({ manifest, node, engine, moveUci: 'b1c3' });
        expect(result.result).toMatchObject({ quality: 'GOOD' });
        expect(result.patch!.assessments.find(a => a.id === result.patch!.frame.referenceAssessmentId)?.originalRelation).toBe('SAME_MOVE');
        expect(validatePracticeEvaluationPatch(manifest, result.patch)).toMatchObject({ success: true });
    });

    it('rechecks the probe after a changed root premise instead of futile root doubling', async () => {
        const args = fixture(); const { engine, requests } = fakeEngine(100, 100);
        const published: number[] = [];
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3', onUpdate(update) {
            if (update.kind === 'SUPPORTED') published.push(requests.length);
        } });
        expect(requests.map(request => request.rootMoves)).toEqual([['g1f3'], undefined, ['e2e4'], ['g1f3']]);
        expect(requests.map(request => request.nodes)).toEqual([100_000, 200_000, 400_000, 200_000]);
        expect(requests[2].purpose).toBe('VERIFY_REFERENCE');
        expect(requests[1].purpose).toBe('REFERENCE_DRIFT');
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(published).toEqual([]); // Only the completed final search may resolve this finite answer.
        expect(result.patch?.frame.id).not.toBe(args.manifest.frames[0].id);
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it('keeps good quality immediate while a bounded detail search stabilizes the uncertain tier', async () => {
        const args = fixture();
        Object.values(args.manifest.evidence.observations).forEach(observation => {
            const line = observation.lines.find(line => line.moveUci === 'd2d4');
            if (line) line.score = { kind: 'CP', cp: [10, -10, 0][observation.snapshotIndex], pov: 'WHITE' };
        });
        rebuildPracticeFixture(args.manifest); args.node.answerIndex = args.manifest.rootAnswerIndex;
        expect(gradeKnownLocalMove({ ...args, moveUci: 'd2d4' })?.result).toMatchObject({ quality: 'GOOD', tier: null });
        const { engine, requests } = fakeEngine(50);
        const refined = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'd2d4', refine: true });
        expect(refined.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(refined.assessment?.tierSupport).toBe('SUPPORTED');
        expect(requests.map(request => request.rootMoves)).toEqual([['d2d4']]);
    });
    it('keeps known group quality when an incompatible engine cannot corroborate a correction within the detail budget', async () => {
        const args = fixture(false);
        for (const observation of Object.values(args.manifest.evidence.observations)) {
            const line = observation.lines.find(line => line.moveUci === 'd2d4');
            if (line) line.score = { kind: 'CP', cp: -200, pov: 'WHITE' };
        }
        rebuildPracticeFixture(args.manifest);
        args.manifest.assessments = args.manifest.assessments.filter(a => a.moveUci !== 'd2d4');
        args.manifest.coverageGroups = [{ id: 'group', contextId: args.node.contextId, frameId: args.manifest.frames[0].id,
            movesUci: ['d2d4'], conclusion: 'BELOW_STANDARD', basis: 'ALL_SCOPE_ASSESSED', evidenceIds: Object.keys(args.manifest.evidence.observations) }];
        args.manifest.rootAnswerIndex = deriveRootAnswerIndex(args.manifest, args.manifest.frames[0], args.manifest.rootAnswerIndex.preferredMoveUci);
        args.node.answerIndex = args.manifest.rootAnswerIndex;
        const initial = gradeKnownLocalMove({ ...args, moveUci: 'd2d4' });
        expect(initial?.result).toMatchObject({ quality: 'BELOW_STANDARD', tier: null });
        const { engine, requests } = fakeEngine();
        const refined = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'd2d4', refine: true });
        expect(refined.result).toMatchObject({ status: 'UNRESOLVED' });
        expect(refined.invalidatedKnownQuality).not.toBe(true);
        expect(gradeKnownLocalMove({ ...args, moveUci: 'd2d4' })?.result).toMatchObject({ quality: 'BELOW_STANDARD', tier: null });
        expect(requests.reduce((total, request) => total + (request.nodes ?? 0), 0)).toBeLessThanOrEqual(200_000);
        expect(requests.every(request => (request.timeoutMs ?? 0) <= 2_000)).toBe(true);
        expect(refined.patch).toBeNull();
    });
    it('does not run a continuation from an explanation PV or a different accepted branch', () => {
        const args = fixture();
        expect(localContinuationForMove({ ...args, moveUci: 'd2d4' })).toBeNull();
    });
});
