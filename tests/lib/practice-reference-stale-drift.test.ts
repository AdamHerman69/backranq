import { describe, expect, it } from 'vitest';
import { createAssessmentEvaluator, validObservation } from '@/lib/training/assessmentPolicy';
import type { ComparisonFrame, EvidenceStore, ObservationLine, PracticeMomentRevision } from '@/lib/training/practiceContract';
import actualFixture from '../fixtures/practice-v4-stale-reference-drift.json';
import { practiceV4Fixture } from '../helpers/practice-v4';

const line = (moveUci: string, cp: number, bound: ObservationLine['bound'] = 'UNBOUNDED', pov: 'WHITE' | 'BLACK' = 'WHITE'): ObservationLine => ({
    moveUci, score: { kind: 'CP', cp, pov }, bound, wdl: null, pvUci: [moveUci],
});

/** Scripted physical groups. No claim that these synthetic scores came from Stockfish. */
function group(moment: PracticeMomentRevision, id: string, options: {
    single?: boolean; score?: number; completion?: 'COMPLETED' | 'STOPPED'; retire?: boolean;
} = {}) {
    const { single = false, score = 20, completion = 'COMPLETED', retire = true } = options;
    const evidence = moment.evidence;
    const search = structuredClone(evidence.searches.search);
    const template = evidence.observations['observation-0'];
    search.id = id;
    search.sequence = Math.max(...Object.values(evidence.searches).map(record => record.sequence)) + 1;
    search.completion = completion;
    search.request.multiPv = single ? 1 : 2;
    search.reason = 'MISSING_MOVE'; search.observationIds = [];
    if (single) search.request.rootScopeUci = ['d2d4'];
    for (let index = 0; index < 3; index++) {
        const observation = structuredClone(template);
        observation.id = `${id}:${index}`; observation.searchId = id; observation.snapshotIndex = index;
        observation.depth = 10 + index;
        observation.rootScopeUci = [...search.request.rootScopeUci];
        observation.requestedMultiPv = search.request.multiPv;
        observation.completedSlots = search.request.multiPv;
        observation.nodes = (single ? [25_000, 50_000, 100_000] : [1_000, 2_000, 3_000])[index];
        observation.lines = single ? [line('d2d4', score)] : [line('e2e4', 30), index === 0 || !retire ? line('d2d4', 200) : line('a2a3', -200)];
        search.observationIds.push(observation.id); evidence.observations[observation.id] = observation;
    }
    evidence.searches[id] = search;
    for (const id of search.observationIds) expect(validObservation(evidence.observations[id], evidence)).toBe(true);
    return search;
}
const drift = (moment: PracticeMomentRevision) => createAssessmentEvaluator(moment.evidence).detectReferenceDrift({
    frame: moment.frames[0], trainingSide: 'WHITE', referenceMoveUci: 'e2e4',
});

describe('reference drift retirement within a completed physical search', () => {
    it('removes actual index30 stale e1g1 veto while retaining current root bound and paid probe', () => {
        // Whole original records, IDs, sequences, observations, bounds, PVs and
        // history are preserved; provenance records original artifact SHA256.
        const evidence = structuredClone(actualFixture.evidence) as unknown as EvidenceStore;
        const frame = actualFixture.frame as ComparisonFrame;
        const evaluator = createAssessmentEvaluator(evidence);
        const args = { frame, trainingSide: 'WHITE' as const, referenceMoveUci: 'd5e4' };
        expect(Object.keys(evidence.searches)).toHaveLength(5);
        expect(evaluator.detectReferenceDrift(args)).toBeNull();
        const ready = evaluator.referenceReadiness(args);
        expect(ready.status).toBe('READY');
        expect(ready.probeSearchId).toBe('1788790672898-2650b6c74c3518');
        const boundId = '1788790827454-b0e14894b0ce78:snapshot:20';
        expect(ready.evidenceIds).toContain(boundId);
        expect(evidence.observations[boundId].lines[0].bound).toBe('UPPER');
        // Retirement does not delete or reinterpret the original fleeting point.
        const stale = evidence.observations['1788790811245-d925e8ef92e18:snapshot:4'];
        expect(stale.nodes).toBe(7_504);
        expect(stale.lines.find(line => line.moveUci === 'e1g1')?.score).toEqual({ kind: 'CP', cp: -57, pov: 'WHITE' });
    });

    it('does not replace an earlier compatible mature singleton with a retired later root point', () => {
        const moment = practiceV4Fixture();
        group(moment, 'prior', { single: true, score: 20 }); group(moment, 'retired');
        expect(drift(moment)).toBeNull();
    });

    it('preserves an earlier stronger singleton counter when a newer root point retires', () => {
        const moment = practiceV4Fixture();
        group(moment, 'prior', { single: true, score: 200 }); group(moment, 'retired');
        expect(drift(moment)?.observationId).toBe('prior:2');
    });

    it('retains later directional counters in either score POV', () => {
        for (const [cp, bound, pov] of [[200, 'LOWER', 'WHITE'], [-200, 'UPPER', 'BLACK']] as const) {
            const moment = practiceV4Fixture(); const search = group(moment, 'retired');
            const observation = structuredClone(moment.evidence.observations['retired:2']);
            observation.id = 'counter'; observation.snapshotIndex = 3; observation.depth = 13;
            observation.bundleComplete = false; observation.completedSlots = 1;
            observation.lines = [line('d2d4', cp, bound, pov)];
            search.observationIds.push(observation.id); moment.evidence.observations[observation.id] = observation;
            expect(validObservation(observation, moment.evidence)).toBe(true);
            expect(drift(moment)?.observationId).toBe('counter');
        }
    });

    it('does not give an unfinished STOPPED search final-membership retirement authority', () => {
        const moment = practiceV4Fixture(); group(moment, 'unfinished', { completion: 'STOPPED' });
        expect(drift(moment)?.observationId).toBe('unfinished:0');
    });

    it('keeps a still-present shallow point as counterevidence', () => {
        const moment = practiceV4Fixture(); group(moment, 'present', { retire: false });
        expect(moment.evidence.observations['present:2'].nodes).toBe(3_000);
        expect(drift(moment)?.observationId).toBe('present:2');
    });

    it('does not use invalid later bundles to retire a valid earlier counter', () => {
        const moment = practiceV4Fixture(); group(moment, 'invalid-later');
        for (const id of ['invalid-later:1', 'invalid-later:2']) moment.evidence.observations[id].lines[1].pvUci = ['a2a3', 'a2a3'];
        expect(validObservation(moment.evidence.observations['invalid-later:2'], moment.evidence)).toBe(false);
        expect(drift(moment)?.observationId).toBe('invalid-later:0');
    });

    it('lets an actual later complete point supersede its transient bound', () => {
        const moment = practiceV4Fixture(); const search = group(moment, 'recovered', { retire: false });
        for (const id of search.observationIds) moment.evidence.observations[id].lines[1] = line('d2d4', 20);
        const observation = structuredClone(moment.evidence.observations['recovered:0']);
        observation.id = 'old-bound'; observation.snapshotIndex = 0; observation.depth = 9;
        observation.bundleComplete = false; observation.completedSlots = 1;
        observation.lines = [line('d2d4', 200, 'LOWER')];
        for (const id of search.observationIds) moment.evidence.observations[id].snapshotIndex += 1;
        search.observationIds.unshift(observation.id); moment.evidence.observations[observation.id] = observation;
        expect(validObservation(observation, moment.evidence)).toBe(true);
        expect(drift(moment)).toBeNull();
    });
});
