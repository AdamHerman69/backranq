import { expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { parsePracticeMomentRevision } from '@/lib/training/practiceContract';
import { practicePositionFixture } from '../helpers/practice-position';

function fixture() {
    return practicePositionFixture({ fen: new Chess().fen(), originalMoveUci: 'a2a3', bestMoveUci: 'e2e4' });
}

it('rechecks altered chess evidence on a later parse with the same revision and search IDs', () => {
    const revision = fixture();
    expect(parsePracticeMomentRevision(revision)).toEqual(revision);
    const search = Object.values(revision.evidence.searches)[0];
    search.request.rootScopeUci = ['g1g3'];
    expect(() => parsePracticeMomentRevision(revision)).toThrow(/Invalid search root scope/);
});

it('does not reuse a context ID for different position/history input within one parse', () => {
    const revision = fixture();
    const board = new Chess(); board.move('e4');
    revision.continuation.nodes.push({ id: 'aliased-context', contextId: revision.source.contextId,
        fen: board.fen(), positionHistory: [revision.source.fen], trainingSide: 'WHITE', role: 'TERMINAL', answerIndex: null });
    expect(() => parsePracticeMomentRevision(revision)).toThrow(/Context ID does not include/);
});

it('keeps checking each declared assessment move even when its position is already checked', () => {
    const revision = fixture();
    revision.assessments.at(-1)!.moveUci = 'g1g3';
    expect(() => parsePracticeMomentRevision(revision)).toThrow(/illegal move/);
});
