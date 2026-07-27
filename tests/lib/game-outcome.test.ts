import { describe, expect, it } from 'vitest';

import {
    buildOpponentSearchWhere,
    buildUserGameFiltersWhere,
    buildUserResultWhere,
    getUserGameOutcome,
    normalizeChessUsername,
} from '@/lib/games/outcome';

describe('getUserGameOutcome', () => {
    it('reports a win and loss from the white player perspective', () => {
        expect(
            getUserGameOutcome({
                result: '1-0',
                whiteName: 'BackranqUser',
                blackName: 'Opponent',
                userName: 'backranquser',
            })
        ).toBe('W');
        expect(
            getUserGameOutcome({
                result: '0-1',
                whiteName: 'BackranqUser',
                blackName: 'Opponent',
                userName: 'backranquser',
            })
        ).toBe('L');
    });

    it('reverses decisive results when the user played black', () => {
        expect(
            getUserGameOutcome({
                result: '0-1',
                whiteName: 'Opponent',
                blackName: 'BackranqUser',
                userName: '@backranquser',
            })
        ).toBe('W');
        expect(
            getUserGameOutcome({
                result: '1-0',
                whiteName: 'Opponent',
                blackName: 'BackranqUser',
                userName: 'BackranqUser',
            })
        ).toBe('L');
    });

    it('reports draws only when the linked user is one of the players', () => {
        expect(
            getUserGameOutcome({
                result: '1/2-1/2',
                whiteName: 'Opponent',
                blackName: 'BackranqUser',
                userName: 'BackranqUser',
            })
        ).toBe('D');
        expect(
            getUserGameOutcome({
                result: '1/2-1/2',
                whiteName: 'Someone',
                blackName: 'Else',
                userName: 'BackranqUser',
            })
        ).toBe('?');
        expect(
            getUserGameOutcome({
                result: '1-0',
                whiteName: 'Someone',
                blackName: 'Else',
                userName: 'BackranqUser',
            })
        ).toBe('?');
    });
});

describe('normalizeChessUsername', () => {
    it('normalizes case, whitespace and a leading handle marker', () => {
        expect(normalizeChessUsername('  @BackranqUser  ')).toBe(
            'backranquser'
        );
    });
});

describe('buildUserResultWhere', () => {
    it('builds provider-aware win branches for both colors', () => {
        expect(
            buildUserResultWhere({
                result: 'wins',
                usernames: {
                    lichess: 'LichessMe',
                    chesscom: 'ChessComMe',
                },
            })
        ).toEqual({
            OR: [
                {
                    provider: 'LICHESS',
                    whiteName: { equals: 'LichessMe', mode: 'insensitive' },
                    result: '1-0',
                },
                {
                    provider: 'LICHESS',
                    blackName: { equals: 'LichessMe', mode: 'insensitive' },
                    result: '0-1',
                },
                {
                    provider: 'CHESSCOM',
                    whiteName: { equals: 'ChessComMe', mode: 'insensitive' },
                    result: '1-0',
                },
                {
                    provider: 'CHESSCOM',
                    blackName: { equals: 'ChessComMe', mode: 'insensitive' },
                    result: '0-1',
                },
            ],
        });
    });

    it('builds black-as-loss correctly and omits unlinked providers', () => {
        expect(
            buildUserResultWhere({
                result: 'losses',
                usernames: { lichess: '', chesscom: '@ChessComMe' },
            })
        ).toEqual({
            OR: [
                {
                    provider: 'CHESSCOM',
                    whiteName: { equals: 'ChessComMe', mode: 'insensitive' },
                    result: '0-1',
                },
                {
                    provider: 'CHESSCOM',
                    blackName: { equals: 'ChessComMe', mode: 'insensitive' },
                    result: '1-0',
                },
            ],
        });
    });

    it('builds provider and identity-aware draw branches', () => {
        expect(
            buildUserResultWhere({
                result: 'draws',
                usernames: { lichess: 'LichessMe', chesscom: '' },
            })
        ).toEqual({
            OR: [
                {
                    provider: 'LICHESS',
                    whiteName: { equals: 'LichessMe', mode: 'insensitive' },
                    result: '1/2-1/2',
                },
                {
                    provider: 'LICHESS',
                    blackName: { equals: 'LichessMe', mode: 'insensitive' },
                    result: '1/2-1/2',
                },
            ],
        });
    });

    it('fails closed for every result filter without linked usernames', () => {
        for (const result of ['wins', 'losses', 'draws'] as const) {
            expect(
                buildUserResultWhere({
                    result,
                    usernames: { lichess: '', chesscom: '' },
                })
            ).toEqual({ id: { in: [] } });
        }
    });
});

describe('buildOpponentSearchWhere', () => {
    it('searches only the opponent for each provider and user color', () => {
        expect(
            buildOpponentSearchWhere({
                query: 'Carlsen',
                usernames: {
                    lichess: 'LichessMe',
                    chesscom: 'ChessComMe',
                },
            })
        ).toEqual({
            OR: [
                {
                    provider: 'LICHESS',
                    whiteName: { equals: 'LichessMe', mode: 'insensitive' },
                    blackName: { contains: 'Carlsen', mode: 'insensitive' },
                },
                {
                    provider: 'LICHESS',
                    blackName: { equals: 'LichessMe', mode: 'insensitive' },
                    whiteName: { contains: 'Carlsen', mode: 'insensitive' },
                },
                {
                    provider: 'CHESSCOM',
                    whiteName: { equals: 'ChessComMe', mode: 'insensitive' },
                    blackName: { contains: 'Carlsen', mode: 'insensitive' },
                },
                {
                    provider: 'CHESSCOM',
                    blackName: { equals: 'ChessComMe', mode: 'insensitive' },
                    whiteName: { contains: 'Carlsen', mode: 'insensitive' },
                },
            ],
        });
    });

    it('omits unlinked providers and fails closed when no identity is known', () => {
        expect(
            buildOpponentSearchWhere({
                query: 'Nepo',
                usernames: { lichess: '', chesscom: '@ChessComMe' },
            })
        ).toEqual({
            OR: [
                {
                    provider: 'CHESSCOM',
                    whiteName: { equals: 'ChessComMe', mode: 'insensitive' },
                    blackName: { contains: 'Nepo', mode: 'insensitive' },
                },
                {
                    provider: 'CHESSCOM',
                    blackName: { equals: 'ChessComMe', mode: 'insensitive' },
                    whiteName: { contains: 'Nepo', mode: 'insensitive' },
                },
            ],
        });
        expect(
            buildOpponentSearchWhere({
                query: 'Nepo',
                usernames: { lichess: '', chesscom: '' },
            })
        ).toEqual({ id: { in: [] } });
    });
});

describe('buildUserGameFiltersWhere', () => {
    it('combines result and opponent filters with AND', () => {
        const usernames = { lichess: 'LichessMe', chesscom: '' };
        expect(
            buildUserGameFiltersWhere({
                result: 'wins',
                opponentQuery: 'Carlsen',
                usernames,
            })
        ).toEqual({
            AND: [
                buildUserResultWhere({ result: 'wins', usernames }),
                buildOpponentSearchWhere({
                    query: 'Carlsen',
                    usernames,
                }),
            ],
        });
    });

    it('does not add an empty perspective filter', () => {
        expect(
            buildUserGameFiltersWhere({
                result: null,
                opponentQuery: '   ',
                usernames: { lichess: '', chesscom: '' },
            })
        ).toEqual({});
    });
});
