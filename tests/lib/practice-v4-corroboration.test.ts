import { describe, expect, it } from 'vitest';
import historical from '../fixtures/practice-v4-corroboration-failures.json';
import { createAssessmentEvaluator, deriveDecisionAssessment } from '@/lib/training/assessmentPolicy';
import { DEFAULT_ASSESSMENT_POLICY, parsePracticeMomentRevision, type ComparisonFrame, type EvidenceStore } from '@/lib/training/practiceContract';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';

const evaluate = (revision: ReturnType<typeof practiceV4Fixture>, moveUci = 'a2a3') => createAssessmentEvaluator(revision.evidence)(revision.frames[0], {
    id: 'answer', moveUci, trainingSide: 'WHITE', referenceMoveUci: 'e2e4', originalMoveUci: 'a2a3',
}, revision.policySnapshot);

describe('finite comparisons require consecutive physical corroboration', () => {
    it('requires the explicit registered search-count field', () => {
        const revision = practiceV4Fixture() as unknown as { policySnapshot: Record<string, unknown> };
        delete revision.policySnapshot.minimumCompletedSupportingSearches;
        expect(() => parsePracticeMomentRevision(revision)).toThrow(/minimumCompletedSupportingSearches/);
    });
    it('one complete mature search cannot corroborate itself, while reference remains usable', () => {
        const revision = practiceV4Fixture();
        for (const id of revision.evidence.searches['corroborating-search'].observationIds) delete revision.evidence.observations[id];
        delete revision.evidence.searches['corroborating-search'];
        expect(evaluate(revision)).toMatchObject({ quality: 'UNKNOWN', qualitySupport: 'PROVISIONAL' });
        expect(evaluate(revision, 'e2e4')).toMatchObject({ quality: 'GOOD', qualitySupport: 'SUPPORTED' });
    });
    it('two independently mature groups support and cite both physical records', () => {
        const revision = practiceV4Fixture(); const answer = evaluate(revision);
        expect(answer).toMatchObject({ quality: 'BELOW_STANDARD', qualitySupport: 'SUPPORTED' });
        expect(new Set(answer.observationIds.map(id => revision.evidence.observations[id].searchId)).size).toBe(3);
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
    });
    it.each(['STOPPED', 'UNKNOWN', 'OPPOSITE', 'IMMATURE'] as const)('cannot skip an intervening %s physical point group', state => {
        const revision = practiceV4Fixture(); const middle = structuredClone(revision.evidence.searches.search);
        middle.id = 'middle'; middle.sequence = 1; middle.observationIds = [];
        revision.evidence.searches.search.sequence = 2;
        revision.evidence.searches['reference-probe'].sequence = 3;
        if (state === 'STOPPED') middle.completion = 'STOPPED';
        for (const id of revision.evidence.searches.search.observationIds) {
            const point = structuredClone(revision.evidence.observations[id]);
            point.id = `middle-${id}`; point.searchId = middle.id;
            if (state === 'IMMATURE') point.nodes = 10;
            if (state === 'UNKNOWN' || state === 'OPPOSITE') point.lines.find(l => l.moveUci === 'a2a3')!.score = { kind: 'CP', cp: state === 'UNKNOWN' ? -10 : 20, pov: 'WHITE' };
            middle.observationIds.push(point.id); revision.evidence.observations[point.id] = point;
        }
        revision.evidence.searches.middle = middle;
        expect(evaluate(revision).quality).toBe('UNKNOWN');
    });
    it('does not borrow older completion for a new stopped search', () => {
        const revision = practiceV4Fixture(); revision.evidence.searches.search.completion = 'STOPPED';
        expect(evaluate(revision).quality).toBe('UNKNOWN');
    });
    it('a prior group needs its own mature pair, not just a mature terminal point', () => {
        const revision = practiceV4Fixture();
        for (const id of revision.evidence.searches['corroborating-search'].observationIds.slice(0, 2)) revision.evidence.observations[id].nodes = 10;
        expect(evaluate(revision).quality).toBe('UNKNOWN');
    });
    it('new reference values re-evaluate both groups instead of freezing an old vote', () => {
        const revision = practiceV4Fixture();
        for (const point of Object.values(revision.evidence.observations)) {
            const original = point.lines.find(l => l.moveUci === 'a2a3');
            if (original) original.score = { kind: 'CP', cp: -200, pov: 'WHITE' };
        }
        // Both finite groups were BELOW against +30; a new losing reference makes
        // that old conclusion unusable, and global drift still catches better d4.
        for (const point of Object.values(revision.evidence.observations)) point.lines.find(l => l.moveUci === 'e2e4')!.score = { kind: 'CP', cp: -250, pov: 'WHITE' };
        expect(evaluate(revision).quality).toBe('UNKNOWN');
    });
    it.each(historical)('withdraws real single/stopped-search false verdict $index/$moveUci', trace => {
        const frame = { ...trace.frame, policyId: DEFAULT_ASSESSMENT_POLICY.id } as ComparisonFrame;
        const evidence = trace.evidence as unknown as EvidenceStore; const evaluator = createAssessmentEvaluator(evidence);
        const input = { id: 'historical', moveUci: trace.moveUci, trainingSide: trace.source.trainingSide as 'WHITE' | 'BLACK', referenceMoveUci: trace.referenceMoveUci, originalMoveUci: trace.source.originalMoveUci };
        const answer = evaluator(frame, input);
        expect(answer.quality).toBe('UNKNOWN');
        if (trace.index === 48) {
            const reference = evaluator(frame, { ...input, id: frame.referenceAssessmentId, moveUci: trace.referenceMoveUci });
            expect(deriveDecisionAssessment({ original: answer, reference, frame, evidence, minimumConfirmationNodes: 200_000 }).status).toBe('UNRESOLVED');
        }
    });
    it('fixtures regenerate a valid new semantic contract after evidence changes', () => {
        const revision = practiceV4Fixture();
        rebuildPracticeFixture(revision);
        expect(() => parsePracticeMomentRevision(revision)).not.toThrow();
    });
});
