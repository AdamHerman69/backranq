import { describe, expect, it } from 'vitest';
import {
    buildOpponentSearchWhere,
    buildUserGameFiltersWhere,
    buildUserResultWhere,
    getUserGameOutcome,
    normalizeChessUsername,
} from '@/lib/games/outcome';

describe('immutable game perspective', () => {
    it('normalizes provider usernames only for import identity comparison', () => {
        expect(normalizeChessUsername('  @Ada Lovelace  ')).toBe('ada lovelace');
    });

    it.each([
        ['WHITE', '1-0', 'W'],
        ['WHITE', '0-1', 'L'],
        ['BLACK', '0-1', 'W'],
        ['BLACK', '1-0', 'L'],
        ['WHITE', '1/2-1/2', 'D'],
        ['BLACK', '1/2-1/2', 'D'],
        ['UNKNOWN', '1-0', '?'],
    ] as const)('derives %s %s as %s', (userSide, result, expected) => {
        expect(getUserGameOutcome({ userSide, result })).toBe(expected);
    });

    it('builds result filters exclusively from frozen userSide', () => {
        expect(buildUserResultWhere({ result: 'wins' })).toEqual({
            OR: [
                { userSide: 'WHITE', result: '1-0' },
                { userSide: 'BLACK', result: '0-1' },
            ],
        });
        expect(buildUserResultWhere({ result: 'losses' })).toEqual({
            OR: [
                { userSide: 'WHITE', result: '0-1' },
                { userSide: 'BLACK', result: '1-0' },
            ],
        });
        expect(buildUserResultWhere({ result: 'draws' })).toEqual({
            userSide: { in: ['WHITE', 'BLACK'] },
            result: '1/2-1/2',
        });
    });

    it('searches only the opponent selected by frozen side', () => {
        expect(buildOpponentSearchWhere({ query: 'Magnus' })).toEqual({
            OR: [
                {
                    userSide: 'WHITE',
                    blackName: { contains: 'Magnus', mode: 'insensitive' },
                },
                {
                    userSide: 'BLACK',
                    whiteName: { contains: 'Magnus', mode: 'insensitive' },
                },
            ],
        });
    });

    it('composes source-independent result and opponent filters', () => {
        expect(
            buildUserGameFiltersWhere({
                result: 'wins',
                opponentQuery: 'Magnus',
            })
        ).toEqual({
            AND: [
                buildUserResultWhere({ result: 'wins' }),
                buildOpponentSearchWhere({ query: 'Magnus' }),
            ],
        });
    });
});
