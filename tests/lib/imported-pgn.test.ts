import { describe, expect, it } from 'vitest';

import {
    parseImportedPgnCollection,
    PgnImportError,
    resolveImportedGameSide,
} from '@/lib/games/importedPgn';

const IMPORTED_AT = new Date('2026-08-07T03:00:00.000Z');
const FIRST = `[Event "Rated rapid game"]
[Site "Backranq"]
[Date "2026.08.03"]
[White "Ada"]
[Black "Grace"]
[WhiteElo "1601"]
[BlackElo "1590"]
[Result "1-0"]
[TimeControl "600+5"]

1. e4 e5 2. Nf3 Nc6 1-0`;

const SECOND = `[Event "Casual game"]
[UTCDate "2026.08.04"]
[UTCTime "12:34:56"]
[White "Grace"]
[Black "Ada"]
[Result "*"]

1. d4 d5 *`;

describe('manual PGN import parsing', () => {
    it('parses multiple games and preserves their source PGN', () => {
        const games = parseImportedPgnCollection(`${FIRST}\n\n${SECOND}`, {
            importedAt: IMPORTED_AT,
        });

        expect(games).toHaveLength(2);
        expect(games[0]).toMatchObject({
            whiteName: 'Ada',
            blackName: 'Grace',
            whiteRating: 1601,
            blackRating: 1590,
            playedAt: '2026-08-03T00:00:00.000Z',
            result: '1-0',
            rated: true,
            timeControl: {
                raw: '600+5',
                initialSeconds: 600,
                incrementSeconds: 5,
            },
        });
        expect(games[0]?.pgn).toBe(FIRST);
        expect(games[0]?.identityPgn).toContain('1. e4 e5 2. Nf3 Nc6 1-0');
        expect(games[1]).toMatchObject({
            playedAt: '2026-08-04T12:34:56.000Z',
            rated: false,
        });
        expect(games[1]?.result).toBeUndefined();
    });

    it('uses the route-supplied first-import instant for missing dates', () => {
        const withoutDate = `[Event "Manual"]\n[White "Ada"]\n[Black "Grace"]\n\n1. e4 e5 *`;
        expect(
            parseImportedPgnCollection(withoutDate, {
                importedAt: IMPORTED_AT,
            })[0]?.playedAt
        ).toBe(IMPORTED_AT.toISOString());
    });

    it('returns typed indexed validation errors', () => {
        try {
            parseImportedPgnCollection(
                `${FIRST}\n\n[Event "Bad"]\n[White "A"]\n[Black "B"]\n\n1. e5 *`,
                { importedAt: IMPORTED_AT }
            );
            throw new Error('Expected invalid PGN');
        } catch (error) {
            expect(error).toBeInstanceOf(PgnImportError);
            expect(error).toMatchObject({
                code: 'INVALID_PGN',
                gameIndex: 2,
            });
        }
    });

    it('resolves the player side case-insensitively and rejects ambiguity', () => {
        const game = parseImportedPgnCollection(FIRST, {
            importedAt: IMPORTED_AT,
        })[0]!;
        expect(resolveImportedGameSide({ game, playerName: 'ada' })).toBe(
            'white'
        );
        expect(() =>
            resolveImportedGameSide({ game, playerName: 'missing' })
        ).toThrow('does not identify exactly one side');
    });
});
