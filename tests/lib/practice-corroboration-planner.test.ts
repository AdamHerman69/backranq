import { describe, expect, it, vi } from 'vitest';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { gradeUnknownLocalMove, type LocalGradingUpdate } from '@/lib/training/localGrading';
import { AnalysisWorkPlanner } from '@/lib/analysis/analysisWorkPlanner';
import { practiceEngineFingerprint } from '@/lib/analysis/practiceEvidence';
import { createAnalysisSnapshot, createBoundAnalysisSnapshot, createSearchEvidence, resolveEngineSearchContext,
    type AnalysisLimit, type EngineIdentity, type StockfishEngine } from '@/lib/analysis/stockfishClient';
import { parsePracticeMomentRevision, validatePracticeEvaluationPatch } from '@/lib/training/practiceContract';
import type { TrainingSolutionTreeNodeDto } from '@/lib/training/api';

const identity: EngineIdentity = { artifactId: 'corroboration-fixture', name: 'Corroboration fixture', version: '18', source: 'fixture/browser', options: { UCI_ShowWDL: false } };
function position() {
    const manifest = practiceV4Fixture(); const fingerprint = practiceEngineFingerprint(identity);
    manifest.frames.forEach(frame => { frame.engineFingerprint = fingerprint; });
    Object.values(manifest.evidence.observations).forEach(observation => { observation.engineFingerprint = fingerprint; });
    for (const search of Object.values(manifest.evidence.searches)) search.engineIdentity = {
        fingerprint, artifactId: identity.artifactId, name: identity.name, build: identity.version!, nnue: 'bundled',
        options: identity.options, wdlModel: null, source: 'SERVER_ENGINE',
    };
    rebuildPracticeFixture(manifest);
    const canonicalNode = { id: manifest.source.contextId, contextId: manifest.source.contextId,
        fen: manifest.source.fen, positionHistory: [], trainingSide: 'WHITE' as const, role: 'USER' as const, answerIndex: manifest.rootAnswerIndex };
    const node: TrainingSolutionTreeNodeDto = { ...canonicalNode, ply: 0 };
    manifest.continuation.nodes = [canonicalNode];
    rebuildPracticeFixture(manifest);
    parsePracticeMomentRevision(manifest);
    return { manifest, node };
}
function engineFixture(mode: 'BOUND' | 'POINT', changedArtifact = false, actualNodeCap = Infinity) {
    const runtimeIdentity = changedArtifact ? { ...identity, artifactId: 'different-artifact' } : identity;
    const requests: Array<AnalysisLimit & { fen: string; multiPv?: number }> = [];
    const engine: StockfishEngine = { getIdentity: async () => runtimeIdentity, evalPosition: vi.fn(), analyzeMultiPv: async options => {
        requests.push(options);
        const id = `corroboration-search-${requests.length}`; const context = resolveEngineSearchContext(options);
        const move = options.rootMoves?.[0] ?? 'e2e4';
        const actualNodes = Math.min(options.nodes!, actualNodeCap);
        const snapshots = mode === 'BOUND'
            ? [createBoundAnalysisSnapshot(id, 0, runtimeIdentity, context, options, [{ multipv: 1, pvUci: [move],
                score: { type: 'cp', value: 15 }, bound: 'LOWER', depth: 12, nodes: actualNodes }])!]
            : [10, 11, 12].map((depth, index) => createAnalysisSnapshot(id, index, runtimeIdentity, context, options,
                [{ multipv: 1, pvUci: [move], score: { type: 'cp', value: options.rootMoves ? 15 : 30 },
                    depth, nodes: Math.floor(actualNodes * [0.25, 0.5, 1][index]) }])!);
        for (const snapshot of snapshots) {
            options.onSnapshot?.(snapshot);
            if (options.signal?.aborted) throw new Error('Analysis aborted');
        }
        const lines = mode === 'POINT' ? snapshots.at(-1)!.lines : [];
        return { fen: options.fen, bestMoveUci: lines[0]?.pvUci[0] ?? '', lines, snapshots,
            searchEvidence: createSearchEvidence(id, runtimeIdentity, context, options, { nodes: actualNodes }) };
    } };
    return { engine, requests };
}

