import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { loadAdditionalAuditSources } from '../../scripts/lib/practice-audit-sources';
import { hashSourcePgn } from '@/lib/chess/pgn';
import { practiceContextId, type SourceDecision } from '@/lib/training/practiceContract';
import type { NormalizedGame } from '@/lib/types/game';

function game(pgn = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'): NormalizedGame {
    return { id: 'lichess:real-fixture', provider: 'lichess', playedAt: '2026-01-01T00:00:00Z', timeClass: 'rapid',
        white: { name: 'White' }, black: { name: 'Black' }, pgn };
}
function source(g: NormalizedGame, ply: number): SourceDecision {
    const chess = new Chess(); chess.loadPgn(g.pgn); const moves = chess.history({ verbose: true });
    const m = moves[ply]; const positionHistory = moves.slice(0, ply).map(m => m.before); const trainingSide = m.color === 'w' ? 'WHITE' : 'BLACK';
    return { gameId: g.id, sourcePgnHash: hashSourcePgn(g.pgn), decisionPly: ply, fen: m.before, positionHistory,
        trainingSide, originalMoveUci: m.lan, contextId: practiceContextId(m.before, positionHistory, trainingSide) };
}
const raw = (sources: unknown[]) => JSON.stringify({ version: 1, sources });

describe('truthful additional real audit sources', () => {
    it('reconstructs complete PGN context, appends in order and deduplicates the same emitted context without mutating input', () => {
        const g = game(); const existing = [source(g, 1)]; const next = source(g, 4);
        const combined = loadAdditionalAuditSources(raw([existing[0], next, next]), { games: [g] }, existing);
        expect(combined).toEqual([existing[0], next]); expect(existing).toHaveLength(1);
        combined[0].positionHistory.length = 0;
        expect(existing[0].positionHistory).toHaveLength(1);
    });
    it.each(['sourcePgnHash', 'fen', 'contextId', 'trainingSide', 'originalMoveUci', 'gameId'] as const)('rejects a mismatched %s', key => {
        const g = game(); const value = source(g, 4);
        Object.assign(value, { [key]: key === 'trainingSide' ? 'BLACK' : 'forged' });
        expect(() => loadAdditionalAuditSources(raw([value]), { games: [g] }, [])).toThrow();
    });
    it('rejects truncated history even with a recomputed internally consistent context ID', () => {
        const g = game(); const value = source(g, 4);
        value.positionHistory = value.positionHistory.slice(1);
        value.contextId = practiceContextId(value.fen, value.positionHistory, value.trainingSide);
        expect(() => loadAdditionalAuditSources(raw([value]), { games: [g] }, [])).toThrow('exact corpus PGN replay');
    });
    it('rejects context reuse conflicting with an existing supplied source', () => {
        const g = game(); const value = source(g, 4); const conflicting = { ...value, gameId: 'different-game' };
        expect(() => loadAdditionalAuditSources(raw([value]), { games: [g] }, [conflicting])).toThrow('Conflicting duplicate audit context');
    });
    it.each([{}, { version: 2, sources: [] }, { version: 1, sources: [], origin: 'EXTRACTOR_EMITTED' }, { version: 1, sources: [] }])('rejects malformed envelope %j', value => {
        expect(() => loadAdditionalAuditSources(JSON.stringify(value), { games: [game()] }, [])).toThrow();
    });
    it('rejects source aliases, impossible plies and an ambiguous corpus ID', () => {
        const g = game(); const value = source(g, 4);
        for (const altered of [{ ...value, sourceKind: 'EXTRACTOR_EMITTED' }, { ...value, decisionPly: -1 }, { ...value, decisionPly: 999 }, { ...value, decisionPly: 1.5 }]) {
            expect(() => loadAdditionalAuditSources(raw([altered]), { games: [g] }, [])).toThrow();
        }
        expect(() => loadAdditionalAuditSources(raw([value]), { games: [g, g] }, [])).toThrow('Ambiguous');
    });
    it('does not classify a claimable draw as mandatory terminal', () => {
        const g = game('[SetUp "1"]\n[FEN "7k/8/8/8/8/8/8/KR6 w - - 100 60"]\n\n60. Rb2 *');
        const value = source(g, 0);
        expect(loadAdditionalAuditSources(raw([value]), { games: [g] }, [])).toEqual([value]);
    });
    it('rejects a move recorded after the mandatory 75-move endpoint', () => {
        const g = game('[SetUp "1"]\n[FEN "7k/8/8/8/8/8/8/KR6 w - - 150 80"]\n\n80. Rb2 *');
        const value = source(g, 0);
        expect(() => loadAdditionalAuditSources(raw([value]), { games: [g] }, [])).toThrow('mandatory terminal');
    });
});
