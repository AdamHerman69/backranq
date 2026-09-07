import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { assessPracticeExactPosition, collectPracticeExactEvidence } from '@/lib/analysis/practiceExactEvidence';
import { type TablebaseEvidence, invertTablebaseWdl, type TablebaseCategory } from '@/lib/analysis/tablebase';
import { legalMovesUci, type Outcome } from '@/lib/training/practiceContract';

const fen = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1';
const context = { fen, positionHistory: [], trainingSide: 'WHITE' as const, originalMoveUci: 'f7e6' };
function suppliedTablebase(rootFen = fen): TablebaseEvidence {
    return { source: 'LICHESS_SYZYGY', fen: rootFen, pieceCount: 3, wdl: 'WIN', category: 'win',
        terminal: { checkmate: false, stalemate: false, insufficientMaterial: false }, fetchedAt: '2026-09-06T00:00:00.000Z',
        moves: legalMovesUci(rootFen).map(uci => {
            const board = new Chess(rootFen); board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
            const wdl: Outcome = board.isStalemate() ? 'DRAW' : 'WIN';
            return { uci, wdl, categoryAfterMove: invertTablebaseWdl(wdl).toLowerCase() as TablebaseCategory, dtz: board.isCheckmate() ? 0 : 2 };
        }) };
}
describe('exact Practice producer without engine or network work', () => {
    it('builds a confirmed partial rule-exact moment from immediate mate and original stalemate', () => {
        const root = assessPracticeExactPosition(context)!;
        expect(root.decision.status).toBe('CONFIRMED_MISTAKE'); expect(root.decision.selectionSignal).toBe('EXACT_OUTCOME_LOSS');
        expect(root.rootAnswerIndex.readiness).toBe('PARTIAL'); expect(root.rootAnswerIndex.unresolvedMovesUci).toHaveLength(12);
        expect(root.assessments.filter(a => a.quality === 'GOOD')).toHaveLength(4);
        expect(Object.values(root.evidence.searches)).toEqual([]);
        expect(Object.values(root.evidence.exact).every(record => record.source === 'RULE')).toBe(true);
    });
    it('allows genuine complete compatible tablebase scope to classify all legal moves', () => {
        const root = assessPracticeExactPosition({ ...context, tablebase: suppliedTablebase() })!;
        expect(root.rootAnswerIndex.readiness).toBe('ALL_MOVES_CLASSIFIED');
        expect(Object.values(root.evidence.exact).some(record => record.source === 'TABLEBASE')).toBe(true);
        expect(root.decision.selection).toBe('INCLUDED');
    });
    it('does not turn an UNKNOWN provider move into DRAW or complete coverage', () => {
        const tablebase = suppliedTablebase(); tablebase.moves[0].wdl = 'UNKNOWN'; tablebase.moves[0].categoryAfterMove = 'unknown';
        const root = assessPracticeExactPosition({ ...context, tablebase })!;
        expect(root.rootAnswerIndex.readiness).toBe('PARTIAL');
        expect(root.diagnostics).toContain('TABLEBASE_INCOMPLETE_OR_INCONSISTENT_SCOPE');
    });
    it('rejects missing or duplicate legal scope entries', () => {
        for (const mutate of [(tb: TablebaseEvidence) => tb.moves.pop(), (tb: TablebaseEvidence) => { tb.moves[1] = tb.moves[0]; }]) {
            const tablebase = suppliedTablebase(); mutate(tablebase);
            const result = collectPracticeExactEvidence({ ...context, tablebase });
            expect(Object.values(result.evidence.exact).some(record => record.source === 'TABLEBASE')).toBe(false);
        }
    });
    it('does not accept a provider outcome contradicting a mandatory terminal result', () => {
        const tablebase = suppliedTablebase(); const original = tablebase.moves.find(move => move.uci === 'f7e6')!;
        original.wdl = 'WIN'; original.categoryAfterMove = 'loss';
        const result = collectPracticeExactEvidence({ ...context, tablebase });
        expect(result.diagnostics).toContain('TABLEBASE_CONTRADICTS_TERMINAL_RULE');
    });
    it('does not pretend a FEN-only tablebase knows a reversible repetition history', () => {
        const first = new Chess(fen); first.move('Qe7'); const nextFen = first.fen();
        const result = collectPracticeExactEvidence({ fen: nextFen, positionHistory: [fen], trainingSide: 'BLACK', tablebase: suppliedTablebase(nextFen) });
        expect(result.diagnostics).toContain('TABLEBASE_UNMODELLED_REPETITION_HISTORY');
    });
    it('separates claimable draws from mandatory ends and retains immediate mating rules', () => {
        const claimFen = fen.replace('0 1', '100 1');
        const result = collectPracticeExactEvidence({ ...context, fen: claimFen, tablebase: suppliedTablebase(claimFen) });
        expect(result.diagnostics).toContain('TABLEBASE_ROOT_DRAW_CLAIM');
        expect(Object.values(result.evidence.exact).flatMap(record => record.results).some(move => move.outcome === 'WIN')).toBe(true);
        const mandatory = collectPracticeExactEvidence({ ...context, fen: fen.replace('0 1', '150 1') });
        expect(mandatory.diagnostics).toEqual(['MANDATORY_ROOT_TERMINAL']);
        expect(Object.values(mandatory.evidence.exact)).toEqual([]);
    });
    it('requires a rule-compatible fifty-move bound for nonterminal tablebase wins', () => {
        const oldFen = fen.replace('0 1', '98 1');
        const result = collectPracticeExactEvidence({ ...context, fen: oldFen, tablebase: suppliedTablebase(oldFen) });
        expect(result.diagnostics).toContain('TABLEBASE_FIFTY_MOVE_BOUND_UNPROVEN');
        expect(Object.values(result.evidence.exact).every(record => record.source === 'RULE')).toBe(true);
    });
    it('cannot use a losing-only or terminal root as a fresh personal puzzle', () => {
        const board = new Chess(fen); board.move('Qf8#');
        expect(assessPracticeExactPosition({ ...context, fen: board.fen(), positionHistory: [fen], trainingSide: 'BLACK', originalMoveUci: 'h8h7' })).toBeNull();
    });
});
