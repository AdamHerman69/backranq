import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { assessPracticeReferenceReadiness, createAssessmentEvaluator } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, legalMovesUci, parsePracticeMomentRevision, practiceContextId, type EvidenceStore, type PracticeMomentRevision } from '@/lib/training/practiceContract';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { practicePositionFixture } from '../helpers/practice-position';

function ready(m: PracticeMomentRevision) {
    return assessPracticeReferenceReadiness({ evidence: m.evidence, frame: m.frames[0], trainingSide: m.source.trainingSide,
        referenceMoveUci: m.rootAnswerIndex.preferredMoveUci, policy: m.policySnapshot });
}
function append(m: PracticeMomentRevision, id: string, options: { cp: number; nodes?: number; scope?: 'ROOT' | 'PROBE'; completion?: 'COMPLETED' | 'STOPPED'; depth?: number }) {
    const root = options.scope === 'ROOT';
    const search = structuredClone(m.evidence.searches[root ? 'search' : 'reference-probe']);
    search.id = id; search.sequence = Math.max(...Object.values(m.evidence.searches).map(s => s.sequence)) + 1;
    search.observationIds = []; search.reportedNodes = options.nodes ?? 400_000;
    search.request.limit.nodes = search.reportedNodes; search.completion = options.completion ?? 'COMPLETED';
    m.evidence.searches[id] = search;
    for (let i = 0; i < 3; i++) {
        const o = structuredClone(m.evidence.observations[root ? 'observation-0' : 'probe-observation-0']);
        o.id = `${id}-${i}`; o.searchId = id; o.snapshotIndex = i; o.depth = (options.depth ?? 14) + i;
        o.nodes = Math.floor(search.reportedNodes * (i + 1) / 3);
        o.lines[0].score = { kind: 'CP', cp: options.cp, pov: 'WHITE' };
        search.observationIds.push(o.id); m.evidence.observations[o.id] = o;
    }
    return search;
}
function dropProbe(evidence: EvidenceStore) {
    for (const id of evidence.searches['reference-probe'].observationIds) delete evidence.observations[id];
    delete evidence.searches['reference-probe'];
}

