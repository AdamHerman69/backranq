import { Chess } from 'chess.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPracticeValidationFacts } from '@/lib/training/practiceValidationFacts';
import { legalMovesUci, practiceContextId } from '@/lib/training/practiceContract';

afterEach(() => vi.restoreAllMocks());

describe('bounded pure practice validation facts', () => {
    it('reuses a legal PV but replays changed tails and different starting positions', () => {
        const facts = createPracticeValidationFacts(); const fen = new Chess().fen();
        const move = vi.spyOn(Chess.prototype, 'move');
        const pv = ['e2e4', 'e7e5'];
        expect(facts.legalPv(fen, pv)).toBe(true);
        const calls = move.mock.calls.length;
        expect(facts.legalPv(fen, [...pv])).toBe(true);
        expect(move).toHaveBeenCalledTimes(calls);
        pv[1] = 'e2e3';
        expect(facts.legalPv(fen, pv)).toBe(false);
        pv[1] = 'e7e5';
        expect(facts.legalPv(fen, pv)).toBe(true);
        const after = new Chess(); after.move('e4');
        expect(facts.legalPv(after.fen(), pv)).toBe(false);
    });

    it('does not conflate history, side, FEN counters, or mutable input arrays', () => {
        const facts = createPracticeValidationFacts(); const fen = new Chess().fen();
        const history: string[] = [];
        const initial = facts.contextId(fen, history, 'WHITE');
        expect(initial).toBe(practiceContextId(fen, [], 'WHITE'));
        history.push(fen);
        expect(facts.contextId(fen, history, 'WHITE')).not.toBe(initial);
        expect(facts.contextId(fen, [], 'BLACK')).not.toBe(initial);
        expect(facts.contextId(fen.replace('0 1', '1 1'), [], 'WHITE')).not.toBe(initial);
        expect(facts.contextId(fen, [], 'WHITE')).toBe(initial);
    });

    it('returns immutable legal move facts that callers cannot poison', () => {
        const facts = createPracticeValidationFacts(); const fen = new Chess().fen();
        const moves = facts.legalMovesUci(fen);
        expect(moves).toEqual(legalMovesUci(fen));
        expect(Object.isFrozen(moves)).toBe(true);
        expect(() => (moves as string[]).push('e1e8')).toThrow();
        expect(facts.legalMovesUci(fen)).toEqual(legalMovesUci(fen));
    });

    it('evicts by LRU and keeps both entry count and retained characters bounded', () => {
        const facts = createPracticeValidationFacts({ maxEntries: 2, maxChars: 1000 });
        const fen = new Chess().fen(); const move = vi.spyOn(Chess.prototype, 'move');
        facts.legalPv(fen, ['e2e4']); facts.legalPv(fen, ['d2d4']); facts.legalPv(fen, ['e2e4']);
        facts.legalPv(fen, ['g1f3']);
        const before = move.mock.calls.length;
        expect(facts.legalPv(fen, ['e2e4'])).toBe(true);
        expect(move).toHaveBeenCalledTimes(before);
        expect(facts.legalPv(fen, ['d2d4'])).toBe(true);
        expect(move.mock.calls.length).toBeGreaterThan(before);
        expect(facts.stats().entries).toBe(2);
        expect(facts.stats().retainedChars).toBeLessThanOrEqual(1000);
        const snapshot = facts.stats();
        expect(facts.legalPv(fen, Array(1000).fill('e2e4'))).toBe(false);
        expect(facts.stats()).toEqual(snapshot);
    });

    it('has uncached parity and rejects invalid or excessive cache limits', () => {
        const cached = createPracticeValidationFacts();
        const uncached = createPracticeValidationFacts({ maxEntries: 0 });
        const fen = new Chess().fen();
        for (const pv of [[], ['e2e4'], ['e2e4', 'e2e3'], ['e1e8']]) {
            expect(cached.legalPv(fen, pv)).toBe(uncached.legalPv(fen, pv));
        }
        expect(cached.legalMovesUci(fen)).toEqual(uncached.legalMovesUci(fen));
        expect(() => cached.legalMovesUci('bad-fen')).toThrow();
        expect(() => cached.contextId(fen, ['bad-fen'], 'WHITE')).toThrow();
        expect(uncached.stats()).toEqual({ entries: 0, retainedChars: 0 });
        for (const maxEntries of [-1, 0.5, Infinity, 4097]) expect(() => createPracticeValidationFacts({ maxEntries })).toThrow();
        expect(() => createPracticeValidationFacts({ maxChars: 1_000_001 })).toThrow();
    });
});
