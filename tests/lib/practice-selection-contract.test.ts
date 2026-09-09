import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { practiceV4Fixture, rebuildPracticeFixture } from '../helpers/practice-v4';
import { canonicalPracticeSemantics, legalMovesUci, validatePracticeMomentRevision } from '@/lib/training/practiceContract';
import { deriveT2Selection, deriveT2ExactSelection, originalSelectionContext } from '@/lib/training/selectionPolicy';
import { WARMUP_MANIFEST } from '@/lib/onboarding/warmupPuzzle';

function childFixture() {
    const revision = practiceV4Fixture();
    // The parent has no point for the played move. Keep child search physically separate.
    for (const observation of Object.values(revision.evidence.observations)) {
        for (const line of observation.lines) if (line.moveUci === 'a2a3') {
            line.moveUci = 'g1f3'; line.pvUci = ['g1f3']; line.score = { kind: 'CP', cp: 10, pov: 'WHITE' };
        }
    }
    rebuildPracticeFixture(revision);
    const child = originalSelectionContext(revision.source);
    const legal = legalMovesUci(child.fen);
    const search = structuredClone(revision.evidence.searches.search);
    search.id = 'child'; search.contextId = child.contextId; search.sequence = 3;
    search.request = { ...search.request, fen: child.fen, positionHistory: child.positionHistory, rootScopeUci: legal, multiPv: 1 };
    search.observationIds = ['child-point']; revision.evidence.searches.child = search;
    revision.evidence.observations['child-point'] = {
        ...structuredClone(revision.evidence.observations['observation-2']), id: 'child-point', searchId: 'child',
        contextId: child.contextId, rootScopeUci: legal, requestedMultiPv: 1, completedSlots: 1,
        lines: [{ moveUci: 'b8c6', pvUci: ['b8c6'], bound: 'UNBOUNDED', score: { kind: 'CP', cp: 200, pov: 'BLACK' }, wdl: null }],
    };
    revision.selection = deriveT2Selection(revision, { referenceSearchId: 'search', originalSearchId: 'child',
        preferredMoveUci: 'e2e4', comparisonBasis: 'PARENT_CHILD_SCAN' });
    return revision;
}

describe('independent Practice selection contract', () => {
    it('reuses child evidence with inverted POV without inventing parent answer support', () => {
        const revision = childFixture();
        expect(revision.selection.status).toBe('INCLUDED');
        expect(revision.selection.comparison?.originalScore).toEqual({ kind: 'CP', cp: -200, pov: 'WHITE' });
        expect(revision.assessments.find(a => a.moveUci === 'a2a3')?.quality).toBe('UNKNOWN');
        expect(revision.decision.status).toBe('UNRESOLVED');
        expect(revision.continuation.nodes).toHaveLength(0);
        expect(validatePracticeMomentRevision(revision)).toMatchObject({ success: true });
    });
    it('rejects a forged display score or selection conclusion', () => {
        const score = childFixture(); score.selection.comparison!.originalScore = { kind: 'CP', cp: -999, pov: 'WHITE' };
        expect(validatePracticeMomentRevision(score).success).toBe(false);
        const omitted = childFixture(); omitted.selection.status = 'OMITTED';
        expect(validatePracticeMomentRevision(omitted).success).toBe(false);
    });
    it('rejects child evidence with a different legal history', () => {
        const revision = childFixture(); revision.evidence.searches.child.request.positionHistory = [];
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('rejects an incompatible comparison engine and incomplete final evidence', () => {
        const revision = childFixture(); revision.evidence.observations['child-point'].engineFingerprint = 'another';
        expect(() => deriveT2Selection(revision, { referenceSearchId: 'search', originalSearchId: 'child', preferredMoveUci: 'e2e4', comparisonBasis: 'PARENT_CHILD_SCAN' })).toThrow(/engines/);
        const incomplete = childFixture(); incomplete.evidence.searches.child.completion = 'STOPPED';
        expect(validatePracticeMomentRevision(incomplete).success).toBe(false);
    });
    it('includes selection values in semantics but excludes arbitrary observation allocation IDs', () => {
        const revision = childFixture(); const before = canonicalPracticeSemantics(revision);
        revision.selection.comparison!.originalObservationId = 'other-physical-id';
        expect(canonicalPracticeSemantics(revision)).toEqual(before);
        revision.selection.comparison!.originalScore = { kind: 'CP', cp: -201, pov: 'WHITE' };
        expect(canonicalPracticeSemantics(revision)).not.toEqual(before);
    });
    it('binds exact comparison IDs to the assessed outcome and distance', () => {
        const revision = structuredClone(WARMUP_MANIFEST);
        revision.selection = deriveT2ExactSelection(revision);
        expect(revision.selection.comparison?.originalScore).toMatchObject({ kind: 'EXACT', outcome: 'DRAW' });
        expect(validatePracticeMomentRevision(revision).success).toBe(true);
        revision.selection.comparison!.originalExactId = 'unrelated-rule';
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('derives the child from the actual played move, including its turn and clocks', () => {
        const revision = practiceV4Fixture(); const child = originalSelectionContext(revision.source);
        const board = new Chess(revision.source.fen); board.move('a3');
        expect(child.fen).toBe(board.fen()); expect(child.positionHistory).toEqual([revision.source.fen]);
    });
});
