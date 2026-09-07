import { describe, expect, it } from 'vitest';
import { practicePositionFixture } from '../helpers/practice-position';
describe('canonical seeded Practice fixtures', () => {
    it('retains validated opponent evidence and a second playable decision', () => {
        const manifest = practicePositionFixture({ fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 2', originalMoveUci: 'f1c4', bestMoveUci: 'g1f3', continuation: { opponentMoveUci: 'b8c6', userMoveUci: 'f1b5' } });
        expect(manifest.continuation.nodes.filter(n => n.role === 'USER')).toHaveLength(2);
        expect(manifest.decision.selection).toBe('INCLUDED');
    });
    it('retains distinct promotion UCIs in the complete answer index', () => {
        const manifest = practicePositionFixture({ fen: '7k/P7/8/8/8/8/8/7K w - - 0 1', originalMoveUci: 'a7a8q', bestMoveUci: 'a7a8n' });
        expect(manifest.rootAnswerIndex.legalMovesUci).toEqual(expect.arrayContaining(['a7a8q', 'a7a8n']));
    });
});