describe('local corroboration uses the original cumulative budget', () => {
    function withoutProbe() {
        const args = position();
        const probeIds = Object.values(args.manifest.evidence.searches).filter(search =>
            search.request.rootScopeUci.length === 1 && search.request.rootScopeUci[0] === 'e2e4').map(search => search.id);
        expect(probeIds.length).toBeGreaterThan(0);
        for (const id of probeIds) {
            for (const observationId of args.manifest.evidence.searches[id].observationIds) delete args.manifest.evidence.observations[observationId];
            delete args.manifest.evidence.searches[id];
        }
        rebuildPracticeFixture(args.manifest);
        args.node.answerIndex = args.manifest.rootAnswerIndex;
        return args;
    }
    it('verifies the paid reference once, then starts the independent answer ladder at 100k', async () => {
        const args = withoutProbe(); const { engine, requests } = engineFixture('POINT');
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3' });
        expect(requests.map(request => [request.purpose, request.rootMoves, request.nodes])).toEqual([
            ['VERIFY_REFERENCE', ['e2e4'], 400_000],
            ['MISSING_MOVE', ['g1f3'], 100_000],
            ['MISSING_MOVE', ['g1f3'], 200_000],
        ]);
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(validatePracticeEvaluationPatch(args.manifest, result.patch)).toMatchObject({ success: true });
    });
    it('does not spend optional detail on unrelated jobs when the missing proof costs 400k', async () => {
        const args = withoutProbe(); const { engine, requests } = engineFixture('POINT');
        const planner = new AnalysisWorkPlanner({ maxNodes: 200_000, maxWallMs: 2_000 });
        const result = await gradeUnknownLocalMove({ ...args, engine, planner, moveUci: 'g1f3', refine: true });
        expect(requests).toEqual([]);
        expect(planner.report().requestedNodes).toBe(0);
        expect(result.result.status).toBe('UNRESOLVED');
    });
    it('does not loop the same insufficient 399999-actual probe or start unrelated answer work', async () => {
        const args = withoutProbe(); const { engine, requests } = engineFixture('POINT', false, 399_999);
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3' });
        expect(requests.map(request => [request.purpose, request.nodes])).toEqual([['VERIFY_REFERENCE', 400_000]]);
        expect(result.result.status).toBe('UNRESOLVED');
    });

    it('reaches the 800k singleton pass when all 1.5M nodes remain available to the answer', async () => {
        const { engine, requests } = engineFixture('BOUND');
        const planner = new AnalysisWorkPlanner({ maxNodes: 1_500_000, maxWallMs: 8_000 });
        const result = await gradeUnknownLocalMove({ ...position(), engine, planner, moveUci: 'g1f3' });
        expect(requests.map(request => request.nodes)).toEqual([100_000, 200_000, 400_000, 800_000]);
        expect(requests.every(request => request.rootMoves?.[0] === 'g1f3')).toBe(true);
        expect(planner.report().requestedNodes).toBe(1_500_000);
        expect(result.result.status).toBe('UNRESOLVED');
    });
    it('spends only the reference ladder when no usable root exists', async () => {
        const { engine, requests } = engineFixture('BOUND', true);
        const planner = new AnalysisWorkPlanner({ maxNodes: 1_500_000, maxWallMs: 8_000 });
        const result = await gradeUnknownLocalMove({ ...position(), engine, planner, moveUci: 'g1f3' });
        expect(requests.map(request => request.nodes)).toEqual([100_000, 200_000, 400_000, 800_000]);
        expect(requests.every(request => !request.rootMoves)).toBe(true);
        expect(planner.report().requestedNodes).toBe(1_500_000);
        expect(result.result.status).toBe('UNRESOLVED');
    });
    it('keeps optional detail within 200k rather than granting it the larger ordinary pass', async () => {
        const { engine, requests } = engineFixture('BOUND');
        const planner = new AnalysisWorkPlanner({ maxNodes: 200_000, maxWallMs: 2_000 });
        await gradeUnknownLocalMove({ ...position(), engine, planner, moveUci: 'g1f3', refine: true });
        expect(requests.map(request => request.nodes)).toEqual([100_000]);
        expect(planner.report().requestedNodes).toBeLessThanOrEqual(200_000);
    });
    it('waits for two completed finite searches and returns their final supported patch', async () => {
        const { engine, requests } = engineFixture('POINT'); const args = position(); const updates: LocalGradingUpdate[] = [];
        const result = await gradeUnknownLocalMove({ ...args, engine, moveUci: 'g1f3', onUpdate: update => updates.push(update) });
        expect(requests.map(request => request.nodes)).toEqual([100_000, 200_000]);
        // During both searches the latest physical record is STOPPED; support
        // only becomes available after the second completed result is recorded.
        expect(updates.filter(update => update.kind === 'SUPPORTED')).toEqual([]);
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        const validation = validatePracticeEvaluationPatch(args.manifest, result.patch);
        expect(validation, JSON.stringify(validation)).toMatchObject({ success: true });
    });
    it('leaves a single completed finite answer neutral when its reservation is exhausted', async () => {
        const { engine, requests } = engineFixture('POINT'); const updates: LocalGradingUpdate[] = [];
        const planner = new AnalysisWorkPlanner({ maxNodes: 100_000, maxWallMs: 8_000 });
        const result = await gradeUnknownLocalMove({ ...position(), engine, planner, moveUci: 'g1f3', onUpdate: update => updates.push(update) });
        expect(requests).toHaveLength(1);
        expect(updates.some(update => update.kind === 'SUPPORTED')).toBe(false);
        expect(result.result.status).toBe('UNRESOLVED');
    });
    it('does not initialize an engine for a known answer', async () => {
        const engine = vi.fn(() => engineFixture('POINT').engine);
        const result = await gradeUnknownLocalMove({ ...position(), engine, moveUci: 'e2e4' });
        expect(result.result).toMatchObject({ status: 'GRADED', quality: 'GOOD' });
        expect(engine).not.toHaveBeenCalled();
    });
});
