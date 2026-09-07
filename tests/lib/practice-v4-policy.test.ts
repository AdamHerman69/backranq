import { describe, expect, it } from 'vitest';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { assessMove, assessReferenceDrift, createAssessmentEvaluator, detectPracticeReferenceDrift, deriveDecisionAssessment, toleranceCp } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, type PracticeScore, type Wdl } from '@/lib/training/practiceContract';

function assessCp(bestCp: number, moveCp: number, wdl?: { best: Wdl; move: Wdl }) {
    const revision = practiceV4Fixture(); const frame = revision.frames[0];
    frame.model = wdl ? 'MATCHED_WDL' : 'CP_ONLY';
    if (wdl) for (const search of Object.values(revision.evidence.searches)) search.engineIdentity.wdlModel = 'stockfish-18';
    for (const observation of Object.values(revision.evidence.observations)) {
        observation.lines[0].score = { kind: 'CP', cp: bestCp, pov: 'WHITE' };
        if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: moveCp, pov: 'WHITE' };
        if (observation.lines[2]) observation.lines[2].score = { kind: 'CP', cp: Math.min(bestCp, moveCp) - 500, pov: 'WHITE' };
        if (wdl) { observation.lines[0].wdl = wdl.best; if (observation.lines[1]) observation.lines[1].wdl = wdl.move; }
    }
    const input = { id: 'answer', moveUci: 'd2d4', trainingSide: 'WHITE' as const, referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: revision.evidence };
    return { revision, frame, input, result: assessMove(frame, input) };
}
describe('Practice v4 policy and empirical support', () => {
    it('a restricted reference counter vetoes every comparison until a new full-root point restores reference', () => {
        const revision = practiceV4Fixture(); const frame = revision.frames[0];
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: -300, pov: 'WHITE' };
        const appendReference = (id: string, sequence: number, full: boolean, bound: boolean) => {
            const search = structuredClone(revision.evidence.searches.search); search.id = id; search.sequence = sequence; search.request.multiPv = 1;
            search.request.rootScopeUci = full ? [...revision.rootAnswerIndex.legalMovesUci] : ['e2e4'];
            const observation = structuredClone(revision.evidence.observations['observation-2']);
            Object.assign(observation, { id: `${id}-point`, searchId: id, snapshotIndex: 0, depth: 12 + sequence, nodes: 100_000,
                requestedMultiPv: 1, completedSlots: 1, bundleComplete: !bound, rootScopeUci: [...search.request.rootScopeUci] });
            observation.lines = [{ ...observation.lines[0], bound: bound ? 'UPPER' : 'UNBOUNDED', score: { kind: 'CP', cp: bound ? -500 : 30, pov: 'WHITE' } }];
            search.observationIds = [];
            for (let i = 0; i < (bound ? 1 : 3); i++) {
                const point = structuredClone(observation);
                if (!bound) { point.id = `${id}-point-${i}`; point.snapshotIndex = i; point.depth += i; point.nodes = [25_000, 50_000, 100_000][i]; }
                search.observationIds.push(point.id); revision.evidence.observations[point.id] = point;
            }
            revision.evidence.searches[id] = search;
        };
        const evaluate = (moveUci: string) => assessMove(frame, { id: `answer-${moveUci}`, moveUci, trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: revision.evidence });
        expect(evaluate('a2a3').quality).toBe('BELOW_STANDARD');
        appendReference('counter', 3, false, true);
        for (const moveUci of ['e2e4', 'a2a3', 'd2d4']) {
            expect(evaluate(moveUci).quality).toBe('UNKNOWN');
            expect(evaluate(moveUci).observationIds).toContain('counter-point');
        }
        rebuildPracticeFixture(revision); expect(revision.decision.status).toBe('UNRESOLVED');
        appendReference('restricted-point', 4, false, false);
        expect(evaluate('a2a3').quality).toBe('UNKNOWN');
        appendReference('full-point', 5, true, false);
        expect(evaluate('e2e4').quality).toBe('GOOD');
        for (const moveUci of ['a2a3', 'd2d4']) {
            expect(evaluate(moveUci).quality).toBe('BELOW_STANDARD');
            expect(evaluate(moveUci).observationIds).not.toContain('counter-point');
        }
        rebuildPracticeFixture(revision); expect(revision.decision.status).toBe('CONFIRMED_MISTAKE');
    });

    it.each([
        ['d2d4', 'UPPER', -200, 'WHITE', 'UNKNOWN'],
        ['a2a3', 'LOWER', 200, 'WHITE', 'UNKNOWN'],
        ['d2d4', 'LOWER', 200, 'BLACK', 'UNKNOWN'],
        ['d2d4', 'UPPER', 40, 'WHITE', 'GOOD'],
        ['d2d4', 'LOWER', 0, 'WHITE', 'GOOD'],
        ['a2a3', 'UPPER', -180, 'WHITE', 'BELOW_STANDARD'],
        ['a2a3', 'LOWER', -220, 'WHITE', 'BELOW_STANDARD'],
    ] as const)('new bound %s %s %i (%s) preserves only compatible support', (moveUci, bound, cp, pov, quality) => {
        const revision = practiceV4Fixture();
        const observation = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(observation, { id: 'bounded', snapshotIndex: 3, depth: 13, nodes: 100_000 });
        Object.assign(observation.lines.find(line => line.moveUci === moveUci)!, { bound, score: { kind: 'CP', cp, pov } });
        revision.evidence.observations.bounded = observation; revision.evidence.searches.search.observationIds.push('bounded');
        const result = assessMove(revision.frames[0], { id: 'answer', moveUci, trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: revision.evidence });
        expect(result.quality).toBe(quality);
        expect(result.observationIds).toContain('bounded');
        expect(result.score).toEqual({ kind: 'CP', cp: moveUci === 'd2d4' ? 20 : -200, pov: 'WHITE' });
        if (quality === 'UNKNOWN') expect(result.qualitySupport).not.toBe('SUPPORTED');
    });
    it('a lower bound proving a better move invalidates reference but an upper bound does not prove improvement', () => {
        const revision = practiceV4Fixture(); const frame = revision.frames[0];
        const observation = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(observation, { id: 'bounded', snapshotIndex: 3, depth: 13, nodes: 100_000 });
        const line = observation.lines[1]; Object.assign(line, { bound: 'LOWER', score: { kind: 'CP', cp: 200, pov: 'WHITE' } });
        revision.evidence.observations.bounded = observation; revision.evidence.searches.search.observationIds.push('bounded');
        const input = { evidence: revision.evidence, frame, trainingSide: 'WHITE' as const, referenceMoveUci: 'e2e4' };
        expect(detectPracticeReferenceDrift(input)?.moveUci).toBe('d2d4');
        line.bound = 'UPPER'; expect(detectPracticeReferenceDrift(input)).toBeNull();
        frame.model = 'MATCHED_WDL'; revision.evidence.searches.search.engineIdentity.wdlModel = 'actual-stockfish';
        for (const point of Object.values(revision.evidence.observations)) for (const pointLine of point.lines) pointLine.wdl = { win: 100, draw: 800, loss: 100 };
        line.bound = 'LOWER'; line.wdl = null;
        expect(detectPracticeReferenceDrift(input)?.moveUci).toBe('d2d4');
    });
    it('keeps stronger active counters until a fresh point supersedes transient bounds', () => {
        const revision = practiceV4Fixture(); const frame = revision.frames[0];
        for (const [index, cp] of [[3, -200], [4, 40]] as const) {
            const observation = structuredClone(revision.evidence.observations['observation-2']);
            Object.assign(observation, { id: `counter-${index}`, snapshotIndex: index, depth: 10 + index, nodes: 100_000, bundleComplete: false, completedSlots: 1 });
            observation.lines = [{ ...observation.lines[1], bound: 'UPPER', score: { kind: 'CP', cp, pov: 'WHITE' } }];
            revision.evidence.observations[observation.id] = observation; revision.evidence.searches.search.observationIds.push(observation.id);
        }
        const input = { id: 'answer', moveUci: 'd2d4', trainingSide: 'WHITE' as const, referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: revision.evidence };
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
        const fresh = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(fresh, { id: 'fresh-point', snapshotIndex: 5, depth: 15, nodes: 100_000 });
        revision.evidence.observations[fresh.id] = fresh; revision.evidence.searches.search.observationIds.push(fresh.id);
        expect(assessMove(frame, input).quality).toBe('GOOD');
    });
    it('mate outcome loss is supported BELOW_STANDARD instead of invalidating a winning reference', () => {
        const revision = practiceV4Fixture();
        for (const observation of Object.values(revision.evidence.observations)) for (const line of observation.lines)
            line.score = { kind: 'MATE', plies: 5, winner: line.moveUci === 'a2a3' ? 'BLACK' : 'WHITE', pov: 'WHITE' };
        const result = assessMove(revision.frames[0], { id: 'answer', moveUci: 'a2a3', trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence: revision.evidence });
        expect(result).toMatchObject({ quality: 'BELOW_STANDARD', qualitySupport: 'SUPPORTED' });
        rebuildPracticeFixture(revision);
        expect(revision.decision).toMatchObject({ status: 'CONFIRMED_MISTAKE', selection: 'INCLUDED', selectionSignal: 'EXACT_OUTCOME_LOSS' });
        expect(result.source).toBe('SERVER_ENGINE'); expect(result.metrics.lossCp).toBeNull();
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[2]) observation.lines[2].score = { kind: 'MATE', plies: 25, winner: 'WHITE', pov: 'WHITE' };
        rebuildPracticeFixture(revision);
        expect(revision.decision).toMatchObject({ status: 'NOT_A_MISTAKE', selection: 'OMITTED', selectionSignal: 'NONE' });
        expect(assessReferenceDrift({ kind: 'MATE', plies: 5, winner: 'BLACK', pov: 'WHITE' }, { kind: 'MATE', plies: 5, winner: 'WHITE', pov: 'WHITE' }, null, null)).toBe(true);
    });

    it.each([[20, -130, 'BELOW_STANDARD'], [320, 250, 'GOOD'], [400, 200, 'GOOD'], [400, -200, 'BELOW_STANDARD'], [-400, -2000, 'BELOW_STANDARD']] as const)('adaptive CP branch %i to %i -> %s', (best, move, quality) => {
        expect(assessCp(best, move).result.quality).toBe(quality);
        expect(assessCp(best, move).result.qualitySupport).toBe('SUPPORTED');
    });
    it('uses the bounded adaptive tolerance', () => {
        expect([-400, 20, 320, 400, 1000].map(cp => toleranceCp(cp))).toEqual([100, 100, 192, 240, 300]);
    });
    it('requires actual WDL in matched mode and does not invent it from cp', () => {
        const { frame, input } = assessCp(400, 200); frame.model = 'MATCHED_WDL';
        input.evidence.searches.search.engineIdentity.wdlModel = 'stockfish-18';
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('will not bypass contradictory WDL via CP_ONLY', () => {
        const { frame, input } = assessCp(320, 250, { best: { win: 950, draw: 40, loss: 10 }, move: { win: 200, draw: 400, loss: 400 } });
        expect(assessMove(frame, input).quality).toBe('BELOW_STANDARD');
        frame.model = 'CP_ONLY'; expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('a missing WDL metric leaves UNKNOWN even when CP suggests rejection', () => {
        const { frame, input } = assessCp(400, -200, { best: { win: 950, draw: 40, loss: 10 }, move: { win: 200, draw: 400, loss: 400 } });
        for (const o of Object.values(input.evidence.observations)) if (o.lines[1]) o.lines[1].wdl = null;
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('quality survives an uncertain exact tier', () => {
        const result = assessCp(30, 20).result;
        expect(result.quality).toBe('GOOD'); expect(result.qualitySupport).toBe('SUPPORTED');
        expect(result.tier).toBeNull(); expect(result.pending).toContain('TIER'); expect(result.pending).not.toContain('QUALITY');
    });
    it('requires coherent reference verification instead of accepting an unstable self-comparison', () => {
        const { frame, input } = assessCp(400, 200);
        expect(assessMove(frame, { ...input, moveUci: 'e2e4' })).toMatchObject({ quality: 'GOOD', tier: 'BEST', metrics: { lossCp: 0 } });
        for (const [i, observation] of Object.values(input.evidence.observations).entries()) observation.lines[0].score = { kind: 'CP', cp: 400 + i * 100, pov: 'WHITE' };
        const result = assessMove(frame, { ...input, moveUci: 'e2e4' });
        expect(result.quality).toBe('UNKNOWN'); expect(result.tier).toBeNull(); expect(result.metrics.lossCp).toBeLessThan(0);
    });
    it('keeps boundary cases unknown even if every nominal point agrees', () => {
        const result = assessCp(0, -90).result;
        expect(result.quality).toBe('UNKNOWN'); expect(result.qualitySupport).toBe('PROVISIONAL');
    });
    it('uses depth 10+12 and rejects intervening disagreement', () => {
        const { frame, input } = assessCp(0, -200);
        expect(assessMove(frame, input).quality).toBe('BELOW_STANDARD');
        input.evidence.observations['observation-1'].lines[1].score = { kind: 'CP', cp: -20, pov: 'WHITE' };
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('one search completion/cache replay does not prove convergence', () => {
        const { frame, input } = assessCp(0, -200);
        input.evidence.observations = { 'observation-2': input.evidence.observations['observation-2'] };
        expect(assessMove(frame, input).qualitySupport).toBe('PROVISIONAL');
    });
    it('negative losses stay visible and material reference drift requests new support', () => {
        const result = assessCp(0, 100).result;
        expect(result.metrics.lossCp).toBe(-100); expect(result.quality).toBe('UNKNOWN');
    });
    it('a newly better singleton invalidates reference self-support and other previously good answers', () => {
        const { frame, input } = assessCp(30, 20);
        const observation = structuredClone(input.evidence.observations['observation-2']);
        observation.id = 'singleton'; observation.searchId = 'singleton-search'; observation.snapshotIndex = 0;
        observation.rootScopeUci = ['b1c3']; observation.requestedMultiPv = observation.completedSlots = 1;
        observation.lines = [{ ...observation.lines[0], moveUci: 'b1c3', pvUci: ['b1c3'], score: { kind: 'CP', cp: 200, pov: 'WHITE' } }];
        input.evidence.observations.singleton = observation;
        const search = structuredClone(input.evidence.searches.search); search.id = observation.searchId; search.sequence = Math.max(...Object.values(input.evidence.searches).map(item => item.sequence)) + 1;
        search.observationIds = ['singleton']; search.request.rootScopeUci = ['b1c3']; search.request.multiPv = 1;
        input.evidence.searches[search.id] = search;
        expect(detectPracticeReferenceDrift({ ...input, frame })).toMatchObject({ moveUci: 'b1c3', observationId: 'singleton' });
        expect(assessMove(frame, { ...input, moveUci: 'e2e4' }).qualitySupport).toBe('PROVISIONAL');
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('a lower outcome never invalidates an already known mating reference', () => {
        const { frame, input } = assessCp(0, -200);
        for (const observation of Object.values(input.evidence.observations)) {
            observation.lines[0].score = { kind: 'MATE', winner: 'WHITE', plies: 3, pov: 'WHITE' };
            if (observation.lines[1]) observation.lines[1].score = { kind: 'MATE', winner: 'BLACK', plies: 3, pov: 'WHITE' };
        }
        expect(detectPracticeReferenceDrift({ ...input, frame })).toBeNull();
        expect(assessMove(frame, { ...input, moveUci: 'e2e4' }).quality).toBe('GOOD');
    });
    it('batch assessment holds an immutable invocation snapshot without stale global caching', () => {
        const { frame, input } = assessCp(30, 20);
        const batch = createAssessmentEvaluator(input.evidence);
        for (const observation of Object.values(input.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: 200, pov: 'WHITE' };
        expect(batch(frame, input).quality).toBe('GOOD');
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('reference reorder among comparable alternatives does not discard support', () => {
        const { frame, input } = assessCp(30, 20);
        for (const o of Object.values(input.evidence.observations)) if (o.lines.length === 3) o.lines = [o.lines[1], o.lines[0], o.lines[2]];
        expect(assessMove(frame, input).quality).toBe('GOOD');
    });
    it('new best outside old top-K invalidates a materially stale reference', () => {
        const { frame, input } = assessCp(0, -200);
        const newest = structuredClone(input.evidence.observations['observation-2']);
        newest.id = 'new'; newest.snapshotIndex = 3; newest.depth = 14;
        newest.lines[0] = { ...newest.lines[0], moveUci: 'b1c3', pvUci: ['b1c3'], score: { kind: 'CP', cp: 200, pov: 'WHITE' } };
        input.evidence.observations.new = newest; input.evidence.searches.search.observationIds.push('new');
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('mate provenance preserves another mating win without synthetic CP', () => {
        const { frame, input } = assessCp(0, -200);
        for (const o of Object.values(input.evidence.observations)) {
            o.lines[0].score = { kind: 'MATE', plies: 3, winner: 'WHITE', pov: 'WHITE' };
            if (o.lines[1]) o.lines[1].score = { kind: 'MATE', plies: 9, winner: 'WHITE', pov: 'WHITE' };
        }
        const result = assessMove(frame, input);
        expect(result.quality).toBe('GOOD'); expect(result.metrics.lossCp).toBeNull();
        input.evidence.observations['observation-2'].lines[1].score = { kind: 'CP', cp: 900, pov: 'WHITE' };
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('normalizes both scores and real WDL to the training side', () => {
        const { frame, input } = assessCp(0, -200);
        for (const o of Object.values(input.evidence.observations)) for (const l of o.lines) {
            if (l.score.kind === 'CP') l.score = { kind: 'CP', cp: -l.score.cp, pov: 'BLACK' };
        }
        expect(assessMove(frame, input).quality).toBe('BELOW_STANDARD');
    });
    it('a saturated CP-only swing does not become a feed selection', () => {
        const { revision, frame, input, result } = assessCp(400, -200);
        const reference = assessMove(frame, { ...input, id: frame.referenceAssessmentId, moveUci: 'e2e4' });
        const decision = deriveDecisionAssessment({ original: result, reference, frame, evidence: revision.evidence, minimumConfirmationNodes: 100_000 });
        expect(decision.status).toBe('CONFIRMED_MISTAKE'); expect(decision.selection).toBe('OMITTED'); expect(decision.selectionReason).toBe('SATURATED_CP_ONLY_SIGNAL');
    });
    it('quality does not wait for evaluation of the original game move', () => {
        const { frame, input } = assessCp(320, 250);
        const result = assessMove(frame, { ...input, originalMoveUci: 'b1c3' });
        expect(result.quality).toBe('GOOD'); expect(result.originalRelation).toBe('UNKNOWN'); expect(result.pending).toContain('ORIGINAL_COMPARISON');
    });
    it('mixed exact/engine scores require another shared basis', () => {
        const cp: PracticeScore = { kind: 'CP', cp: 300, pov: 'WHITE' };
        const mate: PracticeScore = { kind: 'MATE', plies: 3, winner: 'WHITE', pov: 'WHITE' };
        expect(assessReferenceDrift(cp, mate, null, null, DEFAULT_ASSESSMENT_POLICY)).toBe(true);
    });
});

describe('rule-exact outcomes', () => {
    it('independently verifies mate versus stalemate without engine cp', async () => {
        const { practiceContextId } = await import('@/lib/training/practiceContract');
        const fen = '7k/8/5KQ1/8/8/8/8/8 w - - 0 1';
        const revision = practiceV4Fixture(); const contextId = practiceContextId(fen, [], 'WHITE');
        const evidence = { searches: {}, observations: {}, exact: {
            rule: { id: 'rule', contextId, fen, positionHistory: [], trainingSide: 'WHITE' as const, source: 'RULE' as const, provider: 'chess.js', rules: 'FIDE' as const, complete: true, rootScopeUci: ['g6g7', 'f6e7'], results: [{ moveUci: 'g6g7', outcome: 'WIN' as const, distance: 1 }, { moveUci: 'f6e7', outcome: 'DRAW' as const, distance: null }] },
        } };
        const frame = { ...revision.frames[0], contextId, model: 'EXACT_OUTCOME' as const };
        const input = { id: 'exact-answer', moveUci: 'f6e7', trainingSide: 'WHITE' as const, referenceMoveUci: 'g6g7', originalMoveUci: 'f6e7', evidence };
        const result = assessMove(frame, input);
        expect(result.quality).toBe('BELOW_STANDARD'); expect(result.qualitySupport).toBe('SUPPORTED'); expect(result.metrics.preservesExactOutcome).toBe(false); expect(result.metrics.lossCp).toBeNull();
        evidence.exact.rule.results[1].outcome = 'WIN';
        expect(assessMove(frame, input).quality).toBe('UNKNOWN');
    });
    it('dictionary reorder does not change convergence or resurrect an old contrary snapshot', () => {
        const { frame, input } = assessCp(0, -200);
        input.evidence.observations['observation-2'].lines[1].score = { kind: 'CP', cp: -20, pov: 'WHITE' };
        const before = assessMove(frame, input);
        input.evidence.observations = Object.fromEntries(Object.entries(input.evidence.observations).reverse());
        expect(assessMove(frame, input)).toEqual(before);
        expect(before.quality).toBe('UNKNOWN');
    });
});
