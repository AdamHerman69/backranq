import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { practiceV4Fixture } from '../helpers/practice-v4';
import { WARMUP_MANIFEST } from '@/lib/onboarding/warmupPuzzle';
import { parsePracticeMomentRevision, practiceContextId, validatePracticeMomentRevision } from '@/lib/training/practiceContract';
import { lookupAnswer } from '@/lib/training/answerIndex';

/** V4 has no second root verifier: continuations are validated canonical data. */
describe('canonical continuation readiness', () => {
    it('keeps a confirmed single decision usable without optional explanation searches', () => {
        const revision = practiceV4Fixture();
        expect(revision.continuation).toEqual({ mode: 'SINGLE_DECISION', explanationLines: [], nodes: [], edges: [] });
        expect(parsePracticeMomentRevision(revision).decision.selection).toBe('INCLUDED');
        expect(lookupAnswer(revision.rootAnswerIndex, 'e2e4', revision.assessments, []).quality).toBe('GOOD');
    });
    it('treats a legal explanation as review, not an automatically verified combination', () => {
        const revision = practiceV4Fixture();
        revision.continuation.explanationLines = [{ startContextId: revision.source.contextId, movesUci: ['e2e4', 'e7e5', 'g1f3'], stopReason: 'BOUNDED_ENGINE_EXPLANATION' }];
        expect(parsePracticeMomentRevision(revision).continuation.mode).toBe('SINGLE_DECISION');
        expect(revision.continuation.nodes).toEqual([]);
    });
    it('requires explanation moves to be legal from their own start context', () => {
        const revision = practiceV4Fixture();
        revision.continuation.explanationLines = [{ startContextId: revision.source.contextId, movesUci: ['e2e4', 'e7e4'], stopReason: 'INVALID' }];
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('permits an explicitly prepared root-to-mate verified branch without engine work', () => {
        const revision = structuredClone(WARMUP_MANIFEST);
        const root = revision.continuation.nodes[0];
        const board = new Chess(root.fen); board.move('Qf8#');
        const positionHistory = [root.fen];
        const contextId = practiceContextId(board.fen(), positionHistory, 'WHITE');
        revision.continuation.mode = 'VERIFIED_BRANCHES';
        revision.continuation.nodes.push({ id: 'mate', contextId, fen: board.fen(), positionHistory, trainingSide: 'WHITE', role: 'TERMINAL', answerIndex: null });
        revision.continuation.edges.push({ from: root.id, to: 'mate', moveUci: 'f7f8' });
        expect(parsePracticeMomentRevision(revision).continuation.mode).toBe('VERIFIED_BRANCHES');
        expect(Object.values(revision.evidence.searches)).toEqual([]);
    });
    it('cannot force a different good answer onto the preferred answer branch', () => {
        const revision = structuredClone(WARMUP_MANIFEST);
        const root = revision.continuation.nodes[0]; const board = new Chess(root.fen); board.move('Qf8#');
        const contextId = practiceContextId(board.fen(), [root.fen], 'WHITE');
        revision.continuation.mode = 'VERIFIED_BRANCHES';
        revision.continuation.nodes.push({ id: 'mate', contextId, fen: board.fen(), positionHistory: [root.fen], trainingSide: 'WHITE', role: 'TERMINAL', answerIndex: null });
        revision.continuation.edges.push({ from: root.id, to: 'mate', moveUci: 'f7e8' });
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('does not make a later USER node playable without its own reference and index', () => {
        const revision = practiceV4Fixture();
        const board = new Chess(revision.source.fen); board.move('e4'); board.move('e5');
        const first = new Chess(revision.source.fen); first.move('e4');
        const positionHistory = [revision.source.fen, first.fen()];
        revision.continuation.mode = 'VERIFIED_BRANCHES';
        revision.continuation.nodes = [{ id: 'unprepared', contextId: practiceContextId(board.fen(), positionHistory, 'WHITE'), fen: board.fen(), positionHistory, trainingSide: 'WHITE', role: 'USER', answerIndex: null }];
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('requires actual supporting observations for an opponent transition', () => {
        const revision = practiceV4Fixture(); const board = new Chess(revision.source.fen); board.move('e4');
        const opponentFen = board.fen(); const history = [revision.source.fen];
        board.move('e5'); const targetHistory = [...history, opponentFen];
        revision.continuation.mode = 'VERIFIED_BRANCHES';
        revision.continuation.nodes = [
            { id: 'opponent', contextId: practiceContextId(opponentFen, history, 'WHITE'), fen: opponentFen, positionHistory: history, trainingSide: 'WHITE', role: 'OPPONENT', answerIndex: null },
            { id: 'review', contextId: practiceContextId(board.fen(), targetHistory, 'WHITE'), fen: board.fen(), positionHistory: targetHistory, trainingSide: 'WHITE', role: 'TERMINAL', answerIndex: null },
        ];
        revision.continuation.edges = [{ from: 'opponent', to: 'review', moveUci: 'e7e5' }];
        expect(validatePracticeMomentRevision(revision).success).toBe(false);
    });
    it('keeps unknown legal alternatives unknown even when some answers force mate', () => {
        const revision = WARMUP_MANIFEST;
        expect(revision.rootAnswerIndex.unresolvedMovesUci.length).toBeGreaterThan(0);
        for (const move of revision.rootAnswerIndex.unresolvedMovesUci) expect(lookupAnswer(revision.rootAnswerIndex, move, revision.assessments, []).kind).toBe('PENDING');
    });
});
