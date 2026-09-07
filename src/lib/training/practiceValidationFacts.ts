import { Chess } from 'chess.js';
import { legalMovesUci, practiceContextId, type Side } from './practiceContract';

export type PracticeValidationFacts = {
    legalMovesUci(fen: string): readonly string[];
    legalPv(fen: string, movesUci: readonly string[]): boolean;
    contextId(fen: string, positionHistory: readonly string[], side: Side): string;
    stats(): { entries: number; retainedChars: number };
};

/**
 * Cache only deterministic chess facts, never evidence validity or conclusions.
 * Own one instance per parse invocation or local analysis session. Content keys
 * include every input; caller-provided observation IDs have no role here.
 */
export function createPracticeValidationFacts(options: {
    maxEntries?: number;
    maxChars?: number;
} = {}): PracticeValidationFacts {
    const maxEntries = options.maxEntries ?? 4096;
    const maxChars = options.maxChars ?? 1_000_000;
    if (![maxEntries, maxChars].every(value => Number.isSafeInteger(value) && value >= 0)
        || maxEntries > 4096 || maxChars > 1_000_000) {
        throw new Error('Invalid practice validation cache capacity');
    }
    const entries = new Map<string, { value: unknown; chars: number }>();
    let retainedChars = 0;
    const fact = <T>(key: string, calculate: () => T): T => {
        const existing = entries.get(key);
        if (existing) {
            entries.delete(key); entries.set(key, existing);
            return existing.value as T;
        }
        const value = calculate();
        // The character budget bounds retained string content, not a claim
        // about engine-dependent Map/object overhead (bounded by entry count).
        const chars = key.length + JSON.stringify(value).length;
        if (maxEntries === 0 || chars > maxChars) return value;
        while (entries.size >= maxEntries || retainedChars + chars > maxChars) {
            const oldest = entries.keys().next().value!;
            retainedChars -= entries.get(oldest)!.chars;
            entries.delete(oldest);
        }
        entries.set(key, { value, chars }); retainedChars += chars;
        return value;
    };
    return {
        legalMovesUci(fen) {
            return fact(JSON.stringify(['legal-moves', fen]), () => Object.freeze(legalMovesUci(fen)));
        },
        legalPv(fen, movesUci) {
            return fact(JSON.stringify(['legal-pv', fen, movesUci]), () => {
                try {
                    const board = new Chess(fen);
                    for (const uci of movesUci) board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
                    return true;
                } catch { return false; }
            });
        },
        contextId(fen, positionHistory, side) {
            return fact(JSON.stringify(['context', fen, positionHistory, side]), () => practiceContextId(fen, positionHistory, side));
        },
        stats: () => ({ entries: entries.size, retainedChars }),
    };
}
