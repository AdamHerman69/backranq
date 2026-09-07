import { describe, expect, it } from 'vitest';
import { createPracticeValidationFacts } from '@/lib/training/practiceValidationFacts';
import historical from '../fixtures/practice-v4-maturity-index25.json';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { assessMove, createAssessmentEvaluator, detectPracticeReferenceDrift } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, type ComparisonFrame, type EvidenceStore } from '@/lib/training/practiceContract';

const inputFor = (evidence: EvidenceStore, moveUci = 'd2d4') => ({ id: 'test-assessment', moveUci, trainingSide: 'WHITE' as const,
    referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3', evidence });

describe('Engine support requires current, mature physical evidence', () => {
    it('shares chess facts without caching mutated evidence validity or drift', () => {
        const revision = practiceV4Fixture(); const facts = createPracticeValidationFacts();
        const first = createAssessmentEvaluator(revision.evidence, facts);
        const args = { frame: revision.frames[0], trainingSide: 'WHITE' as const, referenceMoveUci: 'e2e4' };
        expect(first(args.frame, inputFor(revision.evidence)).quality).toBe('GOOD');
        expect(first.detectReferenceDrift(args)).toBeNull();
        for (const point of Object.values(revision.evidence.observations)) if (point.lines[1]) point.lines[1].score = { kind: 'CP', cp: 500, pov: 'WHITE' };
        const second = createAssessmentEvaluator(revision.evidence, facts);
        expect(second.detectReferenceDrift(args)?.moveUci).toBe('d2d4');
        expect(second(args.frame, inputFor(revision.evidence)).quality).toBe('UNKNOWN');
        expect(first.detectReferenceDrift(args)).toBeNull();
        for (const point of Object.values(revision.evidence.observations)) if (point.lines[1]) point.lines[1].pvUci = ['d2d4', 'd4d5'];
        expect(createAssessmentEvaluator(revision.evidence, facts)(args.frame, inputFor(revision.evidence)).quality).toBe('UNKNOWN');
    });
    it.each(['scope', 'pv', 'bound', 'completion'])('fact hits never preserve evidence authority after a %s mutation', mutation => {
        const revision = practiceV4Fixture(); const facts = createPracticeValidationFacts();
        const evaluate = () => createAssessmentEvaluator(revision.evidence, facts)(revision.frames[0], inputFor(revision.evidence));
        expect(evaluate().quality).toBe('GOOD');
        if (mutation === 'completion') revision.evidence.searches.search.completion = 'FAILED';
        for (const point of Object.values(revision.evidence.observations)) {
            if (mutation === 'scope') point.rootScopeUci = ['e2e4'];
            if (mutation === 'pv' && point.lines[1]) point.lines[1].pvUci = ['d2d4', 'd4d5'];
            if (mutation === 'bound' && point.lines[1]) { point.lines[1].bound = 'UPPER'; point.lines[1].score = { kind: 'CP', cp: -200, pov: 'WHITE' }; }
        }
        expect(evaluate().quality).toBe('UNKNOWN');
    });
    it.each([[10, -200, 'BELOW_STANDARD'], [35, 20, 'GOOD'], [601, -200, 'BELOW_STANDARD']] as const)('does not grade a requested 25k singleton after only %i actual nodes', (nodes, cp, expected) => {
        const revision = practiceV4Fixture();
        const search = structuredClone(revision.evidence.searches.search);
        Object.assign(search, { id: 'local', sequence: Math.max(...Object.values(revision.evidence.searches).map(item => item.sequence)) + 1, reportedNodes: nodes, completion: 'STOPPED', observationIds: [] });
        search.request = { ...search.request, rootScopeUci: ['g1f3'], multiPv: 1,
            limit: { nodes: 25_000, depth: null, movetimeMs: null } };
        revision.evidence.searches.local = search;
        for (let i = 0; i < 3; i++) {
            const point = structuredClone(revision.evidence.observations[`observation-${i}`]);
            Object.assign(point, { id: `local-${i}`, searchId: 'local', snapshotIndex: i, depth: i + 1, nodes,
                rootScopeUci: ['g1f3'], requestedMultiPv: 1, completedSlots: 1 });
            point.lines = [{ ...point.lines[1], moveUci: 'g1f3', pvUci: ['g1f3'], score: { kind: 'CP', cp, pov: 'WHITE' } }];
            search.observationIds.push(point.id); revision.evidence.observations[point.id] = point;
        }
        expect(assessMove(revision.frames[0], inputFor(revision.evidence, 'g1f3')).quality).toBe('UNKNOWN');
        // Completing a larger search alone cannot mature its old shallow points.
        search.reportedNodes = 100_000; search.completion = 'COMPLETED';
        expect(assessMove(revision.frames[0], inputFor(revision.evidence, 'g1f3')).quality).toBe('UNKNOWN');
        revision.evidence.observations['local-2'].nodes = 100_000;
        expect(assessMove(revision.frames[0], inputFor(revision.evidence, 'g1f3')).quality).toBe('UNKNOWN');
        revision.evidence.observations['local-0'].nodes = 25_000;
        // This previously unobserved move still needs a second mature physical
        // group; no earlier answer proof can be retained for it.
        const confirmation = structuredClone(search); confirmation.id = 'local-confirmation'; confirmation.sequence = search.sequence + 1; confirmation.observationIds = [];
        for (const id of search.observationIds) {
            const point = structuredClone(revision.evidence.observations[id]);
            point.id = `confirmed-${id}`; point.searchId = confirmation.id;
            confirmation.observationIds.push(point.id); revision.evidence.observations[point.id] = point;
        }
        revision.evidence.searches[confirmation.id] = confirmation;
        expect(assessMove(revision.frames[0], inputFor(revision.evidence, 'g1f3')).quality).toBe(expected);
    });
    it('requires actual search work for reference as well as the submitted move', () => {
        const revision = practiceV4Fixture(); const input = inputFor(revision.evidence);
        revision.evidence.searches.search.reportedNodes = 601;
        expect(assessMove(revision.frames[0], input).quality).toBe('UNKNOWN');
        revision.evidence.searches.search.reportedNodes = 99_999;
        expect(assessMove(revision.frames[0], input).quality).toBe('UNKNOWN');
        revision.evidence.searches.search.reportedNodes = 100_000;
        expect(assessMove(revision.frames[0], input).quality).toBe('GOOD');
    });
    it('rejects actual index25 early alternatives absent from their latest physical root bundle', () => {
        const evidence = structuredClone(historical.evidence) as EvidenceStore;
        const frame = { ...historical.frame, policyId: DEFAULT_ASSESSMENT_POLICY.id } as ComparisonFrame;
        const referenceMoveUci = 'g2g3';
        for (const moveUci of ['a3a4', 'g2g4', 'h2h3']) {
            const result = assessMove(frame, { id: moveUci, moveUci, trainingSide: 'WHITE', referenceMoveUci,
                originalMoveUci: historical.source.originalMoveUci, evidence });
            expect(result.quality).toBe('UNKNOWN');
            expect(result.qualitySupport).toBe('PROVISIONAL');
            // Keep the real old score for live/diagnostic display; no false BAD.
            expect(result.score?.kind).toBe('CP');
            expect(result.observationIds.length).toBeGreaterThan(0);
        }
        // The retained historical reference itself predates the new 100k floor;
        // preserve its actual counts rather than inventing stronger evidence.
        expect(assessMove(frame, { id: 'reference', moveUci: referenceMoveUci, trainingSide: 'WHITE', referenceMoveUci,
            originalMoveUci: historical.source.originalMoveUci, evidence }).quality).toBe('UNKNOWN');
    });
    it('a mature alternative still loses support when absent from its newest complete bundle', () => {
        const revision = practiceV4Fixture();
        Object.values(revision.evidence.observations).forEach((point, index) => { point.nodes = 100_000; point.depth = 8 + index * 2; });
        expect(assessMove(revision.frames[0], inputFor(revision.evidence)).quality).toBe('GOOD');
        revision.evidence.observations['observation-2'].lines[1] = { moveUci: 'c2c4', score: { kind: 'CP', cp: -200, pov: 'WHITE' }, bound: 'UNBOUNDED', wdl: null, pvUci: ['c2c4'] };
        expect(assessMove(revision.frames[0], inputFor(revision.evidence)).quality).toBe('UNKNOWN');
        expect(assessMove(revision.frames[0], inputFor(revision.evidence, 'e2e4')).quality).toBe('GOOD');
    });
    it('a later narrow search does not erase mature evidence from another physical search', () => {
        const revision = practiceV4Fixture();
        const search = structuredClone(revision.evidence.searches.search); search.id = 'next'; search.sequence = Math.max(...Object.values(revision.evidence.searches).map(item => item.sequence)) + 1;
        search.request.rootScopeUci = ['a2a3']; search.request.multiPv = 1; search.observationIds = ['next'];
        const point = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(point, { id: 'next', searchId: 'next', snapshotIndex: 0, requestedMultiPv: 1, completedSlots: 1, rootScopeUci: ['a2a3'] });
        point.lines = [point.lines[2]]; revision.evidence.searches.next = search; revision.evidence.observations.next = point;
        expect(assessMove(revision.frames[0], inputFor(revision.evidence)).quality).toBe('GOOD');
    });
    it('immature counterevidence still refutes mature quality and reference', () => {
        const revision = practiceV4Fixture(); const frame = revision.frames[0];
        const counter = structuredClone(revision.evidence.observations['observation-2']);
        Object.assign(counter, { id: 'counter', snapshotIndex: 3, nodes: 10, bundleComplete: false, completedSlots: 1 });
        counter.lines = [{ ...counter.lines[1], bound: 'UPPER', score: { kind: 'CP', cp: -500, pov: 'WHITE' } }];
        revision.evidence.observations.counter = counter; revision.evidence.searches.search.observationIds.push('counter');
        expect(assessMove(frame, inputFor(revision.evidence)).quality).toBe('UNKNOWN');
        counter.lines[0].bound = 'LOWER'; counter.lines[0].score = { kind: 'CP', cp: 500, pov: 'WHITE' };
        expect(detectPracticeReferenceDrift({ frame, evidence: revision.evidence, trainingSide: 'WHITE', referenceMoveUci: 'e2e4' })?.moveUci).toBe('d2d4');
    });
});
