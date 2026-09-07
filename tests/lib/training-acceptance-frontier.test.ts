import { describe, expect, it } from 'vitest';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { assessMove } from '@/lib/training/assessmentPolicy';
import { deriveAnswerIndex, lookupAnswer } from '@/lib/training/answerIndex';
import { type PracticeMomentRevision, validatePracticeMomentRevision } from '@/lib/training/practiceContract';

function project(revision: PracticeMomentRevision) {
    const frame = revision.frames[0];
    const assessments = revision.assessments.map(a => assessMove(frame, { id: a.id, moveUci: a.moveUci, trainingSide: revision.source.trainingSide, referenceMoveUci: revision.rootAnswerIndex.preferredMoveUci, originalMoveUci: revision.source.originalMoveUci, evidence: revision.evidence }));
    return { assessments, index: deriveAnswerIndex({ contextId: frame.contextId, frameId: frame.id, legalMovesUci: revision.rootAnswerIndex.legalMovesUci, preferredMoveUci: revision.rootAnswerIndex.preferredMoveUci, assessments, coverageGroups: [] }) };
}
describe('v4 supported answer index replaces accepted-frontier authority', () => {
    it('retains supported quality even if exact tier is unsettled', () => {
        const revision = practiceV4Fixture(); const { index, assessments } = project(revision);
        const alternative = lookupAnswer(index, 'd2d4', assessments, []);
        expect(alternative.quality).toBe('GOOD'); expect(alternative.assessment?.tier).toBeNull();
        expect(index.readiness).toBe('PARTIAL');
    });
    it('does not expand a boundary to absorb an uncertain cluster', () => {
        const revision = practiceV4Fixture();
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines[1]) observation.lines[1].score = { kind: 'CP', cp: -60, pov: 'WHITE' };
        const { index, assessments } = project(revision);
        expect(lookupAnswer(index, 'e2e4', assessments, []).quality).toBe('GOOD');
        expect(lookupAnswer(index, 'd2d4', assessments, []).kind).toBe('PENDING');
        expect(lookupAnswer(index, 'a2a3', assessments, []).quality).toBe('BELOW_STANDARD');
    });
    it('reordering comparable accepted alternatives cannot change membership', () => {
        const revision = practiceV4Fixture(); const baseline = project(revision);
        for (const observation of Object.values(revision.evidence.observations)) if (observation.lines.length === 3) observation.lines = [observation.lines[1], observation.lines[0], observation.lines[2]];
        const reordered = project(revision);
        for (const move of revision.rootAnswerIndex.legalMovesUci) expect(lookupAnswer(reordered.index, move, reordered.assessments, []).quality).toBe(lookupAnswer(baseline.index, move, baseline.assessments, []).quality);
    });
    it('rejects duplicated root moves instead of counting them as coverage', () => {
        const revision = practiceV4Fixture();
        revision.evidence.observations['observation-2'].lines[1] = structuredClone(revision.evidence.observations['observation-2'].lines[0]);
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('missing top-K answers never receive a negative conclusion', () => {
        const revision = practiceV4Fixture(); const { index, assessments } = project(revision);
        expect(index.legalMovesUci).toHaveLength(20);
        expect(index.assessmentIds).toHaveLength(3);
        for (const move of index.unresolvedMovesUci) expect(lookupAnswer(index, move, assessments, []).quality).toBe('UNKNOWN');
    });
    it('a marginal membership reversal leaves other supported alternatives intact', () => {
        const revision = practiceV4Fixture();
        revision.evidence.observations['observation-2'].lines[1].score = { kind: 'CP', cp: -160, pov: 'WHITE' };
        const { index, assessments } = project(revision);
        expect(lookupAnswer(index, 'e2e4', assessments, []).quality).toBe('GOOD');
        expect(lookupAnswer(index, 'd2d4', assessments, []).quality).toBe('UNKNOWN');
        expect(lookupAnswer(index, 'a2a3', assessments, []).quality).toBe('BELOW_STANDARD');
    });
});
