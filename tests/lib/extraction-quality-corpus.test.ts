import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';

import corpus from '../fixtures/training-v2/real-games.corpus.v1.json';

describe('real-game extraction quality corpus', () => {
    it('contains only the approved balanced blitz/rapid sources', () => {
        expect(corpus.version).toBe(1);
        expect(corpus.filters).toMatchObject({
            variants: ['standard'],
            timeClasses: ['blitz', 'rapid'],
        });
        expect(corpus.sources).toEqual([
            { provider: 'chesscom', username: 'adam1a4' },
            { provider: 'lichess', username: 'aldicigg' },
        ]);

        const expectedUsers = new Map(
            corpus.sources.map((source) => [
                source.provider,
                source.username.toLowerCase(),
            ])
        );
        const counts = new Map<string, number>();
        const ids = new Set<string>();
        for (const game of corpus.games) {
            expect(['blitz', 'rapid']).toContain(game.timeClass);
            const variant = /^\[Variant\s+"([^"]+)"\]\s*$/im.exec(
                game.pgn
            )?.[1];
            expect(variant?.toLowerCase() ?? 'standard').toBe('standard');
            expect(ids.has(game.id)).toBe(false);
            ids.add(game.id);
            const expectedUser = expectedUsers.get(game.provider);
            expect(expectedUser).toBeTruthy();
            const white = game.white.name.toLowerCase();
            const black = game.black.name.toLowerCase();
            expect((white === expectedUser) !== (black === expectedUser)).toBe(
                true
            );
            const chess = new Chess();
            expect(() =>
                chess.loadPgn(game.pgn, { strict: false })
            ).not.toThrow();
            expect(chess.history().length).toBeGreaterThan(0);
            expect(chess.history().length).toBeLessThanOrEqual(
                corpus.filters.maxPlies
            );
            const key = `${game.provider}:${game.timeClass}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        expect(Object.fromEntries(counts)).toEqual({
            'chesscom:blitz': 4,
            'chesscom:rapid': 4,
            'lichess:blitz': 4,
            'lichess:rapid': 4,
        });
    });
});