describe('completed focused current-reference readiness', () => {
    it('requires one coherent full root plus a distinct actual 400k probe, not two full roots', () => {
        const m = practiceV4Fixture();
        for (const id of m.evidence.searches['corroborating-search'].observationIds) delete m.evidence.observations[id];
        delete m.evidence.searches['corroborating-search'];
        expect(ready(m)).toMatchObject({ status: 'READY', requiredWork: null, rootSearchId: 'search', probeSearchId: 'reference-probe' });
        dropProbe(m.evidence);
        expect(ready(m)).toMatchObject({ status: 'MISSING_REFERENCE_PROBE', requiredWork: 'REFERENCE_PROBE', rootSearchId: 'search' });
        const evaluate = createAssessmentEvaluator(m.evidence);
        for (const moveUci of ['e2e4', 'd2d4', 'a2a3']) expect(evaluate(m.frames[0], { id: moveUci, moveUci,
            trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3' }).quality).toBe('UNKNOWN');
    });
    it('never treats requested 400k, a stopped search, wrong scope or an immature point pair as paid proof', () => {
        for (const kind of ['actual', 'stopped', 'scope', 'maturity'] as const) {
            const m = practiceV4Fixture(); const probe = m.evidence.searches['reference-probe'];
            if (kind === 'actual') { probe.reportedNodes = 399_999; m.evidence.observations[probe.observationIds[2]].nodes = 399_999; }
            if (kind === 'stopped') probe.completion = 'STOPPED';
            if (kind === 'scope') probe.request.multiPv = 2;
            if (kind === 'maturity') for (const id of probe.observationIds) m.evidence.observations[id].nodes = 20_000;
            expect(ready(m).status, kind).toBe('MISSING_REFERENCE_PROBE');
        }
    });
    it('reuses a coherent paid probe regardless of reason and newer harmless cheap/stopped/immature detail', () => {
        for (const options of [{ nodes: 50_000 }, { nodes: 50_000, completion: 'STOPPED' as const }, { nodes: 400_000, depth: 1 }]) {
            const m = practiceV4Fixture(); m.evidence.searches['reference-probe'].reason = 'MISSING_MOVE';
            const detail = append(m, 'detail', { cp: 30, ...options });
            if (options.depth === 1) for (const id of detail.observationIds) m.evidence.observations[id].depth = 1;
            expect(ready(m)).toMatchObject({ status: 'READY', probeSearchId: 'reference-probe' });
            const result = createAssessmentEvaluator(m.evidence)(m.frames[0], { id: 'self', moveUci: 'e2e4',
                trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3' });
            expect(result).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
        }
    });
    it('retains negative and positive newer value counterevidence across stopped/cheap searches and every comparison', () => {
        for (const cp of [-100, 100]) {
            const m = practiceV4Fixture(); const counter = append(m, 'counter', { cp, nodes: 10_000, completion: 'STOPPED' });
            expect(ready(m).status).toBe('REFERENCE_VALUE_DRIFT');
            const evaluate = createAssessmentEvaluator(m.evidence);
            for (const moveUci of ['e2e4', 'd2d4', 'a2a3']) {
                const assessment = evaluate(m.frames[0], { id: moveUci, moveUci, trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3' });
                expect(assessment.quality).toBe('UNKNOWN');
                expect(assessment.observationIds).toEqual(expect.arrayContaining(counter.observationIds));
            }
        }
    });
    it('rechecks a changed root premise without erasing the old contradictory probe or repeatedly refreshing roots', () => {
        const m = practiceV4Fixture(); append(m, 'discovery', { cp: 100, nodes: 100_000 });
        expect(ready(m)).toMatchObject({ status: 'REFERENCE_VALUE_DRIFT', requiredWork: 'ROOT' });
        append(m, 'refreshed-root', { cp: 100, nodes: 200_000, scope: 'ROOT' });
        expect(ready(m)).toMatchObject({ status: 'REFERENCE_VALUE_DRIFT', requiredWork: 'REFERENCE_PROBE', rootSearchId: 'refreshed-root' });
        append(m, 'verified-new-value', { cp: 100 });
        expect(ready(m)).toMatchObject({ status: 'READY', requiredWork: null, probeSearchId: 'verified-new-value' });
    });
    it('does not confuse identical scopes in a one-legal-move position with the same physical proof', () => {
        const m = practiceV4Fixture(); const fen = '7k/8/6K1/8/8/8/8/7R b - - 0 1';
        const legal = legalMovesUci(fen); expect(legal).toHaveLength(1);
        const contextId = practiceContextId(fen, [], 'BLACK');
        m.source = { ...m.source, fen, contextId, trainingSide: 'BLACK', originalMoveUci: legal[0] };
        m.frames[0].contextId = contextId; m.rootAnswerIndex.preferredMoveUci = legal[0];
        for (const search of Object.values(m.evidence.searches)) {
            search.contextId = contextId; search.request = { ...search.request, fen, trainingSide: 'BLACK', rootScopeUci: legal, multiPv: 1 };
        }
        for (const observation of Object.values(m.evidence.observations)) {
            observation.contextId = contextId; observation.rootScopeUci = legal; observation.requestedMultiPv = 1; observation.completedSlots = 1;
            observation.lines = [{ moveUci: legal[0], score: { kind: 'CP', cp: 30, pov: 'BLACK' }, bound: 'UNBOUNDED', wdl: null, pvUci: legal }];
        }
        expect(ready(m)).toMatchObject({ status: 'READY', rootSearchId: 'search', probeSearchId: 'reference-probe' });
    });
    it('enforces the same finite readiness for an opponent node without changing context training-side binding', () => {
        const m = practicePositionFixture({ fen: new Chess().fen(), originalMoveUci: 'a2a3', bestMoveUci: 'g1f3',
            continuation: { opponentMoveUci: 'b8c6', userMoveUci: 'e2e4' } });
        expect(() => parsePracticeMomentRevision(m)).not.toThrow();
        const opponent = m.continuation.nodes.find(node => node.role === 'OPPONENT')!;
        const probe = Object.values(m.evidence.searches).find(search => search.contextId === opponent.contextId && search.reason === 'VERIFY_REFERENCE')!;
        for (const id of probe.observationIds) delete m.evidence.observations[id]; delete m.evidence.searches[probe.id];
        m.assessments = m.assessments.filter(a => a.contextId !== opponent.contextId); m.frames = m.frames.filter(f => f.contextId !== opponent.contextId);
        expect(() => parsePracticeMomentRevision(m)).toThrow('Opponent transition lacks a verified current reference');
    });
    it('retains two adjacent paid answer proofs under a coherent unfinished tail, but never creates a new vote', () => {
        const m = practiceV4Fixture();
        const addAnswer = (id: string, cp: number, nodes: number, completion: 'COMPLETED' | 'STOPPED') => {
            const search = append(m, id, { cp, nodes, completion });
            search.request.rootScopeUci = ['d2d4'];
            for (const id of search.observationIds) {
                const o = m.evidence.observations[id]; o.rootScopeUci = ['d2d4'];
                o.lines[0].moveUci = 'd2d4'; o.lines[0].pvUci = ['d2d4'];
            }
            return search;
        };
        const grade = () => createAssessmentEvaluator(m.evidence)(m.frames[0], { id: 'answer', moveUci: 'd2d4',
            trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3' });
        const tail = addAnswer('young-tail', 20, 1000, 'STOPPED');
        tail.engineIdentity.source = 'CLIENT_ENGINE';
        expect(grade()).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED', source: 'CLIENT_ENGINE' });
        expect(grade().observationIds).toEqual(expect.arrayContaining(tail.observationIds));
        // A later completed search cannot skip the intervening unfinished group
        // to combine itself with the old pair, even though all scores agree.
        addAnswer('one-new-completed', 20, 100_000, 'COMPLETED');
        expect(grade().quality).toBe('UNKNOWN');
        addAnswer('second-new-completed', 20, 200_000, 'COMPLETED');
        expect(grade().quality).toBe('GOOD');
        addAnswer('opposite-completed', -200, 200_000, 'COMPLETED');
        addAnswer('agreeing-again', 20, 400_000, 'COMPLETED');
        expect(grade().quality).toBe('UNKNOWN');
    });
    it.each([-200, -50])('withdraws paid answer support when a young tail contradicts or straddles the quality interval (%i cp)', cp => {
        const m = practiceV4Fixture(); const search = append(m, 'young-answer', { cp, nodes: 1000, completion: 'STOPPED' });
        search.request.rootScopeUci = ['d2d4'];
        for (const id of search.observationIds) {
            const o = m.evidence.observations[id]; o.rootScopeUci = ['d2d4'];
            o.lines[0].moveUci = 'd2d4'; o.lines[0].pvUci = ['d2d4'];
        }
        expect(createAssessmentEvaluator(m.evidence)(m.frames[0], { id: 'answer', moveUci: 'd2d4',
            trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3' }).quality).toBe('UNKNOWN');
    });
    it('binds the new floor strictly to its registered policy snapshot', () => {
        const m = practiceV4Fixture(); expect(() => parsePracticeMomentRevision(m)).not.toThrow();
        expect(DEFAULT_ASSESSMENT_POLICY.minimumReferenceProbeNodes).toBe(400_000);
        m.policySnapshot.minimumReferenceProbeNodes = 1;
        expect(() => parsePracticeMomentRevision(m)).toThrow();
    });
});
